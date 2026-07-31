/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as stream from 'node:stream';
import ipaddr from 'ipaddr.js';
import CacheableLookup from 'cacheable-lookup';
import fetch from 'node-fetch';
import { HttpProxyAgent, HttpsProxyAgent } from 'hpagent';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { StatusError } from '@/misc/status-error.js';
import { bindThis } from '@/decorators.js';
import { ResolverWithStale } from '@/core/ResolverWithStale.js';
import { validateContentTypeSetAsActivityPub } from '@/core/activitypub/misc/validator.js';
import { assertActivityMatchesUrl, FetchAllowSoftFailMask } from '@/core/activitypub/misc/check-against-url.js';
import type { IObject } from '@/core/activitypub/type.js';
import type { BodyInit, Response } from 'node-fetch';
import type { URL } from 'node:url';

export type HttpRequestSendOptions = {
	throwErrorWhenResponseNotOk: boolean;
	validators?: ((res: Response) => void)[];
};

// ソケット再利用の遊休時間バケット
type IdleBuckets = {
	under30s: number;
	'30to90s': number;
	'90to300s': number;
	over300s: number;
};

// ソケット計測の共有カウンタ(プロセスローカル)
const socketStats = {
	newConnections: 0,
	reusedConnections: 0,
	idleBuckets: { under30s: 0, '30to90s': 0, '90to300s': 0, over300s: 0 } as IdleBuckets,
	// 直近に再利用ソケットで接続したホスト(失敗ログとの照合用)
	recentReuseHosts: new Set<string>(),
};

/** ソケット統計を取得する(DeliverProcessorService等から参照) */
export function getSocketStats() {
	return socketStats;
}

function classifyIdleTime(idleMs: number, buckets: IdleBuckets): void {
	if (idleMs < 30_000) buckets.under30s++;
	else if (idleMs < 90_000) buckets['30to90s']++;
	else if (idleMs < 300_000) buckets['90to300s']++;
	else buckets.over300s++;
}

// 死んだIPへのSYNは応答もRSTも返らず、接続確立だけでリクエスト全体の15秒を食い潰す。
// 接続8秒/応答15秒に分離することで、死んだホストの占有コストを抑えつつ、
// 応答の遅い生存ホストへの猶予は維持する。
// 自宅回線のパケットロスによるSYN再送(1s/3s/7s)をもう1段待てるように8秒とした。
// 死んだIPへの占有コストは8秒に増えるが、サーキットが抑制するため許容範囲。
const CONNECT_TIMEOUT = 8000;

function setupConnectTimeout(socket: stream.Duplex): void {
	const timer = setTimeout(() => {
		socket.destroy(new Error('connect/lookup timeout after 8s'));
	}, CONNECT_TIMEOUT);
	timer.unref();

	const clear = () => clearTimeout(timer);
	// TLSSocketは'connect'を発火しないため'secureConnect'が必須。
	// これを欠くとkeepalive中の健全なソケットを8秒で破壊する。
	socket.once('connect', clear); // http (net.Socket)
	socket.once('secureConnect', clear); // https (TLSSocket)
	socket.once('close', clear);
}

class HttpRequestServiceAgent extends http.Agent {
	constructor(
		private config: Config,
		options?: http.AgentOptions,
	) {
		super(options);
	}

	@bindThis
	public createConnection(options: http.ClientRequestArgs, callback?: (err: Error | null, stream: stream.Duplex) => void): stream.Duplex {
		socketStats.newConnections++;
		const socket = super.createConnection(options, callback);

		if (socket == null) {
			throw new Error('Failed to create socket');
		}

		// ソケットがプールに戻るたびに利用時刻を記録(reuseSocketで遊休時間を計算するため)
		if (socket instanceof net.Socket) {
			socket.on('free', () => {
				(socket as unknown as Record<string, unknown>).__lastUsedAt = Date.now();
			});
		}

		// TCP接続確立に独立した5秒タイムアウトを設定
		setupConnectTimeout(socket);

		socket.on('connect', () => {
			if (socket instanceof net.Socket && process.env.NODE_ENV === 'production') {
				const address = socket.remoteAddress;
				if (address && ipaddr.isValid(address)) {
					if (this.isPrivateIp(address)) {
						socket.destroy(new Error(`Blocked address: ${address}`));
					}
				}
			}
		});

		return socket;
	}

	@bindThis
	private isPrivateIp(ip: string): boolean {
		const parsedIp = ipaddr.parse(ip);

		for (const net of this.config.allowedPrivateNetworks ?? []) {
			const cidr = ipaddr.parseCIDR(net);
			if (cidr[0].kind() === parsedIp.kind() && parsedIp.match(ipaddr.parseCIDR(net))) {
				return false;
			}
		}

		return parsedIp.range() !== 'unicast';
	}

	public reuseSocket(socket: net.Socket, req: http.ClientRequest): void {
		socketStats.reusedConnections++;
		const lastUsed = (socket as unknown as Record<string, unknown>).__lastUsedAt as number | undefined;
		if (lastUsed != null) {
			classifyIdleTime(Date.now() - lastUsed, socketStats.idleBuckets);
		}
		const host = req.getHeader('host') as string | undefined;
		if (host != null) {
			socketStats.recentReuseHosts.add(host);
			// 直近セットは100件で刈り取り
			if (socketStats.recentReuseHosts.size > 100) {
				const first = socketStats.recentReuseHosts.values().next().value;
				if (first != null) socketStats.recentReuseHosts.delete(first);
			}
		}
		super.reuseSocket(socket, req);
	}
}

class HttpsRequestServiceAgent extends https.Agent {
	constructor(
		private config: Config,
		options?: https.AgentOptions,
	) {
		super(options);
	}

	@bindThis
	public createConnection(options: http.ClientRequestArgs, callback?: (err: Error | null, stream: stream.Duplex) => void): stream.Duplex {
		socketStats.newConnections++;
		const socket = super.createConnection(options, callback);

		if (socket == null) {
			throw new Error('Failed to create socket');
		}

		if (socket instanceof net.Socket) {
			socket.on('free', () => {
				(socket as unknown as Record<string, unknown>).__lastUsedAt = Date.now();
			});
		}

		// TCP接続確立に独立した5秒タイムアウトを設定
		setupConnectTimeout(socket);

		socket.on('connect', () => {
			if (socket instanceof net.Socket && process.env.NODE_ENV === 'production') {
				const address = socket.remoteAddress;
				if (address && ipaddr.isValid(address)) {
					if (this.isPrivateIp(address)) {
						socket.destroy(new Error(`Blocked address: ${address}`));
					}
				}
			}
		});

		return socket;
	}

	@bindThis
	private isPrivateIp(ip: string): boolean {
		const parsedIp = ipaddr.parse(ip);

		for (const net of this.config.allowedPrivateNetworks ?? []) {
			const cidr = ipaddr.parseCIDR(net);
			if (cidr[0].kind() === parsedIp.kind() && parsedIp.match(ipaddr.parseCIDR(net))) {
				return false;
			}
		}

		return parsedIp.range() !== 'unicast';
	}

	public reuseSocket(socket: net.Socket, req: http.ClientRequest): void {
		socketStats.reusedConnections++;
		const lastUsed = (socket as unknown as Record<string, unknown>).__lastUsedAt as number | undefined;
		if (lastUsed != null) {
			classifyIdleTime(Date.now() - lastUsed, socketStats.idleBuckets);
		}
		const host = req.getHeader('host') as string | undefined;
		if (host != null) {
			socketStats.recentReuseHosts.add(host);
			if (socketStats.recentReuseHosts.size > 100) {
				const first = socketStats.recentReuseHosts.values().next().value;
				if (first != null) socketStats.recentReuseHosts.delete(first);
			}
		}
		super.reuseSocket(socket, req);
	}
}

@Injectable()
export class HttpRequestService {
	/**
	 * Get http non-proxy agent (without local address filtering)
	 */
	private readonly httpNative: http.Agent;

	/**
	 * Get https non-proxy agent (without local address filtering)
	 */
	private readonly httpsNative: https.Agent;

	/**
	 * Get http non-proxy agent
	 */
	private readonly http: http.Agent;

	/**
	 * Get https non-proxy agent
	 */
	private readonly https: https.Agent;

	/**
	 * Get http proxy or non-proxy agent
	 */
	public readonly httpAgent: http.Agent;

	/**
	 * Get https proxy or non-proxy agent
	 */
	public readonly httpsAgent: https.Agent;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,
	) {
		// リゾルバ構築:
		// ResolverWithStale でラップし、staleキャッシュ(6時間)とDNSキープウォームを共通で提供する。
		// UDPリゾルバ → stale → ETIMEOUT
		// 注意: この設定は外向きHTTP(このサービス経由)にのみ影響する。
		// DBやRedisなどコンテナ名の解決は別経路(dns.lookup)のため影響しない。

		// UDPリゾルバ
		// DNS問い合わせの待ち時間に上限を設ける(最悪でも約4秒でDNSを諦め、
		// リクエスト全体のタイムアウト予算を食い潰さないようにする)。
		// c-aresはリトライごとにタイムアウトを倍増させるため、tries:1で
		// 最悪 timeout(2s) + 倍増リトライ(4s) ≒ 約4秒に収まる。
		const udpResolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
		if (config.outgoingDnsServers != null && config.outgoingDnsServers.length > 0) {
			udpResolver.setServers(config.outgoingDnsServers);
		}

		// ResolverWithStale: staleキャッシュを全構成共通で提供
		// dns.promises.Resolver を継承しているため型キャスト不要。
		// 以前の as unknown as キャストは型検査を無効化し、
		// cacheable-lookupのinstanceof分岐バグの検出を妨げていた。
		const resolver = new ResolverWithStale(udpResolver, this.redisClient);

		const cache = new CacheableLookup({
			maxTtl: 3600,	// 1hours
			errorTtl: 30,	// 30secs
			resolver,
			lookup: false,	// nativeのdns.lookupにfallbackしない
		});

		const keepAlive = config.outgoingHttpKeepAlive;

		const agentOption = {
			keepAlive,
			keepAliveMsecs: 30 * 1000,
			lookup: cache.lookup as unknown as net.LookupFunction,
			localAddress: config.outgoingAddress,
		};

		this.httpNative = new http.Agent(agentOption);

		this.httpsNative = new https.Agent(agentOption);

		this.http = new HttpRequestServiceAgent(config, agentOption);

		this.https = new HttpsRequestServiceAgent(config, agentOption);

		const maxSockets = Math.max(256, config.deliverJobConcurrency ?? 128);

		this.httpAgent = config.proxy
			? new HttpProxyAgent({
				keepAlive: true,
				keepAliveMsecs: 30 * 1000,
				maxSockets,
				maxFreeSockets: 256,
				scheduling: 'lifo',
				proxy: config.proxy,
				localAddress: config.outgoingAddress,
			})
			: this.http;

		this.httpsAgent = config.proxy
			? new HttpsProxyAgent({
				keepAlive: true,
				keepAliveMsecs: 30 * 1000,
				maxSockets,
				maxFreeSockets: 256,
				scheduling: 'lifo',
				proxy: config.proxy,
				localAddress: config.outgoingAddress,
			})
			: this.https;

		// 60秒ごとにソケット統計をログ出力
		setInterval(() => {
			const s = socketStats;
			const total = s.newConnections + s.reusedConnections;
			if (total === 0) return;
			console.log(
				`[HttpRequestService] socket stats (last 60s): new=${s.newConnections} reused=${s.reusedConnections}`
				+ ` idle(<30s=${s.idleBuckets.under30s} 30-90s=${s.idleBuckets['30to90s']}`
				+ ` 90-300s=${s.idleBuckets['90to300s']} 300s+=${s.idleBuckets.over300s})`,
			);
			s.newConnections = 0;
			s.reusedConnections = 0;
			s.idleBuckets = { under30s: 0, '30to90s': 0, '90to300s': 0, over300s: 0 };
			s.recentReuseHosts.clear();
		}, 60_000).unref();
	}

	/**
	 * Get agent by URL
	 * @param url URL
	 * @param bypassProxy Always bypass proxy
	 * @param isLocalAddressAllowed
	 */
	@bindThis
	public getAgentByUrl(url: URL, bypassProxy = false, isLocalAddressAllowed = false): http.Agent | https.Agent {
		if (bypassProxy || (this.config.proxyBypassHosts ?? []).includes(url.hostname)) {
			if (isLocalAddressAllowed) {
				return url.protocol === 'http:' ? this.httpNative : this.httpsNative;
			}
			return url.protocol === 'http:' ? this.http : this.https;
		} else {
			if (isLocalAddressAllowed && (!this.config.proxy)) {
				return url.protocol === 'http:' ? this.httpNative : this.httpsNative;
			}
			return url.protocol === 'http:' ? this.httpAgent : this.httpsAgent;
		}
	}

	/**
	 * Get agent for http by URL
	 * @param url URL
	 * @param isLocalAddressAllowed
	 */
	@bindThis
	public getAgentForHttp(url: URL, isLocalAddressAllowed = false): http.Agent {
		if ((this.config.proxyBypassHosts ?? []).includes(url.hostname)) {
			return isLocalAddressAllowed
				? this.httpNative
				: this.http;
		} else {
			return this.httpAgent;
		}
	}

	/**
	 * Get agent for https by URL
	 * @param url URL
	 * @param isLocalAddressAllowed
	 */
	@bindThis
	public getAgentForHttps(url: URL, isLocalAddressAllowed = false): https.Agent {
		if ((this.config.proxyBypassHosts ?? []).includes(url.hostname)) {
			return isLocalAddressAllowed
				? this.httpsNative
				: this.https;
		} else {
			return this.httpsAgent;
		}
	}

	@bindThis
	public async getActivityJson(url: string, isLocalAddressAllowed = false, allowSoftfail: FetchAllowSoftFailMask = FetchAllowSoftFailMask.Strict): Promise<IObject> {
		const res = await this.send(url, {
			method: 'GET',
			headers: {
				Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
			},
			timeout: 5000,
			size: 1024 * 256,
			isLocalAddressAllowed: isLocalAddressAllowed,
		}, {
			throwErrorWhenResponseNotOk: true,
			validators: [validateContentTypeSetAsActivityPub],
		});

		const finalUrl = res.url; // redirects may have been involved
		const activity = await res.json() as IObject;

		assertActivityMatchesUrl(url, activity, finalUrl, allowSoftfail);

		return activity;
	}

	@bindThis
	public async getJson<T = unknown>(url: string, accept = 'application/json, */*', headers?: Record<string, string>, isLocalAddressAllowed = false): Promise<T> {
		const res = await this.send(url, {
			method: 'GET',
			headers: Object.assign({
				Accept: accept,
			}, headers ?? {}),
			timeout: 5000,
			size: 1024 * 256,
			isLocalAddressAllowed: isLocalAddressAllowed,
		});

		return await res.json() as T;
	}

	@bindThis
	public async getHtml(url: string, accept = 'text/html, */*', headers?: Record<string, string>, isLocalAddressAllowed = false): Promise<string> {
		const res = await this.send(url, {
			method: 'GET',
			headers: Object.assign({
				Accept: accept,
			}, headers ?? {}),
			timeout: 5000,
			isLocalAddressAllowed: isLocalAddressAllowed,
		});

		return await res.text();
	}

	@bindThis
	public async send(
		url: string,
		args: {
			method?: string,
			body?: BodyInit,
			headers?: Record<string, string>,
			timeout?: number,
			size?: number,
			isLocalAddressAllowed?: boolean,
		} = {},
		extra: HttpRequestSendOptions = {
			throwErrorWhenResponseNotOk: true,
			validators: [],
		},
	): Promise<Response> {
		const timeout = args.timeout ?? 5000;

		const controller = new AbortController();
		setTimeout(() => {
			controller.abort();
		}, timeout);

		const isLocalAddressAllowed = args.isLocalAddressAllowed ?? false;

		const res = await fetch(url, {
			method: args.method ?? 'GET',
			headers: {
				'User-Agent': this.config.userAgent,
				...(args.headers ?? {}),
			},
			body: args.body,
			size: args.size ?? 10 * 1024 * 1024,
			agent: (url) => this.getAgentByUrl(url, false, isLocalAddressAllowed),
			signal: controller.signal,
		});

		if (!res.ok && extra.throwErrorWhenResponseNotOk) {
			throw new StatusError(`${res.status} ${res.statusText}`, res.status, res.statusText);
		}

		if (res.ok) {
			for (const validator of (extra.validators ?? [])) {
				validator(res);
			}
		}

		return res;
	}
}
