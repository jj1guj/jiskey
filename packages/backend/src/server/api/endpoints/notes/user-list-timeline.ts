/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Brackets } from 'typeorm';
import type { MiMeta, MiUserList, NotesRepository, UserListMembershipsRepository, UserListsRepository, MutingsRepository, BlockingsRepository, RenoteMutingsRepository } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import ActiveUsersChart from '@/core/chart/charts/active-users.js';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { QueryService } from '@/core/QueryService.js';
import { MiLocalUser } from '@/models/User.js';
import { FanoutTimelineEndpointService } from '@/core/FanoutTimelineEndpointService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['notes', 'lists'],

	requireCredential: true,
	kind: 'read:account',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'Note',
		},
	},

	errors: {
		noSuchList: {
			message: 'No such list.',
			code: 'NO_SUCH_LIST',
			id: '8fb1fbd5-e476-4c37-9fb0-43d55b63a2ff',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		listId: { type: 'string', format: 'misskey:id' },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		sinceDate: { type: 'integer' },
		untilDate: { type: 'integer' },
		allowPartial: { type: 'boolean', default: false }, // true is recommended but for compatibility false by default
		includeMyRenotes: { type: 'boolean', default: true },
		includeRenotedMyNotes: { type: 'boolean', default: true },
		includeLocalRenotes: { type: 'boolean', default: true },
		withRenotes: { type: 'boolean', default: true },
		withFiles: {
			type: 'boolean',
			default: false,
			description: 'Only show notes that have attached files.',
		},
	},
	required: ['listId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.meta)
		private serverSettings: MiMeta,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.userListsRepository)
		private userListsRepository: UserListsRepository,

		@Inject(DI.userListMembershipsRepository)
		private userListMembershipsRepository: UserListMembershipsRepository,

		@Inject(DI.mutingsRepository)
		private mutingsRepository: MutingsRepository,

		@Inject(DI.blockingsRepository)
		private blockingsRepository: BlockingsRepository,

		@Inject(DI.renoteMutingsRepository)
		private renoteMutingsRepository: RenoteMutingsRepository,

		private noteEntityService: NoteEntityService,
		private activeUsersChart: ActiveUsersChart,
		private idService: IdService,
		private fanoutTimelineEndpointService: FanoutTimelineEndpointService,
		private queryService: QueryService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const untilId = ps.untilId ?? (ps.untilDate ? this.idService.gen(ps.untilDate) : null);
			const sinceId = ps.sinceId ?? (ps.sinceDate ? this.idService.gen(ps.sinceDate) : null);

			const list = await this.userListsRepository.findOneBy({
				id: ps.listId,
				userId: me.id,
			});

			if (list == null) {
				throw new ApiError(meta.errors.noSuchList);
			}

			if (!this.serverSettings.enableFanoutTimeline) {
				const timeline = await this.getFromDb(list, {
					untilId,
					sinceId,
					limit: ps.limit,
					includeMyRenotes: ps.includeMyRenotes,
					includeRenotedMyNotes: ps.includeRenotedMyNotes,
					includeLocalRenotes: ps.includeLocalRenotes,
					withFiles: ps.withFiles,
					withRenotes: ps.withRenotes,
				}, me);

				this.activeUsersChart.read(me);

				return await this.noteEntityService.packMany(timeline, me);
			}

			const timeline = await this.fanoutTimelineEndpointService.timeline({
				untilId,
				sinceId,
				limit: ps.limit,
				allowPartial: ps.allowPartial,
				me,
				useDbFallback: this.serverSettings.enableFanoutTimelineDbFallback,
				redisTimelines: ps.withFiles ? [`userListTimelineWithFiles:${list.id}`] : [`userListTimeline:${list.id}`],
				alwaysIncludeMyNotes: true,
				excludePureRenotes: !ps.withRenotes,
				dbFallback: async (untilId, sinceId, limit) => await this.getFromDb(list, {
					untilId,
					sinceId,
					limit,
					includeMyRenotes: ps.includeMyRenotes,
					includeRenotedMyNotes: ps.includeRenotedMyNotes,
					includeLocalRenotes: ps.includeLocalRenotes,
					withFiles: ps.withFiles,
					withRenotes: ps.withRenotes,
				}, me),
			});

			this.activeUsersChart.read(me);

			return timeline;
		});
	}

	private async getFromDb(list: MiUserList, ps: {
		untilId: string | null,
		sinceId: string | null,
		limit: number,
		includeMyRenotes: boolean,
		includeRenotedMyNotes: boolean,
		includeLocalRenotes: boolean,
		withFiles: boolean,
		withRenotes: boolean,
	}, me: MiLocalUser) {
		try {
			return await this.getOptimizedTimeline(list, ps, me);
		} catch (error) {
			return await this.getFallbackTimeline(list, ps, me);
		}
	}

	private async getOptimizedTimeline(list: MiUserList, ps: {
		untilId?: string | null;
		sinceId?: string | null;
		limit?: number;
		includeMyRenotes?: boolean;
		includeRenotedMyNotes?: boolean;
		includeLocalRenotes?: boolean;
		withFiles?: boolean;
		withRenotes?: boolean;
	}, me: MiLocalUser) {
		const startTime = Date.now();

		// 1. ユーザーリストのメンバーを取得（小さなクエリ）
		const listMembers = await this.userListMembershipsRepository.find({
			where: { userListId: list.id },
			select: ['userId', 'withReplies'],
			cache: 30000, // 30秒キャッシュ
		});

		if (listMembers.length === 0) {
			return [];
		}

		// 2. フィルタ情報を並列取得（Index Only Scanを活用）
		const [mutedUserIds, blockedUserIds, renoteMutedUserIds] = await Promise.all([
			this.getMutedUsers(me.id),
			this.getBlockedUsers(me.id),
			this.getRenoteMutedUsers(me.id),
		]);

		// 3. フィルタ済みメンバーリスト作成
		const blockedSet = new Set([...mutedUserIds, ...blockedUserIds]);
		const validMembers = listMembers.filter(member => !blockedSet.has(member.userId));

		if (validMembers.length === 0) {
			return [];
		}

		// 4. 小さなバッチでノートを取得（大きなJOINを回避）
		const batchSize = 15; // 一度に15ユーザーずつ処理
		const allNotes = [];

		for (let i = 0; i < validMembers.length; i += batchSize) {
			const batch = validMembers.slice(i, i + batchSize);
			const batchUserIds = batch.map(m => m.userId);

			try {
				const batchNotes = await this.getNotesForUsers(batchUserIds, batch, ps, me, renoteMutedUserIds);
				allNotes.push(...batchNotes);

				// 十分な数が集まったら終了
				if (allNotes.length >= (ps.limit ?? 10) * 3) {
					break;
				}
			} catch (error) {
				continue;
			}
		}

		// 5. ソートして制限
		const sortedNotes = allNotes
			.sort((a, b) => b.id.localeCompare(a.id))
			.slice(0, ps.limit ?? 10);

		return sortedNotes;
	}

	private async getMutedUsers(userId: string): Promise<string[]> {
		const result = await this.mutingsRepository.find({
			where: { muterId: userId },
			select: ['muteeId'],
			cache: 60000,
		});
		return result.map((r: { muteeId: string }) => r.muteeId);
	}

	private async getBlockedUsers(userId: string): Promise<string[]> {
		const result = await this.blockingsRepository.find({
			where: { blockerId: userId },
			select: ['blockeeId'],
			cache: 60000,
		});
		return result.map((r: { blockeeId: string }) => r.blockeeId);
	}

	private async getRenoteMutedUsers(userId: string): Promise<string[]> {
		try {
			const result = await this.renoteMutingsRepository.find({
				where: { muterId: userId },
				select: ['muteeId'],
				cache: 60000,
			});
			return result.map((r: { muteeId: string }) => r.muteeId);
		} catch (error) {
			// RenoteMutingテーブルが存在しない場合
			return [];
		}
	}

	private async getNotesForUsers(
		userIds: string[],
		members: Array<{ userId: string; withReplies: boolean }>,
		ps: {
			untilId?: string | null;
			sinceId?: string | null;
			limit?: number;
			includeMyRenotes?: boolean;
			includeRenotedMyNotes?: boolean;
			includeLocalRenotes?: boolean;
			withFiles?: boolean;
			withRenotes?: boolean;
		},
		me: MiLocalUser,
		renoteMutedUserIds: string[],
	) {
		let query = this.notesRepository.createQueryBuilder('note')
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser')
			.where('note.userId IN (:...userIds)', { userIds })
			.andWhere('note.channelId IS NULL')
			.andWhere('user.isSuspended = false');

		// 返信フィルタリング
		const membersWithReplies = new Set(
			members.filter(m => m.withReplies).map(m => m.userId),
		);

		if (membersWithReplies.size > 0) {
			query = query.andWhere(new Brackets(qb => {
				qb.where('note.replyId IS NULL')
					.orWhere('note.replyUserId = note.userId')
					.orWhere('note.replyUserId = :meId', { meId: me.id })
					.orWhere('note.userId IN (:...withRepliesUsers)', { withRepliesUsers: Array.from(membersWithReplies) });
			}));
		} else {
			query = query.andWhere(new Brackets(qb => {
				qb.where('note.replyId IS NULL')
					.orWhere('note.replyUserId = note.userId')
					.orWhere('note.replyUserId = :meId', { meId: me.id });
			}));
		}

		// 可視性チェック
		this.queryService.generateVisibilityQuery(query, me);

		// リノートミュートフィルタ
		if (renoteMutedUserIds.length > 0) {
			query = query.andWhere(new Brackets(qb => {
				qb.where('note.renoteId IS NULL')
					.orWhere('note.text IS NOT NULL')
					.orWhere('note.userId NOT IN (:...renoteMutedIds)', { renoteMutedIds: renoteMutedUserIds });
			}));
		}

		// その他のフィルタ
		if (ps.includeMyRenotes === false) {
			query = query.andWhere(new Brackets(qb => {
				qb.orWhere('note.userId != :meId', { meId: me.id });
				qb.orWhere('note.renoteId IS NULL');
				qb.orWhere('note.text IS NOT NULL');
				qb.orWhere('note.fileIds != \'{}\'');
			}));
		}

		if (ps.withRenotes === false) {
			query = query.andWhere(new Brackets(qb => {
				qb.orWhere('note.renoteId IS NULL');
				qb.orWhere('note.text IS NOT NULL');
				qb.orWhere('note.fileIds != \'{}\'');
			}));
		}

		if (ps.withFiles) {
			query = query.andWhere('note.fileIds != \'{}\'');
		}

		// ページング
		if (ps.untilId) {
			query = query.andWhere('note.id < :untilId', { untilId: ps.untilId });
		}
		if (ps.sinceId) {
			query = query.andWhere('note.id > :sinceId', { sinceId: ps.sinceId });
		}

		return query
			.orderBy('note.id', 'DESC')
			.limit(50) // 各バッチで最大50件
			.getMany();
	}

	private async getFallbackTimeline(list: MiUserList, ps: {
		untilId?: string | null;
		sinceId?: string | null;
		limit?: number;
		includeMyRenotes?: boolean;
		includeRenotedMyNotes?: boolean;
		includeLocalRenotes?: boolean;
		withFiles?: boolean;
		withRenotes?: boolean;
	}, me: MiLocalUser) {
		// 最小限の安全なクエリ
		const query = this.notesRepository.createQueryBuilder('note')
			.innerJoinAndSelect('note.user', 'user')
			.innerJoin('user_list_membership', 'ulm', 'ulm.userId = note.userId')
			.where('ulm.userListId = :listId', { listId: list.id })
			.andWhere('note.channelId IS NULL')
			.andWhere('user.isSuspended = false')
			.andWhere('note.visibility IN (:...visibilities)', { visibilities: ['public', 'home'] });

		if (ps.untilId) {
			query.andWhere('note.id < :untilId', { untilId: ps.untilId });
		}
		if (ps.sinceId) {
			query.andWhere('note.id > :sinceId', { sinceId: ps.sinceId });
		}

		return query
			.orderBy('note.id', 'DESC')
			.limit(ps.limit ?? 10)
			.getMany();
	}
}
