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

export class NodineFileSystemProvider implements vscode.FileSystemProvider {

	constructor(private readonly container: NodineContainer) { }

	private toContainerPath(uri: vscode.Uri): string {
		const rel = uri.path.replace(/^\/+/, '');
		return rel ? `/${rel}` : '/';
	}

	stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
		return this._stat(this.toContainerPath(uri));
	}

	private async _stat(p: string): Promise<vscode.FileStat> {
		try {
			await this.container.fs.readdir(p);
			// readdir succeeding means it's a directory
			return { type: vscode.FileType.Directory, ctime: 0, mtime: Date.now(), size: 0 };
		} catch {
			try {
				const data = await this.container.fs.readFile(p);
				return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: data.length };
			} catch {
				throw vscode.FileSystemError.FileNotFound(p);
			}
		}
	}

	readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
		return (async () => {
			const p = this.toContainerPath(uri);
			try {
				const raw = await this.container.fs.readdir(p, { withFileTypes: true } as any) as any[];
				const out: [string, vscode.FileType][] = [];
				for (const e of raw) {
					const name = typeof e === 'string' ? e : (e.name ?? String(e));
					const isDir = typeof e === 'object' && (e.isDirectory ?? (e.type ?? 2) === 2);
					out.push([name, isDir ? vscode.FileType.Directory : vscode.FileType.File]);
				}
				// readdir withFileTypes may not be supported: fall back to stat-ing each
				if (out.length > 0 && out.every(([, t]) => t === vscode.FileType.File) && out.some(([n]) => !n.includes('.'))) {
					const detailed: [string, vscode.FileType][] = [];
					for (const [name] of out) {
						try {
							await this.container.fs.readdir(`${p}/${name}`);
							detailed.push([name, vscode.FileType.Directory]);
						} catch {
							detailed.push([name, vscode.FileType.File]);
						}
					}
					return detailed;
				}
				return out;
			} catch (err) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}
		})();
	}

	readFile(uri: vscode.Uri): Thenable<Uint8Array> {
		return this.container.fs.readFile(this.toContainerPath(uri)).catch(() => {
			throw vscode.FileSystemError.FileNotFound(uri);
		});
	}

	writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Thenable<void> {
		const p = this.toContainerPath(uri);
		return (async () => {
			if (!options.overwrite) {
				try {
					await this.container.fs.readFile(p);
					if (!options.overwrite) { throw vscode.FileSystemError.FileExists(uri); }
				} catch (e) {
					if (e instanceof vscode.FileSystemError && e.code === 'FileExists') { throw e; }
					// not found → create
				}
			}
			await this.container.fs.writeFile(p, content);
			this._fireDidChange(uri);
		})();
	}

	/** VS Code FileSystemProvider API: create a directory. */
	createDirectory(uri: vscode.Uri): Thenable<void> {
		const p = this.toContainerPath(uri);
		return (async () => {
			await this.container.fs.mkdir(p, { recursive: true });
			this._fireFileCreated(uri);
		})();
	}

	private async exists(p: string): Promise<boolean> {
		try {
			await this.container.fs.readdir(p);
			return true;
		} catch {
			try {
				await this.container.fs.readFile(p);
				return true;
			} catch {
				return false;
			}
		}
	}

	delete(uri: vscode.Uri, options: { recursive: boolean }): Thenable<void> {
		const p = this.toContainerPath(uri);
		return (async () => {
			if (!await this.exists(p)) { throw vscode.FileSystemError.FileNotFound(uri); }
			await this.container.fs.rm(p, { recursive: options.recursive, force: true });
			this._fireFileDeleted(uri);
		})();
	}

	rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Thenable<void> {
		return (async () => {
			const from = this.toContainerPath(oldUri);
			const to = this.toContainerPath(newUri);
			if (!options.overwrite && await this.exists(to)) {
				throw vscode.FileSystemError.FileExists(newUri);
			}
			await this.container.fs.rename(from, to);
			this._fireFileDeleted(oldUri);
			this._fireFileCreated(newUri);
		})();
	}

	watch(uri: vscode.Uri): vscode.Disposable {
		const p = this.toContainerPath(uri);
		let watcher: { close(): void } | undefined;
		try {
			watcher = this.container.fs.watch(p, (_event, filename) => {
				const rel = filename.startsWith('/') ? filename : `/${filename}`;
				this._fireDidChange(vscode.Uri.joinPath(uri, rel.replace(/^\/+/, '')));
			});
		} catch {
			// watching unsupported → no-op
		}
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
export async function openNodineWorkspace(_container: NodineContainer): Promise<void> {
	const folderUri = vscode.Uri.parse(`${SCHEME}:/`);
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
