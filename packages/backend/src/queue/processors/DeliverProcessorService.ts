/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Bull from 'bullmq';
import { Not } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { InstancesRepository, MiMeta } from '@/models/_.js';
import type Logger from '@/logger.js';
import { ApRequestService } from '@/core/activitypub/ApRequestService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import { MemorySingleCache } from '@/misc/cache.js';
import type { MiInstance } from '@/models/Instance.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import ApRequestChart from '@/core/chart/charts/ap-request.js';
import FederationChart from '@/core/chart/charts/federation.js';
import { StatusError } from '@/misc/status-error.js';
import { UtilityService } from '@/core/UtilityService.js';
import { bindThis } from '@/decorators.js';
import { getSocketStats } from '@/core/HttpRequestService.js';
import type { DeliverQueue } from '@/core/QueueModule.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type { DeliverJobData } from '../types.js';

// federation testはミリ秒〜秒単位で配送到達を検証するため、
// テスト環境(MISSKEY_FAST_DELIVERY_RETRY=1)では時定数を大幅に短縮する。
// 本番既定値は一切変えない。
const FAST = process.env.MISSKEY_FAST_DELIVERY_RETRY === '1';

// 配送先ホスト単位のサーキットブレーカー設定
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_BASE_COOLDOWN = FAST ? 1000 : 1000 * 60; // 1s / 1min
const CIRCUIT_MAX_COOLDOWN = FAST ? 2000 : 1000 * 60 * 5; // 2s / 5min
const CIRCUIT_PROBE_INTERVAL = FAST ? 500 : 1000 * 30; // 500ms / 30sec
const CIRCUIT_ENTRY_TTL = 1000 * 60 * 60; // 1h
// moveToDelayed の起床ジッタ上限
const CIRCUIT_DELAYED_JITTER = FAST ? 500 : 60_000; // 500ms / 60s

// グローバルブレーキ
const DEGRADED_WINDOW = 60 * 1000;
const DEGRADED_ABS_THRESHOLD = 100;
const DEGRADED_RATE_SAMPLE_MIN = 60;
const DEGRADED_RATE_THRESHOLD = 0.5;
const DEGRADED_HOLD_TIME = 60 * 1000;
const DEGRADED_GRACE_PERIOD = FAST ? 0 : 120 * 1000; // 0 / 120sec
const DEGRADED_FORCE_RELEASE = 30 * 60 * 1000;
const DEGRADED_EL_DELAY_THRESHOLD = 500;
const DEGRADED_LOOKUP_WD_THRESHOLD = 5;
const EL_DELAY_CHECK_INTERVAL = 5 * 1000;

const DELIVER_JOB_MAX_AGE = 48 * 60 * 60 * 1000; // 48h

// アイドルドレイン
const IDLE_DRAIN_INTERVAL = FAST ? 1000 : 5 * 1000; // 1s / 5s
const IDLE_DRAIN_MAX_PROMOTE = 100;
const IDLE_DRAIN_ACTIVE_RATIO = 0.25;

// 回復時昇格のデバウンス
const PROMOTE_HOST_DEBOUNCE = FAST ? 2000 : 5 * 60 * 1000; // 2s / 5min
const PROMOTE_GLOBAL_DEBOUNCE = FAST ? 1000 : 60 * 1000; // 1s / 1min

type HostCircuitState = {
	consecutiveFailures: number;
	openUntil: number;
	lastFailureAt: number;
};

@Injectable()
export class DeliverProcessorService {
	private logger: Logger;
	private suspendedHostsCache: MemorySingleCache<MiInstance[]>;
	private latest: string | null;

	// 接続不能なホストへの配送を一時的にfast-failさせるためのホスト単位のサーキットブレーカー
	// (プロセスローカル。ワーカープロセスごとに独立して動作する)
	private hostCircuits = new Map<string, HostCircuitState>();

	// ホスト回復時のdelayedジョブ昇格のデバウンス用(ホスト名 → 最終昇格実行時刻)
	private promoteDebounce = new Map<string, number>();

	// プロセス全体の昇格スキャンのデバウンス(最大1回/分)
	private lastPromoteScanAt = 0;

	// グローバルブレーキ: 直近60秒のネットワーク失敗/成功のタイムスタンプ(計測・ログ用)
	private recentFailures: number[] = [];
	private recentSuccesses: number[] = [];
	private degradedSince: number | null = null;
	private degradedConditionClearedAt: number | null = null;
	private readonly processStartedAt = Date.now();

	// 「network failure rate elevated」ログのレート制限(毎分1回まで)
	private lastFailureRateLogAt = 0;
	private failureRateLogSuppressed = 0;

	// 自己健全性シグナル
	private elDelayExceededCount = 0; // EL遅延が閾値超過した連続計測回数
	private lookupWdFailures: number[] = []; // lookup watchdog 発火タイムスタンプ

	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.config)
		private config: Config,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		@Inject('queue:deliver')
		private deliverQueue: DeliverQueue,

		private utilityService: UtilityService,
		private federatedInstanceService: FederatedInstanceService,
		private fetchInstanceMetadataService: FetchInstanceMetadataService,
		private apRequestService: ApRequestService,
		private instanceChart: InstanceChart,
		private apRequestChart: ApRequestChart,
		private federationChart: FederationChart,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('deliver');
		this.logger.info(`delivery timing profile: ${FAST ? 'fast (MISSKEY_FAST_DELIVERY_RETRY)' : 'production'} baseCooldown=${CIRCUIT_BASE_COOLDOWN}ms jitter=${CIRCUIT_DELAYED_JITTER}ms idleDrain=${IDLE_DRAIN_INTERVAL}ms gracePeriod=${DEGRADED_GRACE_PERIOD}ms promoteHost=${PROMOTE_HOST_DEBOUNCE}ms promoteGlobal=${PROMOTE_GLOBAL_DEBOUNCE}ms`);
		this.suspendedHostsCache = new MemorySingleCache<MiInstance[]>(1000 * 60 * 60); // 1h

		// 古くなったサーキットブレーカーのエントリを定期的に掃除する
		setInterval(() => {
			const now = Date.now();
			for (const [host, state] of this.hostCircuits) {
				if (now - state.lastFailureAt > CIRCUIT_ENTRY_TTL) {
					this.hostCircuits.delete(host);
				}
			}
		}, 1000 * 60 * 10).unref();

		// イベントループ遅延の計測(自己健全性シグナル)
		setInterval(() => {
			const start = Date.now();
			setImmediate(() => {
				const delay = Date.now() - start;
				if (delay > DEGRADED_EL_DELAY_THRESHOLD) {
					this.elDelayExceededCount++;
				} else {
					this.elDelayExceededCount = 0;
				}
				this.updateDegradedState(Date.now());
			});
		}, EL_DELAY_CHECK_INTERVAL).unref();

		// アイドルドレイン: ワーカーが暇なときDelayedジョブを前倒しする
		setInterval(() => this.drainIdleDelayed(), IDLE_DRAIN_INTERVAL).unref();
	}

	@bindThis
	public async process(job: Bull.Job<DeliverJobData>, token?: string): Promise<string> {
		const { host } = new URL(job.data.to);

		if (!this.utilityService.isFederationAllowedUri(job.data.to)) {
			return 'skip (blocked)';
		}

		// isSuspendedなら中断
		let suspendedHosts = this.suspendedHostsCache.get();
		if (suspendedHosts == null) {
			suspendedHosts = await this.instancesRepository.find({
				where: {
					suspensionState: Not('none'),
				},
			});
			this.suspendedHostsCache.set(suspendedHosts);
		}
		if (suspendedHosts.map(x => x.host).includes(this.utilityService.toPuny(host))) {
			return 'skip (suspended)';
		}

		const i = await (this.meta.enableStatsForFederatedInstances
			? this.federatedInstanceService.fetchOrRegister(host)
			: this.federatedInstanceService.fetch(host));

		// suspend server by software
		if (i != null && this.utilityService.isDeliverSuspendedSoftware(i)) {
			return 'skip (software suspended)';
		}

		// サーキットブレーカー: 直近で接続不能と判明しているホストには実際のHTTPリクエストを行わず
		// 即座に失敗させてリトライ(バックオフ)に任せる。これにより落ちているサーバー宛のジョブが
		// タイムアウトまでワーカーの同時実行枠を占有し、他ホストへの配送が詰まるのを防ぐ。
		const punyHost = this.utilityService.toPuny(host);
		const circuit = this.hostCircuits.get(punyHost);
		if (circuit != null && circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
			const now = Date.now();
			if (now < circuit.openUntil) {
				// C-1: 作成から48時間を超えたジョブは配送不能として終了
				if (now - job.timestamp > DELIVER_JOB_MAX_AGE) {
					throw new Bull.UnrecoverableError('delivery expired (host unreachable for 48h)');
				}
				// attemptsを消費せずサーキット閉鎖予定時刻(+ジッタ)にdelayedとして再キュー
				// C-2: 同一ホスト宛の大量ジョブが一斉起床するのを防ぐため最大60秒のジッタ
				const wakeAt = circuit.openUntil + Math.round(Math.random() * CIRCUIT_DELAYED_JITTER);
				await job.moveToDelayed(wakeAt, token);
				throw new Bull.DelayedError();
			}
			// ハーフオープン: このジョブだけをプローブとして実配送を試み、
			// 結果が出るまでの間、同ホスト宛の他のジョブは引き続きfast-failさせる
			circuit.openUntil = now + CIRCUIT_PROBE_INTERVAL;
		}

		const deliverStartedAt = Date.now();
		try {
			await this.apRequestService.signedPost(job.data.user, job.data.to, job.data.content, job.data.digest);

			// ネットワーク成功を記録(グローバルブレーキ用)
			this.recordNetworkResult(true);

			// 配送に成功したのでサーキットをリセット
			// サーキットが存在していた場合は回復検知: そのホスト宛のdelayedジョブを即時実行に昇格
			if (this.hostCircuits.has(punyHost)) {
				this.hostCircuits.delete(punyHost);
				this.promoteDelayedJobsForHost(punyHost);
			}

			this.apRequestChart.deliverSucc();
			this.federationChart.deliverd(host, true);

			// Update instance stats
			process.nextTick(async () => {
				if (i == null) return;

				if (i.isNotResponding) {
					this.federatedInstanceService.update(i.id, {
						isNotResponding: false,
						notRespondingSince: null,
					});
				}

				if (this.meta.enableStatsForFederatedInstances) {
					this.fetchInstanceMetadataService.fetchInstanceMetadata(i);
				}

				if (this.meta.enableChartsForFederatedInstances) {
					this.instanceChart.requestSent(i.host, true);
				}
			});

			return 'Success';
		} catch (res) {
			this.apRequestChart.deliverFail();
			this.federationChart.deliverd(host, false);

			// Update instance stats
			this.federatedInstanceService.fetchOrRegister(host).then(i => {
				if (!i.isNotResponding) {
					this.federatedInstanceService.update(i.id, {
						isNotResponding: true,
						notRespondingSince: new Date(),
					});
				} else if (i.notRespondingSince) {
					// 1週間以上不通ならサスペンド
					if (i.suspensionState === 'none' && i.notRespondingSince.getTime() <= Date.now() - 1000 * 60 * 60 * 24 * 7) {
						this.federatedInstanceService.update(i.id, {
							suspensionState: 'autoSuspendedForNotResponding',
						});
					}
				} else {
					// isNotRespondingがtrueでnotRespondingSinceがnullの場合はnotRespondingSinceをセット
					// notRespondingSinceは新たな機能なので、それ以前のデータにはnotRespondingSinceがない場合がある
					this.federatedInstanceService.update(i.id, {
						notRespondingSince: new Date(),
					});
				}

				if (this.meta.enableChartsForFederatedInstances) {
					this.instanceChart.requestSent(i.host, false);
				}
			});

			if (res instanceof StatusError) {
				// HTTPステータスが返ってきている = サーバー自体は応答しているのでサーキットはリセット
				this.hostCircuits.delete(punyHost);

				// 4xx
				if (!res.isRetryable) {
					// 相手が閉鎖していることを明示しているため、配送停止する
					if (job.data.isSharedInbox && res.statusCode === 410) {
						this.federatedInstanceService.fetchOrRegister(host).then(i => {
							this.federatedInstanceService.update(i.id, {
								suspensionState: 'goneSuspended',
							});
						});
						throw new Bull.UnrecoverableError(`${host} is gone`);
					}
					throw new Bull.UnrecoverableError(`${res.statusCode} ${res.statusMessage}`);
				}

				// 5xx etc.
				throw new Error(`${res.statusCode} ${res.statusMessage}`);
			} else {
				// DNS error, socket error, timeout ...
				const elapsed = Date.now() - deliverStartedAt;
				const wasReused = getSocketStats().recentReuseHosts.has(host);
				this.logger.warn(`deliver network error to ${punyHost} after ${elapsed}ms (reusedSocket=${wasReused}): ${res}`);

				// ネットワーク失敗を記録(グローバルブレーキ用)
				this.recordNetworkResult(false);

				// 接続レベルの失敗を記録し、閾値を超えたらサーキットを開く
				const now = Date.now();
				const state = this.hostCircuits.get(punyHost) ?? {
					consecutiveFailures: 0,
					openUntil: 0,
					lastFailureAt: now,
				};
				state.consecutiveFailures++;
				state.lastFailureAt = now;
				if (state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
					// 失敗が続くほどクールダウンを指数的に延長する(上限あり)
					const cooldown = Math.min(
						CIRCUIT_BASE_COOLDOWN * Math.pow(2, state.consecutiveFailures - CIRCUIT_FAILURE_THRESHOLD),
						CIRCUIT_MAX_COOLDOWN,
					);
					state.openUntil = now + cooldown;
					this.logger.warn(`circuit opened for ${punyHost} (${state.consecutiveFailures} consecutive network failures, cooldown ${Math.round(cooldown / 1000)}s)`);
				}
				this.hostCircuits.set(punyHost, state);

				throw res;
			}
		}
	}

	/**
	 * ホスト回復時、そのホスト宛のDelayedジョブを即時実行に昇格する。
	 * fire-and-forget。ホストごと5分のデバウンス。
	 */
	private promoteDelayedJobsForHost(punyHost: string): void {
		// 劣化モード中は昇格を行わない(送出圧力を下げる)
		if (this.isDegraded()) return;

		const now = Date.now();

		// プロセス全体で昇格スキャンを制限
		if (now - this.lastPromoteScanAt < PROMOTE_GLOBAL_DEBOUNCE) return;

		const lastPromote = this.promoteDebounce.get(punyHost);
		if (lastPromote != null && now - lastPromote < PROMOTE_HOST_DEBOUNCE) return;
		this.promoteDebounce.set(punyHost, now);
		this.lastPromoteScanAt = now;

		(async () => {
			const PAGE_SIZE = 500;
			const MAX_SCAN = 5000;
			const MAX_PROMOTE = 200;
			let scanned = 0;
			let promoted = 0;

			for (let start = 0; scanned < MAX_SCAN; start += PAGE_SIZE) {
				const delayed = await this.deliverQueue.getDelayed(start, start + PAGE_SIZE - 1);
				if (delayed.length === 0) break;
				scanned += delayed.length;

				for (const dJob of delayed) {
					try {
						const jobHost = new URL(dJob.data.to).host;
						if (this.utilityService.toPuny(jobHost) === punyHost) {
							await dJob.promote();
							promoted++;
							if (promoted >= MAX_PROMOTE) break;
						}
					} catch {
						// 既にdelayedでない等 — 無視
					}
				}

				if (promoted >= MAX_PROMOTE) break;
			}

			if (promoted > 0) {
				this.logger.info(`promoted ${promoted} delayed jobs for recovered host ${punyHost}`);
			}
		})().catch(e => {
			this.logger.warn(`failed to promote delayed jobs for ${punyHost}: ${e}`);
		});
	}

	/**
	 * ネットワーク結果(成功/失敗)をスライディングウィンドウに記録する。
	 * StatusError(HTTPステータスが返ってきた場合)は「ネットワーク的には成功」なので記録しない。
	 * 失敗数はログ・計測用に保持するが、劣化モードの発動条件には使用しない。
	 */
	@bindThis
	public recordNetworkResult(success: boolean): void {
		const now = Date.now();
		if (success) {
			this.recentSuccesses.push(now);
		} else {
			this.recentFailures.push(now);
		}
		this.pruneWindow(now);

		// 失敗数の計測ログ(発動条件からは外しているが観測用に残す)
		const failures = this.recentFailures.length;
		const total = failures + this.recentSuccesses.length;
		if (failures > DEGRADED_ABS_THRESHOLD ||
			(total >= DEGRADED_RATE_SAMPLE_MIN && failures / total > DEGRADED_RATE_THRESHOLD)) {
			// 閾値超過をログに記録するのみ(発動はしない)。毎分1回に間引く。
			if (!success) {
				if (now - this.lastFailureRateLogAt >= 60_000) {
					const suppressed = this.failureRateLogSuppressed > 0
						? ` (suppressed ${this.failureRateLogSuppressed} similar warnings)`
						: '';
					this.logger.warn(`network failure rate elevated (${failures}/${total} in last 60s) — not triggering degraded mode (per-host circuits handle this)${suppressed}`);
					this.lastFailureRateLogAt = now;
					this.failureRateLogSuppressed = 0;
				} else {
					this.failureRateLogSuppressed++;
				}
			}
		}
	}

	/**
	 * プロセス単位の劣化モードかどうかを返す。
	 * 発動条件:
	 *   a. イベントループ遅延のp99が500msを超えた状態が2計測周期続いたとき
	 *   b. lookup watchdog の発火が直近60秒で5回を超えたとき
	 * 解除条件: 条件を60秒間下回り続けたとき。30分で強制解除。
	 * 起動猶予: プロセス起動から120秒間は発動しない。
	 */
	@bindThis
	public isDegraded(): boolean {
		return this.degradedSince != null;
	}

	/**
	 * lookup watchdog の発火を記録する(外部から呼ばれる想定)。
	 */
	@bindThis
	public recordLookupWatchdogFailure(): void {
		this.lookupWdFailures.push(Date.now());
		this.updateDegradedState(Date.now());
	}

	private pruneWindow(now: number): void {
		const cutoff = now - DEGRADED_WINDOW;
		while (this.recentFailures.length > 0 && this.recentFailures[0] < cutoff) {
			this.recentFailures.shift();
		}
		while (this.recentSuccesses.length > 0 && this.recentSuccesses[0] < cutoff) {
			this.recentSuccesses.shift();
		}
	}

	private updateDegradedState(now: number): void {
		// 起動猶予期間中はカウントのみ行い発動しない
		if (now - this.processStartedAt < DEGRADED_GRACE_PERIOD) return;

		// 強制解除: 30分経過
		if (this.degradedSince != null && now - this.degradedSince >= DEGRADED_FORCE_RELEASE) {
			this.logger.warn('force-releasing degraded mode after 30min');
			this.degradedSince = null;
			this.degradedConditionClearedAt = null;
			return;
		}

		// lookup watchdog のウィンドウ刈り取り
		const wdCutoff = now - DEGRADED_WINDOW;
		while (this.lookupWdFailures.length > 0 && this.lookupWdFailures[0] < wdCutoff) {
			this.lookupWdFailures.shift();
		}

		// 自己健全性シグナルによる発動判定
		const conditionMet =
			this.elDelayExceededCount >= 2 ||
			this.lookupWdFailures.length > DEGRADED_LOOKUP_WD_THRESHOLD;

		if (conditionMet) {
			this.degradedConditionClearedAt = null;
			if (this.degradedSince == null) {
				this.degradedSince = now;
				this.logger.warn(`entering degraded mode (elDelayExceeded=${this.elDelayExceededCount}, lookupWdFailures=${this.lookupWdFailures.length})`);
			}
		} else {
			if (this.degradedSince != null) {
				if (this.degradedConditionClearedAt == null) {
					this.degradedConditionClearedAt = now;
				} else if (now - this.degradedConditionClearedAt >= DEGRADED_HOLD_TIME) {
					this.logger.warn(`leaving degraded mode (elDelayExceeded=${this.elDelayExceededCount}, lookupWdFailures=${this.lookupWdFailures.length})`);
					this.degradedSince = null;
					this.degradedConditionClearedAt = null;
				}
			}
		}
	}

	/**
	 * アイドルドレイン: ワーカーが暇なときにDelayedジョブを前倒しする。
	 * サーキットが開いているホスト宛は除外(前倒ししてもfast-failで戻るだけ)。
	 * 再失敗時はバックオフ延長→3連続でサーキット開放→以後除外、で
	 * ホットループは構造的に発生しない。
	 */
	private async drainIdleDelayed(): Promise<void> {
		try {
			// 劣化モード中は実行しない
			if (this.isDegraded()) return;

			// Waitingが0でなければ通常処理中なのでスキップ
			const waiting = await this.deliverQueue.getWaitingCount();
			if (waiting > 0) return;

			// Active が concurrency の25%未満なら「暇」
			const active = await this.deliverQueue.getActiveCount();
			const concurrency = this.config.deliverJobConcurrency ?? 128;
			if (active >= concurrency * IDLE_DRAIN_ACTIVE_RATIO) return;

			// サーキットが開いているホストの集合
			const circuitOpenHosts = new Set<string>();
			for (const [host, state] of this.hostCircuits) {
				if (state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
					circuitOpenHosts.add(host);
				}
			}

			const delayed = await this.deliverQueue.getDelayed(0, IDLE_DRAIN_MAX_PROMOTE * 2 - 1);
			if (delayed.length === 0) return;

			let promoted = 0;
			for (const dJob of delayed) {
				if (promoted >= IDLE_DRAIN_MAX_PROMOTE) break;
				try {
					const jobHost = new URL(dJob.data.to).host;
					const punyHost = this.utilityService.toPuny(jobHost);
					if (circuitOpenHosts.has(punyHost)) continue;
					await dJob.promote();
					promoted++;
				} catch {
					// 既にdelayedでない等 — 無視
				}
			}

			if (promoted > 0) {
				this.logger.debug(`idle drain: promoted ${promoted} delayed jobs`);
			}
		} catch (e) {
			this.logger.warn(`idle drain error: ${e}`);
		}
	}
}
