/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class UserListWithFiles1774704454300 {
    name = 'UserListWithFiles1774704454300'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "user_list" ADD "withFiles" boolean NOT NULL DEFAULT false`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "user_list" DROP COLUMN "withFiles"`);
    }
}
