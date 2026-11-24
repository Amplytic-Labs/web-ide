/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

/**
 * Import from GitHub without any server-side proxy:
 *  1. GET https://api.github.com/repos/{owner}/{repo}/zipball/{ref} (302 → codeload, CORS OK)
 *  2. parse the zip central directory in the browser
 *  3. inflate entries (deflate via DecompressionStream)
 *  4. write files into the nodine container FS; the Explorer shows them through
 *     the nodine FileSystemProvider.
 *
 * Public repos work anonymously (GitHub API: 60 req/hr per IP). v0.1 has no
 * accounts by design; a PAT prompt could be added later for private repos.
 */

const IGNORE_DIRS = new Set([
	'node_modules', '.git', '.github', '.vscode', 'dist', 'build', '.next',
	'.cache', 'coverage', '.idea', '.turbo', 'out', '.parcel-cache',
]);

export function parseRepoInput(input: string): { owner: string; repo: string; ref?: string } | null {
	input = input.trim().replace(/\.git$/, '');
	let ref: string | undefined;
	const hash = input.match(/#([\w./-]+)$/);
	if (hash) {
		ref = hash[1];
		input = input.slice(0, hash.index);
	}
	let m = input.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w./-]+))?/i);
	if (m) { return { owner: m[1], repo: m[2], ref: m[3] || ref }; }
	m = input.match(/^([\w.-]+)\/([\w.-]+)$/);
	if (m) { return { owner: m[1], repo: m[2], ref }; }
	return null;
}

interface ZipEntry {
	name: string;
	isDir: boolean;
	method: number;
	data: Uint8Array; // compressed bytes (or stored bytes when method=0)
}

/** Parse a zip buffer's central directory into entries. */
function parseZip(buf: Uint8Array): ZipEntry[] {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const td = new TextDecoder();

	// find End of Central Directory
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
		if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd < 0) { throw new Error('not a zip file'); }

	let count = dv.getUint16(eocd + 10, true);
	let ptr = dv.getUint32(eocd + 16, true);
	const entries: ZipEntry[] = [];

	while (count-- > 0 && dv.getUint32(ptr, true) === 0x02014b50) {
		const method = dv.getUint16(ptr + 10, true);
		const compSize = dv.getUint32(ptr + 20, true);
		const nameLen = dv.getUint16(ptr + 28, true);
		const extraLen = dv.getUint16(ptr + 30, true);
		const commentLen = dv.getUint16(ptr + 32, true);
		const localOff = dv.getUint32(ptr + 42, true);
		const name = td.decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));
		ptr += 46 + nameLen + extraLen + commentLen;

		if (name.endsWith('/')) {
			entries.push({ name, isDir: true, method: 0, data: new Uint8Array(0) });
			continue;
		}

		// local file header: 30 bytes + name + extra → data
		const lNameLen = dv.getUint16(localOff + 26, true);
		const lExtraLen = dv.getUint16(localOff + 28, true);
		const start = localOff + 30 + lNameLen + lExtraLen;
		entries.push({
			name,
			isDir: false,
			method,
			data: buf.subarray(start, start + compSize),
		});
	}
	return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const ds = new DecompressionStream('deflate-raw' as CompressionFormat);
	const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function importFromGithub(
	writeFile: (path: string, contents: Uint8Array) => Promise<void>,
	ensureDir: (path: string) => Promise<void>,
	reveal: (folderName: string) => Promise<void>,
): Promise<void> {
	const input = await vscode.window.showInputBox({
		prompt: 'GitHub repository (owner/repo, full URL, or URL#branch)',
		placeHolder: 'e.g. expressjs/express',
		ignoreFocusOut: true,
	});
	if (!input) { return; }

	const parsed = parseRepoInput(input);
	if (!parsed) {
		vscode.window.showErrorMessage(`Not a GitHub repository: ${input}`);
		return;
	}
	const { owner, repo, ref } = parsed;
	const maxKb = vscode.workspace.getConfiguration('webide-dev').get<number>('githubMaxFileKb', 512);

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: `Importing ${owner}/${repo}${ref ? `#${ref}` : ''}`,
		cancellable: false,
	}, async progress => {
		try {
			progress.report({ message: 'downloading zipball…' });
			const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/zipball/${ref ?? ''}`, {
				headers: { Accept: 'application/vnd.github+json' },
				redirect: 'follow',
			});
			if (res.status === 404) { throw new Error('repo or ref not found (404)'); }
			if (res.status === 403) { throw new Error('GitHub anonymous rate limit (60/hr). Try later.'); }
			if (!res.ok) { throw new Error(`GitHub returned HTTP ${res.status}`); }

			const zipBuf = new Uint8Array(await res.arrayBuffer());
			progress.report({ message: `parsing (${(zipBuf.length / 1048576).toFixed(1)} MB zip)` });

			const entries = parseZip(zipBuf);
			const dirs = new Set<string>();
			let imported = 0, skipped = 0;

			for (const entry of entries) {
				// zipball prefixes every path with "owner-repo-sha/"
				const rel = entry.name.split('/').slice(1).join('/');
				if (!rel) { continue; }

				const segs = rel.split('/');
				if (segs.some(s => IGNORE_DIRS.has(s))) { skipped++; continue; }
				if (entry.isDir) { dirs.add(rel); continue; }
				if (entry.method !== 0 && entry.method !== 8) { skipped++; continue; }
				if (entry.data.length > maxKb * 1024) { skipped++; continue; }

				const dir = segs.slice(0, -1).join('/');
				if (dir && !dirs.has(dir)) {
					await ensureDir(dir);
					dirs.add(dir);
				}

				const contents = entry.method === 8 ? await inflateRaw(entry.data) : entry.data;
				await writeFile(rel, contents);
				imported++;
				if (imported % 25 === 0) { progress.report({ message: `${imported} files…` }); }
			}

			await reveal(`${owner}-${repo}`);
			vscode.window.showInformationMessage(
				`Imported ${imported} files from ${owner}/${repo}` +
				(skipped ? ` — skipped ${skipped} (node_modules/build dirs, oversized, or unsupported)` : '') + '.'
			);
		} catch (err) {
			vscode.window.showErrorMessage(`GitHub import failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
}
