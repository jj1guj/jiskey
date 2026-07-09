/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { lang } from '@@/js/config.js';

const SW_UPDATE_CHECK_INTERVAL_MS = 60_000;

export async function initializeSw() {
	if (!('serviceWorker' in navigator)) return;

	// SW更新時に即時リロード(初回登録時は除く)
	const hadController = navigator.serviceWorker.controller != null;
	let reloading = false;
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (hadController && !reloading) {
			reloading = true;
			window.location.reload();
		}
	});

	navigator.serviceWorker.register('/sw.js', { scope: '/', type: 'classic' });
	navigator.serviceWorker.ready.then(registration => {
		registration.active?.postMessage({
			msg: 'initialize',
			lang,
		});
	});

	// visibilitychange時にSW更新チェック(60秒スロットリング)
	let lastUpdateCheck = 0;
	window.document.addEventListener('visibilitychange', () => {
		if (window.document.visibilityState !== 'visible') return;
		const now = Date.now();
		if (now - lastUpdateCheck < SW_UPDATE_CHECK_INTERVAL_MS) return;
		lastUpdateCheck = now;
		navigator.serviceWorker.getRegistration().then(registration => {
			registration?.update();
		});
	}, { passive: true });
}
