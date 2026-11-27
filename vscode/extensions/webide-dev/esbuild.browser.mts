/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist', 'browser');

run({
	platform: 'browser',
	entryPoints: {
		'extensionMain': path.join(srcDir, 'extensionMain.ts'),
	},
	srcDir,
	outdir: outDir,
	additionalOptions: {
		tsconfig: path.join(import.meta.dirname, 'tsconfig.browser.json'),
		// vendor/*.qrjs are raw text assets (vendored third-party libs injected
		// into the LAN-share webview HTML)
		loader: { '.qrjs': 'text' },
	},
}, process.argv);
