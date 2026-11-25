/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

/**
 * Upload a local folder into the nodine workspace.
 *
 * Web extensions run in the extension host WORKER, where `document` is not
 * available — a hidden <input webkitdirectory> cannot be created there. The
 * web-native flow is:
 *  1. vscode.window.showOpenDialog({ canSelectFolders: true }) — the main
 *     thread opens the browser's folder picker (File System Access API, or
 *     the webkitdirectory fallback which imports into tmp: first).
 *  2. Read the picked tree through vscode.workspace.fs (the built-in web
 *     'file' provider owns the directory handle on the main thread).
 *  3. Copy every file into the nodine container (bolt.diy-style ignore
 *     rules and size caps) with LIVE progress: file count, skipped count
 *     and percentage in a notification.
 *
 * THE PICKER MUST BE THE FIRST AWAIT. showDirectoryPicker (and the
 * webkitdirectory fallback) require the browser's transient user
 * activation, which expires ~5s after the "Upload Folder" click. Booting
 * the runtime first (seconds to ~40s) let it expire, the browser rejected
 * the picker, VS Code swallowed the error and the command silently did
 * nothing. The runtime is booted only AFTER a folder is picked, under a
 * progress notification.
 */

const IGNORE_DIRS = new Set([
	'node_modules', '.git', '.github', '.vscode', 'dist', 'build', '.next',
	'.cache', 'coverage', '.idea', '.turbo', 'out',
]);

const MAX_FILE_KB = 512;

interface CopyStats {
	copied: number;
	skipped: number;
}

/** Count every copyable file first, so the progress bar can show a real %. */
async function countFiles(src: vscode.Uri, stats: CopyStats): Promise<number> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(src);
	} catch {
		return 0;
	}
	let n = 0;
	for (const [name, type] of entries) {
		if (type === vscode.FileType.Directory) {
			if (IGNORE_DIRS.has(name)) { continue; }
			n += await countFiles(vscode.Uri.joinPath(src, name), stats);
		} else if (type === vscode.FileType.File) {
			if (name.endsWith('.map') || name === '.DS_Store') { continue; }
			n++;
		}
	}
	return n;
}

async function copyDir(
	src: vscode.Uri,
	destPath: string,
	writeFile: (path: string, contents: Uint8Array) => Promise<void>,
	ensureDir: (path: string) => Promise<void>,
	onProgress: (increment: number, message: string) => void,
	stats: CopyStats,
): Promise<number> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(src);
	} catch {
		return 0;
	}
	await ensureDir(destPath);
	let copied = 0;
	for (const [name, type] of entries) {
		if (type === vscode.FileType.Directory) {
			if (IGNORE_DIRS.has(name)) { continue; }
			copied += await copyDir(vscode.Uri.joinPath(src, name), `${destPath}/${name}`, writeFile, ensureDir, onProgress, stats);
		} else if (type === vscode.FileType.File) {
			if (name.endsWith('.map') || name === '.DS_Store') { continue; }
			try {
				const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(src, name));
				if (stat.size > MAX_FILE_KB * 1024) { stats.skipped++; continue; }
				const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(src, name));
				await writeFile(`${destPath}/${name}`, bytes);
				copied++;
				stats.copied++;
				// report every file for small folders, every 10th for big ones
				if (stats.copied % (stats.copied < 50 ? 1 : 10) === 0) {
					onProgress(0, `${stats.copied} files copied${stats.skipped ? ` · ${stats.skipped} skipped` : ''}`);
				}
			} catch (err) {
				stats.skipped++;
				console.warn(`[webide-dev] upload: failed to read ${name}:`, err);
			}
		}
	}
	return copied;
}

export async function uploadFolder(
	writeFile: (path: string, contents: Uint8Array) => Promise<void>,
	ensureDir: (path: string) => Promise<void>,
	reveal: (folderName: string) => Promise<void>,
	/** Called after the picker succeeds, before any file is read — boot the runtime here. */
	prepareRuntime: () => Promise<void>,
): Promise<void> {
	// FIRST await: the browser's native picker needs the still-live user
	// activation from the "Upload Folder" click. Anything slow before this
	// (runtime boot) makes the picker fail with a swallowed SecurityError.
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Upload Folder',
		title: 'Choose a local folder to upload into the dev environment',
	});
	console.log('[webide-dev] upload: picker returned', picked?.map(u => u.toString()));
	if (!picked || picked.length === 0) { return; }

	const root = picked[0];
	const folderName = root.path.split('/').filter(Boolean).pop() || 'uploaded-folder';

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: `Uploading ${folderName}`,
		cancellable: false,
	}, async progress => {
		try {
			progress.report({ message: 'booting dev environment…' });
			await prepareRuntime(); // may take seconds to ~40s on a cold start

			progress.report({ message: 'scanning files…' });
			const stats: CopyStats = { copied: 0, skipped: 0 };
			const total = await countFiles(root, stats);
			if (total === 0) {
				vscode.window.showWarningMessage(`No uploadable files found in ${folderName} (node_modules and build artifacts are skipped).`);
				return;
			}
			progress.report({ message: `copying ${total} files…`, increment: 0 });
			const copied = await copyDir(root, folderName, writeFile, ensureDir,
				(_inc, message) => progress.report({ message }), stats);
			if (copied === 0) {
				vscode.window.showWarningMessage(`No files uploaded from ${folderName} (empty, or all filtered by ignore rules).`);
				return;
			}
			progress.report({ message: 'preparing workspace…', increment: 100 });
			await reveal(folderName);
			const skippedNote = stats.skipped ? ` (${stats.skipped} skipped — ignored dirs or >${MAX_FILE_KB} KB)` : '';
			vscode.window.showInformationMessage(`Uploaded ${copied} of ${total} files from ${folderName}${skippedNote} — dev terminal is booting at /${folderName}.`);
		} catch (err) {
			vscode.window.showErrorMessage(`Folder upload failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
}
