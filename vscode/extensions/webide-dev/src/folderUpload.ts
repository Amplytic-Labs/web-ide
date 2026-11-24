/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

/**
 * Upload a local folder into the nodine workspace:
 * a hidden <input type="file" webkitdirectory> lets the user pick a folder;
 * files are filtered (bolt.diy-style ignore rules) and written into the
 * container filesystem via the nodine FS provider.
 */

const IGNORE_DIRS = new Set([
	'node_modules', '.git', '.github', '.vscode', 'dist', 'build', '.next',
	'.cache', 'coverage', '.idea', '.turbo', 'out',
]);

const MAX_FILE_KB = 512;

function pickFolder(): Promise<File[]> {
	return new Promise(resolve => {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		(input as any).webkitdirectory = true;
		input.style.display = 'none';
		input.addEventListener('change', () => {
			resolve(Array.from(input.files ?? []));
			input.remove();
		});
		// if the user cancels the picker the input never fires; also resolve on cancel
		window.addEventListener('focus', () => setTimeout(() => {
			if (!input.files || input.files.length === 0) { resolve([]); input.remove(); }
		}, 1000), { once: true });
		document.body.appendChild(input);
		input.click();
	});
}

export async function uploadFolder(
	writeFile: (path: string, contents: Uint8Array) => Promise<void>,
	ensureDir: (path: string) => Promise<void>,
	reveal: (folderName: string) => Promise<void>,
): Promise<void> {
	const files = await pickFolder();
	if (files.length === 0) { return; }

	// folder name comes from the first file's webkitRelativePath
	const rootName = (files[0] as any).webkitRelativePath?.split('/')[0] || 'uploaded-folder';
	const relPath = (f: File) => ((f as any).webkitRelativePath || f.name).split('/').slice(1).join('/');

	const valid = files.filter((f: File) => {
		const p = relPath(f);
		if (!p) { return false; }
		return !p.split('/').some((seg: string) => IGNORE_DIRS.has(seg));
	});

	if (valid.length === 0) {
		vscode.window.showWarningMessage('No importable files found (everything was filtered out).');
		return;
	}

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: `Uploading ${rootName}`,
		cancellable: true,
	}, async (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => {
		const dirs = new Set<string>();
		let uploaded = 0, skipped = 0;
		for (const file of valid) {
			if (token.isCancellationRequested) { break; }
			const rel = relPath(file);
			if (file.size > MAX_FILE_KB * 1024) { skipped++; continue; }

			const dir = rel.split('/').slice(0, -1).join('/');
			if (dir && !dirs.has(dir)) {
				await ensureDir(dir);
				dirs.add(dir);
			}
			const buf = new Uint8Array(await file.arrayBuffer());
			await writeFile(rel, buf);
			uploaded++;
			if (uploaded % 25 === 0) { progress.report({ message: `${uploaded}/${valid.length} files` }); }
		}
		await reveal(rootName);
		vscode.window.showInformationMessage(`Uploaded ${uploaded} files${skipped ? ` (${skipped} skipped: oversized)` : ''} to the workspace.`);
	});
}
