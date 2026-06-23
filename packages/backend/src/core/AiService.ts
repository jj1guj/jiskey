/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { Injectable, Inject } from '@nestjs/common';
import { Mutex } from 'async-mutex';
import sharp from 'sharp';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { Config } from '@/config.js';

const CLASS_NAMES = ['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy'] as const;

export type PredictionType = {
	className: (typeof CLASS_NAMES)[number];
	probability: number;
};

@Injectable()
export class AiService {
	private readonly modelPath: string;
	private session: import('onnxruntime-node').InferenceSession | null = null;
	private modelLoadMutex: Mutex = new Mutex();

	constructor(
		@Inject(DI.config)
		private config: Config,
	) {
		this.modelPath = resolve(
			this.config.rootDir,
			'packages/backend/nsfw-model/nsfw_model.onnx',
		);
	}

	@bindThis
	public async detectSensitive(
		source: string | Buffer,
	): Promise<PredictionType[] | null> {
		try {
			const ort = await import('onnxruntime-node');

			if (this.session == null) {
				await this.modelLoadMutex.runExclusive(async () => {
					if (this.session == null) {
						this.session = await ort.InferenceSession.create(this.modelPath);
					}
				});
			}

			const buffer =
				source instanceof Buffer ? source : await fs.promises.readFile(source);
			const { data } = await sharp(buffer)
				.resize(299, 299)
				.removeAlpha()
				.raw()
				.toBuffer({ resolveWithObject: true });

			const floatData = new Float32Array(1 * 299 * 299 * 3);
			for (let i = 0; i < data.length; i++) {
				floatData[i] = data[i] / 255.0;
			}

			const inputTensor = new ort.Tensor(
				'float32',
				floatData,
				[1, 299, 299, 3],
			);
			const results = await this.session!.run({
				[this.session!.inputNames[0]]: inputTensor,
			});
			const outputData = results[this.session!.outputNames[0]]
				.data as Float32Array;

			const predictions: PredictionType[] = CLASS_NAMES.map((className, i) => ({
				className,
				probability: outputData[i],
			}));

			predictions.sort((a, b) => b.probability - a.probability);

			return predictions;
		} catch (err) {
			console.error(err);
			return null;
		}
	}
}
