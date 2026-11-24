/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

/**
 * Nodine SDK types (subset of @amplytic/nodine used by this extension).
 * The SDK is bundled from the vendored source at build time; these types
 * keep the extension self-contained without a node_modules dependency.
 */

export interface FileNode { file: { contents: string | Uint8Array } }
export interface DirectoryNode { directory: { children: FileSystemTree } }
export interface SymlinkNode { symlink: string }
export type FileSystemTree = { [name: string]: FileNode | DirectoryNode | SymlinkNode };

export interface ContainerProcess {
	readonly pid: number;
	readonly exit: Promise<number | null>;
	/** Process stdin — a stream of already-encoded text strings. */
	readonly input: WritableStream<string> | null;
	/** Process stdout+stderr — a stream of decoded text strings. */
	readonly output: ReadableStream<string> | null;
	kill(): Promise<void>;
	resize?(cols: number, rows: number): void;
}

export interface FileSystemAPI {
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[]>;
	readFile(path: string): Promise<Uint8Array>;
	readFile(path: string, encoding: 'utf8'): Promise<string>;
	writeFile(path: string, contents: string | Uint8Array): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	watch(path: string, listener: (event: string, filename: string) => void): { close(): void };
}

export interface NodineContainer {
	readonly workdir: string;
	readonly path: string;
	readonly baseEnv: Record<string, string>;
	readonly fs: FileSystemAPI;
	mount(tree: FileSystemTree): Promise<void>;
	spawn(command: string, args?: string[], options?: { cwd?: string; env?: Record<string, string>; terminal?: { cols: number; rows: number } }): Promise<ContainerProcess>;
	on(event: 'server-ready' | 'port' | 'error' | 'preview-message', listener: (...args: any[]) => void): () => void;
	onOutput(fn: (chunk: Uint8Array) => void): () => void;
	previewUrl(port: number): string;
	teardown(): Promise<void>;
}

export interface BootOptions {
	runtimeUrl?: string;
	coep?: 'credentialless' | 'require-corp';
	workdirName?: string;
	enablePreview?: boolean;
	seedLibSources?: boolean;
	env?: Record<string, string>;
}

/**
 * The SDK's module shape: `Container.boot(options)`.
 */
interface NodineModule {
	Container: {
		boot(options?: BootOptions): Promise<NodineContainer>;
	};
}

let containerPromise: Promise<NodineContainer> | null = null;
let currentContainer: NodineContainer | null = null;

export function getContainer(): NodineContainer | null {
	return currentContainer;
}

export function isCrossOriginIsolated(): boolean {
	// works in both window and worker contexts (the extension host is a worker)
	const g = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis as any);
	return g.crossOriginIsolated === true;
}

/**
 * Boot the nodine runtime once per workbench session. The SDK module is
 * imported dynamically from the runtime URL's sibling `sdk.mjs` when staged
 * (see scripts/stage-nodine); in the bundled build it is inlined.
 */
export async function bootContainer(runtimeUrl: string, workdirName = 'project'): Promise<NodineContainer> {
	if (currentContainer) {
		return currentContainer;
	}
	if (!containerPromise) {
		containerPromise = (async () => {
			if (!isCrossOriginIsolated()) {
				throw new Error(
					'This page is not cross-origin isolated. The dev environment needs the hosting server to send ' +
					'Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless headers.'
				);
			}
			// resolve sdk.mjs next to the runtime URL. Worker-safe: extension-host
			// workers may have a blob: base URL, so resolve against the origin.
			// Resolve the runtime URL to an ABSOLUTE URL. In the ext-host worker
			// neither document nor a usable self.location exists (the worker
			// script is a blob:), so derive the app base from this extension's
			// own URI — always served from the app origin in web builds.
			const ext = vscode.extensions.getExtension('amplytic.webide-dev') ?? vscode.extensions.getExtension('webide-dev');
			const extUri = ext?.extensionUri?.toString();
			const baseUri = (typeof document !== 'undefined')
				? document.baseURI
				: (extUri ? extUri.replace(/\/+$/, '') + '/' : undefined);
			if (!baseUri) {
				throw new Error('Cannot resolve the app origin for the nodine runtime URL from this worker context.');
			}
			const absRuntimeUrl = new URL(runtimeUrl, baseUri).href;
			const sdkUrl = new URL('./sdk.mjs', absRuntimeUrl).href;
			const mod: NodineModule = await import(/* @vite-ignore */ sdkUrl);
			const container = await mod.Container.boot({ runtimeUrl: absRuntimeUrl, coep: 'credentialless', workdirName });
			currentContainer = container;
			return container;
		})().catch(err => {
			containerPromise = null;
			throw err;
		});
	}
	return containerPromise;
}
