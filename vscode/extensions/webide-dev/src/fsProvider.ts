/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import type { NodineContainer } from './nodine';

/**
 * A read/write FileSystemProvider over the nodine container's filesystem,
 * rooted at the CONTAINER ROOT. Registered for the `nodine` scheme, so
 * Explorer, editor tabs, search, and the terminal all share one real FS —
 * edits in the editor are visible to `node` processes immediately.
 *
 * URIs: nodine:///folderName/…  →  /folderName/… in the container
 * (uploaded / imported projects land at /<folderName>, so after an upload
 * the workspace root IS the project — WebContainer-style.)
 */

const SCHEME = 'nodine';

/**
 * The workspace ROOT: nodine://nodine/Nodine/ — the display name is the
 * BASENAME of the URI path ("Nodine", like C:\Nodine), so the Explorer
 * header, window title and breadcrumbs all say "Nodine" instead of "/".
 * The provider strips the leading /Nodine segment: every workspace path
 * /Nodine/x maps to container path /x — the workspace folder IS the
 * container root.
 */
export const NODINE_ROOT = 'nodine://nodine/Nodine/';

/** The synthetic workspace path of the container root. */
export const WORKSPACE_PREFIX = '/Nodine';

export function nodineRoot(): vscode.Uri {
	return vscode.Uri.parse(NODINE_ROOT);
}

export class NodineFileSystemProvider implements vscode.FileSystemProvider {

	/** E2E diagnostic: how many times VS Code asked us to watch. */
	public watchCalls = 0;

	/**
	 * bolt.diy-style wiring: the provider is registered BEFORE the runtime
	 * boots and resolves the container lazily on every call. Any nodine:/
	 * request that arrives during the boot window waits for the container
	 * instead of failing with ENOPRO ("no file system provider found").
	 */
	constructor(private getContainer: () => Promise<NodineContainer | null>) { }

	/** Resolve the container, or throw a VS Code-level "unavailable" error. */
	private async ready(): Promise<NodineContainer> {
		const c = await this.getContainer();
		if (!c) {
			throw vscode.FileSystemError.Unavailable('Dev environment is still booting (nodine runtime)');
		}
		return c;
	}

	/** workspace URI /Nodine[/x] → container path /[/x]; raw paths pass through */
	private toContainerPath(uri: vscode.Uri): string {
		const p = uri.path;
		if (p === WORKSPACE_PREFIX) { return '/'; }
		if (p.startsWith(`${WORKSPACE_PREFIX}/`)) {
			return p.slice(WORKSPACE_PREFIX.length);
		}
		return p.startsWith('/') ? p : `/${p}`;
	}

	/** container path /x → workspace URI nodine://nodine/Nodine/x */
	private toWorkspaceUri(containerPath: string): vscode.Uri {
		const rel = containerPath.replace(/^\/+/, '');
		return vscode.Uri.parse(`${NODINE_ROOT}${rel}`);
	}

	stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
		return this._stat(this.toContainerPath(uri));
	}

	private async _stat(p: string): Promise<vscode.FileStat> {
		const c = await this.ready();
		try {
			await c.fs.readdir(p);
			// readdir succeeding means it's a directory
			return { type: vscode.FileType.Directory, ctime: 0, mtime: Date.now(), size: 0 };
		} catch {
			try {
				const data = await c.fs.readFile(p);
				return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: data.length };
			} catch {
				throw vscode.FileSystemError.FileNotFound(p);
			}
		}
	}

	readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
		return (async () => {
			const c = await this.ready();
			const p = this.toContainerPath(uri);
			let raw: any[];
			try {
				raw = await c.fs.readdir(p, { withFileTypes: true } as any) as any[];
			} catch (err) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}
			// nodine returns dirents shaped {name, _kind: 'directory' | 'file'};
			// plain strings (or unknown shapes) are resolved with a readdir
			// probe — readdir on a file path throws ENOTDIR, so it is definitive.
			const out: [string, vscode.FileType][] = [];
			const unknown: string[] = [];
			for (const e of raw) {
				const name = typeof e === 'string' ? e : (e.name ?? String(e));
				const kind = typeof e === 'object' && e !== null
					? (e.isDirectory ? 'directory'
						: e._kind ?? (e.type === 2 ? 'directory' : e.type === 1 ? 'file' : undefined))
					: undefined;
				if (kind === 'directory') { out.push([name, vscode.FileType.Directory]); }
				else if (kind === 'file') { out.push([name, vscode.FileType.File]); }
				else { unknown.push(name); }
			}
			for (const name of unknown) {
				try {
					await c.fs.readdir(`${p}/${name}`);
					out.push([name, vscode.FileType.Directory]);
				} catch {
					out.push([name, vscode.FileType.File]);
				}
			}
			return out;
		})();
	}

	readFile(uri: vscode.Uri): Thenable<Uint8Array> {
		return (async () => {
			const c = await this.ready();
			return c.fs.readFile(this.toContainerPath(uri)).catch(() => {
				throw vscode.FileSystemError.FileNotFound(uri);
			});
		})();
	}

	writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Thenable<void> {
		return (async () => {
			const c = await this.ready();
			const p = this.toContainerPath(uri);
			if (!options.overwrite) {
				try {
					await c.fs.readFile(p);
					if (!options.overwrite) { throw vscode.FileSystemError.FileExists(uri); }
				} catch (e) {
					if (e instanceof vscode.FileSystemError && e.code === 'FileExists') { throw e; }
					// not found → create
				}
			}
			await c.fs.writeFile(p, content);
			this._fireDidChange(uri);
		})();
	}

	/** VS Code FileSystemProvider API: create a directory. */
	createDirectory(uri: vscode.Uri): Thenable<void> {
		return (async () => {
			const c = await this.ready();
			await c.fs.mkdir(this.toContainerPath(uri), { recursive: true });
			this._fireFileCreated(uri);
		})();
	}

	/**
	 * bolt.diy-style event bridge: writes that bypass this provider (the
	 * upload/import helpers and the terminal write straight to the container
	 * FS) still must reach the workbench — without these events the Explorer
	 * tree keeps its cached root listing and never shows the new files.
	 */
	fireExternalChange(type: vscode.FileChangeType, containerPath: string): void {
		this._onDidChangeFile.fire([{ type, uri: this.toWorkspaceUri(containerPath) }]);
	}

	private async exists(p: string): Promise<boolean> {
		const c = await this.ready();
		try {
			await c.fs.readdir(p);
			return true;
		} catch {
			try {
				await c.fs.readFile(p);
				return true;
			} catch {
				return false;
			}
		}
	}

	delete(uri: vscode.Uri, options: { recursive: boolean }): Thenable<void> {
		return (async () => {
			const c = await this.ready();
			const p = this.toContainerPath(uri);
			if (!await this.exists(p)) { throw vscode.FileSystemError.FileNotFound(uri); }
			await c.fs.rm(p, { recursive: options.recursive, force: true });
			this._fireFileDeleted(uri);
		})();
	}

	rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Thenable<void> {
		return (async () => {
			const c = await this.ready();
			const from = this.toContainerPath(oldUri);
			const to = this.toContainerPath(newUri);
			if (!options.overwrite && await this.exists(to)) {
				throw vscode.FileSystemError.FileExists(newUri);
			}
			await c.fs.rename(from, to);
			this._fireFileDeleted(oldUri);
			this._fireFileCreated(newUri);
		})();
	}

	watch(uri: vscode.Uri): vscode.Disposable {
		this.watchCalls++;
		const p = this.toContainerPath(uri);
		let watcher: { close(): void } | undefined;
		// resolve the container lazily: watch() is called synchronously when
		// the workspace folder is added, which may precede the boot
		this.ready().then(c => {
			try {
				watcher = c.fs.watch(p, (_event, filename) => {
					// The kernel delivers the changed entry only. Announce the
					// PARENT directory as changed so the Explorer re-reads its
					// listing (that is what makes terminal mkdir/rm/node -e
					// writes appear live), plus the entry itself for editors.
					const dirty = (filename ?? '').startsWith('/') ? filename : `${p}/${filename ?? ''}`;
					const parts = dirty.replace(/\/+$/, '').split('/');
					parts.pop();
					const parent = parts.join('/') || '/';
					this._fireDidChange(this.toWorkspaceUri(parent));
					this._fireDidChange(this.toWorkspaceUri(dirty));
				});
			} catch {
				// watching unsupported → no-op
			}
		}).catch(() => { /* boot failed → no watcher */ });
		return new vscode.Disposable(() => watcher?.close());
	}	// change events
	private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	onDidChangeFile = this._onDidChangeFile.event;

	private _fireDidChange(uri: vscode.Uri): void {
		this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}

	private _fireFileCreated(uri: vscode.Uri): void {
		this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Created, uri }]);
	}

	private _fireFileDeleted(uri: vscode.Uri): void {
		this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
	}

	get scheme(): string { return SCHEME; }
}

/**
 * Make the container root the (only) workspace folder. The workbench boots
 * inside a persistent tmp: workspace (WORKSPACE state), so this is a LIVE
 * updateWorkspaceFolders — no window reload, the in-memory container (and
 * its just-uploaded files) survives.
 */
export async function openNodineWorkspace(_container?: NodineContainer): Promise<void> {
	const folderUri = nodineRoot();
	const existing = vscode.workspace.workspaceFolders;
	const already = existing?.some(f => f.uri.scheme === SCHEME);
	if (already) { return; }
	// swap every current folder for the nodine root, in place
	const ok = vscode.workspace.updateWorkspaceFolders(
		0, existing?.length ?? 0, { uri: folderUri, name: 'Nodine' });
	if (!ok) {
		console.error('[webide-dev] updateWorkspaceFolders returned false (workspace change rejected)');
	}
}
