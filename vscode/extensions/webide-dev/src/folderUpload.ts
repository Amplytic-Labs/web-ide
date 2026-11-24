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
 *     thread opens the browser's File System Access folder picker.
 *  2. Read the picked tree through vscode.workspace.fs (the built-in web
 *     'file' provider owns the directory handle on the main thread).
 *  3. Copy every file into the nodine container (bolt.diy-style ignore
 *     rules and size caps).
 */

const IGNORE_DIRS = new Set([
	'node_modules', '.git', '.github', '.vscode', 'dist', 'build', '.next',
	'.cache', 'coverage', '.idea', '.turbo', 'out',
]);

const MAX_FILE_KB = 512;

async function copyDir(
	src: vscode.Uri,
	destPath: string,
	writeFile: (path: string, contents: Uint8Array) => Promise<void>,
	ensureDir: (path: string) => Promise<void>,
	onProgress: (msg: string) => void,
): Promise<number> {
	let copied = 0;
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(src);
	} catch {
		return 0;
	}
	await ensureDir(destPath);
	for (const [name, type] of entries) {
		if (type === vscode.FileType.Directory) {
			if (IGNORE_DIRS.has(name)) { continue; }
			copied += await copyDir(vscode.Uri.joinPath(src, name), `${destPath}/${name}`, writeFile, ensureDir, onProgress);
		} else if (type === vscode.FileType.File) {
			if (name.endsWith('.map') || name === '.DS_Store') { continue; }
			try {
				const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(src, name));
				if (stat.size > MAX_FILE_KB * 1024) { continue; }
				const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(src, name));
				await writeFile(`${destPath}/${name}`, bytes);
				copied++;
				if (copied % 10 === 0) { onProgress(`${copied} files…`); }
			} catch (err) {
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
): Promise<void> {
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
			progress.report({ message: 'reading files…' });
			const copied = await copyDir(root, folderName, writeFile, ensureDir,
				msg => progress.report({ message: msg }));
			if (copied === 0) {
				vscode.window.showWarningMessage(`No files uploaded from ${folderName} (empty, or all filtered by ignore rules).`);
				return;
			}
			await reveal(folderName);
			vscode.window.showInformationMessage(`Uploaded ${copied} files from ${folderName} — the dev terminal is booting at /${folderName}.`);
		} catch (err) {
			vscode.window.showErrorMessage(`Folder upload failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
}
