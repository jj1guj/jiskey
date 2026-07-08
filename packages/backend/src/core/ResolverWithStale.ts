/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as dns from 'node:dns';
import type * as Redis from 'ioredis';

// staleキャッシュの上限エントリ数(LRU的に古いものから破棄)
const STALE_CACHE_MAX = 5000;
// staleキャッシュの有効期間(6時間)
const STALE_TTL = 6 * 60 * 60 * 1000;
// キープウォームの間隔(30秒)
const WARM_INTERVAL = 30 * 1000;
// 1周期あたりの最大再解決件数
// 全ホストのカバー周期をTTL下限(60秒)以内に収める
const WARM_BATCH_SIZE = 100;
// キープウォーム対象ホストの上限(LRU)
const WARM_HOST_MAX = 5000;
// Redis永続化の間隔(60秒)
const PERSIST_INTERVAL = 60 * 1000;
// Redisキー
const REDIS_KEY_WARM_HOSTS = 'deliver:dns-warm-hosts';
const REDIS_KEY_STALE_CACHE = 'deliver:dns-stale-cache';
// Redis TTL
const REDIS_WARM_TTL = 7 * 24 * 60 * 60; // 7日(秒)
const REDIS_STALE_TTL = 6 * 60 * 60; // 6時間(秒)
// 解決キューの同時実行数制限 — 2レーンに分離
// 前景(配送が待っている解決): 死んだDNSの遅い解決がここを塞がないよう分離
// 背景(キープウォーム・revalidate): 死んだDNSはここに隔離される
// 障害の機構: fedibird等の健全ホストのconnect/lookupが8秒死したのは、
// 単一セマフォ(16)を死んだDNSの解決が占拠したため。
const FOREGROUND_CONCURRENCY = 8;
const BACKGROUND_CONCURRENCY = 8;
// 連続失敗がこの回数に達したホストは背景レーンでも後回し(1周に1件まで)
const RESOLVE_FAIL_BACKOFF_THRESHOLD = 5;

type DnsRecord = { address: string; ttl: number };

type StaleCacheEntry = {
	records4: DnsRecord[];
	records6: DnsRecord[];
	resolvedAt: number;
};

type WarmEntry = {
	ttl: number;
	lastResolvedAt: number;
};

/**
 * 任意のリゾルバ(dns.promises.Resolver互換)をラップし、
 * リゾルバ構成に依存しない共通のstaleキャッシュを提供する。
 *
 * 重要: dns.promises.Resolver を継承している。cacheable-lookup 7.0.0 は
 * resolver が dns.promises.Resolver のインスタンスでない場合、
 * resolve4/resolve6 を promisify する(index.js L104-109)。
 * async関数をpromisifyするとコールバックが永遠に呼ばれず、
 * キャッシュミスした全ルックアップが永久に未解決となる。
 * 将来のリファクタで継承を外すと全ルックアップが無応答化する。
 *
 * staleフォールバック: 解決成功のたびにプロセスローカルのMapへ保存し、
 * 解決失敗時に6時間以内のstaleエントリがあればそれを返す。
 *
 * キープウォーム: 直近24時間に解決したホスト名を追跡し、30秒間隔のループで
 * TTL失効が近い/失効したホストを最大20件までバックグラウンド再解決する。
 * 配送先のDNSがローカルキャッシュで常に温かく保たれ、
 * 配送時のコールドキャッシュ解決が原理的に発生しなくなる。
 */
export class ResolverWithStale extends dns.promises.Resolver {
	private inner: dns.promises.Resolver;
	private staleCache = new Map<string, StaleCacheEntry>();
	private warmTargets = new Map<string, WarmEntry>();
	private redisClient: Redis.Redis | null;
	// 2レーンセマフォ
	private fgInFlight = 0;
	private fgQueue: (() => void)[] = [];
	private bgInFlight = 0;
	private bgQueue: (() => void)[] = [];
	// ホストごとの連続解決失敗カウント
	private consecutiveFailures = new Map<string, number>();

	constructor(inner: dns.promises.Resolver, redisClient?: Redis.Redis | null) {
		super();
		this.inner = inner;
		this.redisClient = redisClient ?? null;

		// 30秒間隔でTTL失効が近いホストをバックグラウンド再解決
		setInterval(() => this.warmLoop(), WARM_INTERVAL).unref();

		// 60秒間隔でRedisに永続化
		if (this.redisClient != null) {
			setInterval(() => this.persistToRedis(), PERSIST_INTERVAL).unref();
		}

		// 起動時プリウォーム(並走、ワーカー起動はブロックしない)
		this.prewarm();
	}

	resolve4: any = async (hostname: string, options?: { ttl?: boolean }): Promise<DnsRecord[] | string[]> => {
		return this.doResolve(hostname, 'A', options);
	};

	// IPv6の解決不能は、Aが健在なら配送を妨げるべきでない。
	// v6専用ホストはresolve4側も失敗するため、到達不能の検出はresolve4が担う。
	resolve6: any = async (hostname: string, options?: { ttl?: boolean }): Promise<DnsRecord[] | string[]> => {
		try {
			return await this.doResolve(hostname, 'AAAA', options);
		} catch {
			// fail-open: AAAAの全滅時は空配列を返し、Aのみで配送を続行させる
			console.debug(`aaaa resolution failed for ${hostname}, proceeding with A only`);
			return options?.ttl ? [] : [];
		}
	};

	private async doResolve(hostname: string, type: 'A' | 'AAAA', options?: { ttl?: boolean }): Promise<DnsRecord[] | string[]> {
		const queryName = type === 'A' ? 'queryA' : 'queryAaaa';

		// stale-while-revalidate: staleが存在すれば即座にstaleを返し、
		// 実解決はバックグラウンドで実行してキャッシュとstaleを更新する。
		// 既知ホストの配送がDNS解決を待つ時間は原理的にゼロになる。
		const staleEntry = this.staleCache.get(hostname);
		if (staleEntry != null && Date.now() - staleEntry.resolvedAt < STALE_TTL) {
			// staleが存在 → 即座に返し、バックグラウンドでrevalidate
			this.revalidateInBackground(hostname, type);
			const records = type === 'A' ? staleEntry.records4 : staleEntry.records6;
			if (options?.ttl) return records;
			return records.map(r => r.address);
		}

		// staleが存在しない完全な初見ホスト → 前景レーンで実解決を待つ
		try {
			await this.acquireSemaphore('fg');
			let records: DnsRecord[];
			try {
				records = await this.innerResolve(hostname, type);
			} finally {
				this.releaseSemaphore('fg');
			}
			this.consecutiveFailures.delete(hostname);
			this.updateStaleCache(hostname, records, type);
			this.updateWarmTarget(hostname, records);
			if (options?.ttl) return records;
			return records.map(r => r.address);
		} catch (_err) {
			this.incrementConsecutiveFailures(hostname);
			const error = new Error(`${queryName} ETIMEOUT ${hostname} (resolver failed, no stale)`);
			(error as NodeJS.ErrnoException).code = 'ETIMEOUT';
			throw error;
		}
	}

	/**
	 * バックグラウンドでDNS再解決を実行し、キャッシュとstaleを更新する(fire-and-forget)。
	 * 背景レーンのセマフォを使用し、死んだDNSの遅い解決が前景を塞がない。
	 */
	private revalidateInBackground(hostname: string, type: 'A' | 'AAAA'): void {
		this.acquireSemaphore('bg').then(async () => {
			try {
				const records = await this.innerResolve(hostname, type);
				this.consecutiveFailures.delete(hostname);
				this.updateStaleCache(hostname, records, type);
				this.updateWarmTarget(hostname, records);
			} catch {
				this.incrementConsecutiveFailures(hostname);
			} finally {
				this.releaseSemaphore('bg');
			}
		}).catch(() => {
			// セマフォ取得失敗は無視
		});
	}

	private incrementConsecutiveFailures(hostname: string): void {
		const count = (this.consecutiveFailures.get(hostname) ?? 0) + 1;
		this.consecutiveFailures.set(hostname, count);
	}

	private async innerResolve(hostname: string, type: 'A' | 'AAAA'): Promise<DnsRecord[]> {
		try {
			const result = type === 'A'
				? await this.inner.resolve4(hostname, { ttl: true })
				: await this.inner.resolve6(hostname, { ttl: true });
			return (result as (DnsRecord | string)[]).map(r =>
				typeof r === 'string' ? { address: r, ttl: 300 } : r,
			);
		} catch (err) {
			// ENODATA / ENOTFOUND は「レコードなし」の正常応答。
			// 捏造ETIMEOUTに変換せず空配列として返す。
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENODATA' || code === 'ENOTFOUND') {
				return [];
			}
			throw err;
		}
	}

	private updateStaleCache(hostname: string, records: DnsRecord[], type: 'A' | 'AAAA'): void {
		let entry = this.staleCache.get(hostname);
		if (entry == null) {
			if (this.staleCache.size >= STALE_CACHE_MAX) {
				const oldest = this.staleCache.keys().next().value;
				if (oldest != null) this.staleCache.delete(oldest);
			}
			entry = { records4: [], records6: [], resolvedAt: Date.now() };
			this.staleCache.set(hostname, entry);
		}
		if (type === 'A') {
			entry.records4 = records;
		} else {
			entry.records6 = records;
		}
		entry.resolvedAt = Date.now();
		// Mapの末尾に移動してLRU順を維持
		this.staleCache.delete(hostname);
		this.staleCache.set(hostname, entry);
	}

	private updateWarmTarget(hostname: string, records: DnsRecord[]): void {
		const minTtl = records.length > 0
			? Math.min(...records.map(r => r.ttl))
			: 300;
		this.warmTargets.delete(hostname);
		if (this.warmTargets.size >= WARM_HOST_MAX) {
			const oldest = this.warmTargets.keys().next().value;
			if (oldest != null) this.warmTargets.delete(oldest);
		}
		this.warmTargets.set(hostname, { ttl: minTtl, lastResolvedAt: Date.now() });
	}

	/**
	 * TTL失効が近い/失効したホストを最大WARM_BATCH_SIZE件まで再解決する。
	 * 失敗は静かに無視(次周期で再試行)。
	 */
	private async warmLoop(): Promise<void> {
		const now = Date.now();
		let resolved = 0;
		let failedHostResolved = false; // 連続失敗ホストは1周に1件まで

		for (const [hostname, entry] of this.warmTargets) {
			if (resolved >= WARM_BATCH_SIZE) break;

			const elapsed = (now - entry.lastResolvedAt) / 1000;
			if (elapsed < entry.ttl - 30) continue;

			if (now - entry.lastResolvedAt > 24 * 60 * 60 * 1000) {
				this.warmTargets.delete(hostname);
				continue;
			}

			// 連続失敗ホストは背景レーンでも後回し(1周に1件まで)
			const failCount = this.consecutiveFailures.get(hostname) ?? 0;
			if (failCount >= RESOLVE_FAIL_BACKOFF_THRESHOLD) {
				if (failedHostResolved) continue;
				failedHostResolved = true;
			}

			try {
				await this.acquireSemaphore('bg');
				try {
					const records4 = await this.innerResolve(hostname, 'A');
					this.consecutiveFailures.delete(hostname);
					this.updateStaleCache(hostname, records4, 'A');
					this.updateWarmTarget(hostname, records4);
				} finally {
					this.releaseSemaphore('bg');
				}
				resolved++;
			} catch {
				this.incrementConsecutiveFailures(hostname);
			}
		}
	}

	// --- 2レーンセマフォ ---
	private acquireSemaphore(lane: 'fg' | 'bg'): Promise<void> {
		const max = lane === 'fg' ? FOREGROUND_CONCURRENCY : BACKGROUND_CONCURRENCY;
		const inFlight = lane === 'fg' ? this.fgInFlight : this.bgInFlight;
		const queue = lane === 'fg' ? this.fgQueue : this.bgQueue;
		if (inFlight < max) {
			if (lane === 'fg') this.fgInFlight++; else this.bgInFlight++;
			return Promise.resolve();
		}
		return new Promise<void>(resolve => {
			queue.push(resolve);
		});
	}

	private releaseSemaphore(lane: 'fg' | 'bg'): void {
		const queue = lane === 'fg' ? this.fgQueue : this.bgQueue;
		const next = queue.shift();
		if (next != null) {
			next();
		} else {
			if (lane === 'fg') this.fgInFlight--; else this.bgInFlight--;
		}
	}

	// --- Redis永続化 ---
	private async persistToRedis(): Promise<void> {
		if (this.redisClient == null) return;
		try {
			// ウォーム対象ホスト一覧
			const hosts = Array.from(this.warmTargets.keys());
			await this.redisClient.set(REDIS_KEY_WARM_HOSTS, JSON.stringify(hosts), 'EX', REDIS_WARM_TTL);

			// staleキャッシュ(必要最小限: hostname→records4/records6)
			const staleData: Record<string, { r4: { address: string; ttl: number }[]; r6: { address: string; ttl: number }[] }> = {};
			for (const [hostname, entry] of this.staleCache) {
				staleData[hostname] = { r4: entry.records4, r6: entry.records6 };
			}
			await this.redisClient.set(REDIS_KEY_STALE_CACHE, JSON.stringify(staleData), 'EX', REDIS_STALE_TTL);
		} catch {
			// Redis障害時は静かにスキップ
		}
	}

	// --- 起動時プリウォーム ---
	private async prewarm(): Promise<void> {
		if (this.redisClient == null) {
			console.log('dns prewarm: no redis client, skipping');
			return;
		}

		try {
			// staleキャッシュの復元
			const staleRaw = await this.redisClient.get(REDIS_KEY_STALE_CACHE);
			if (staleRaw != null) {
				try {
					const staleData = JSON.parse(staleRaw) as Record<string, { r4: DnsRecord[]; r6: DnsRecord[] }>;
					for (const [hostname, data] of Object.entries(staleData)) {
						this.staleCache.set(hostname, {
							records4: data.r4 ?? [],
							records6: data.r6 ?? [],
							resolvedAt: Date.now(), // 復元時点を起点とする
						});
					}
				} catch {
					// パース失敗は無視
				}
			}

			// ウォーム対象ホスト一覧の復元と事前解決
			const hostsRaw = await this.redisClient.get(REDIS_KEY_WARM_HOSTS);
			if (hostsRaw == null) {
				console.log('dns prewarm: no saved hosts, skipping');
				return;
			}

			let hosts: string[];
			try {
				hosts = JSON.parse(hostsRaw) as string[];
			} catch {
				console.log('dns prewarm: no saved hosts, skipping');
				return;
			}

			if (!Array.isArray(hosts) || hosts.length === 0) {
				console.log('dns prewarm: no saved hosts, skipping');
				return;
			}

			console.log(`dns prewarm: restored ${hosts.length} hosts from redis, resolving...`);
			const startTime = Date.now();
			let resolved = 0;
			let failed = 0;

			// セマフォ(背景レーン)を使って同時解決数を制限
			const tasks = hosts.map(hostname => (async () => {
				await this.acquireSemaphore('bg');
				try {
					const records = await this.innerResolve(hostname, 'A');
					this.updateStaleCache(hostname, records, 'A');
					this.updateWarmTarget(hostname, records);
					resolved++;
				} catch {
					failed++;
				} finally {
					this.releaseSemaphore('bg');
				}
			})());

			await Promise.all(tasks);
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			console.log(`dns prewarm: done (${resolved} resolved, ${failed} failed) in ${elapsed}s`);
		} catch {
			// Redis障害時は静かにスキップ(コールドスタートとして動作)
			console.log('dns prewarm: redis error, skipping');
		}
	}
}
