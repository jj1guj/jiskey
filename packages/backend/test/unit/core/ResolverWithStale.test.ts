/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as dns from 'node:dns';
import { describe, test, expect, vi } from 'vitest';
import { ResolverWithStale } from '@/core/ResolverWithStale.js';

function makeError(code: string, message?: string): NodeJS.ErrnoException {
	const err = new Error(message ?? `mock ${code}`) as NodeJS.ErrnoException;
	err.code = code;
	return err;
}

function createMockResolver(overrides: {
	resolve4?: (hostname: string, options: { ttl: true }) => Promise<dns.RecordWithTtl[]>;
	resolve6?: (hostname: string, options: { ttl: true }) => Promise<dns.RecordWithTtl[]>;
} = {}): dns.promises.Resolver {
	const resolver = {
		resolve4: overrides.resolve4 ?? vi.fn().mockResolvedValue([{ address: '1.2.3.4', ttl: 300 }]),
		resolve6: overrides.resolve6 ?? vi.fn().mockResolvedValue([{ address: '::1', ttl: 300 }]),
	};
	// ResolverWithStale は dns.promises.Resolver を継承しているが、
	// コンストラクタで inner として使うだけなので duck-typing で十分
	return resolver as unknown as dns.promises.Resolver;
}

describe('ResolverWithStale', () => {
	test('resolve6 ENODATA returns empty array (not an exception)', async () => {
		const inner = createMockResolver({
			resolve6: vi.fn().mockRejectedValue(makeError('ENODATA')),
		});
		const resolver = new ResolverWithStale(inner);

		const result = await resolver.resolve6('example.com', { ttl: true });
		expect(result).toEqual([]);
	});

	test('resolve6 ETIMEOUT with no stale returns empty array (fail-open)', async () => {
		const inner = createMockResolver({
			resolve6: vi.fn().mockRejectedValue(makeError('ETIMEOUT')),
		});
		const resolver = new ResolverWithStale(inner);

		const result = await resolver.resolve6('example.com', { ttl: true });
		expect(result).toEqual([]);
	});

	test('resolve4 ETIMEOUT with no stale throws ETIMEOUT', async () => {
		const inner = createMockResolver({
			resolve4: vi.fn().mockRejectedValue(makeError('ETIMEOUT')),
		});
		const resolver = new ResolverWithStale(inner);

		await expect(resolver.resolve4('example.com', { ttl: true }))
			.rejects.toMatchObject({ code: 'ETIMEOUT' });
	});

	test('resolve4 ENOTFOUND returns empty array (negative answer)', async () => {
		const inner = createMockResolver({
			resolve4: vi.fn().mockRejectedValue(makeError('ENOTFOUND')),
		});
		const resolver = new ResolverWithStale(inner);

		// ENOTFOUND は「レコードなし」の正常応答として空配列を返す。
		// cacheable-lookup は A/AAAA 両方空の場合、ENOTFOUND 相当として扱う。
		const result = await resolver.resolve4('example.com', { ttl: true });
		expect(result).toEqual([]);
	});

	test('resolve4 success returns records', async () => {
		const inner = createMockResolver({
			resolve4: vi.fn().mockResolvedValue([{ address: '93.184.216.34', ttl: 60 }]),
		});
		const resolver = new ResolverWithStale(inner);

		const result = await resolver.resolve4('example.com', { ttl: true });
		expect(result).toEqual([{ address: '93.184.216.34', ttl: 60 }]);
	});
});
