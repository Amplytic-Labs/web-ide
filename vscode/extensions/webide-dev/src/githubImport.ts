/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

/**
 * Import from GitHub without any server-side proxy, using ONLY endpoints that
 * send `access-control-allow-origin: *` (so the fetches work from any static
 * origin, including under COEP: credentialless):
 *
 *  1. GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1  (file list)
 *  2. GET /repos/{owner}/{repo}/git/blobs/{sha}              (file content, base64)
 *  3. write files into the nodine container FS; the Explorer shows them through
 *     the nodine FileSystemProvider.
 *
 * The zipball route is NOT used: api.github.com 302-redirects to
 * codeload.github.com, which sends no CORS headers — impossible to read from
 * a browser on another origin.
 *
 * bolt.diy-style UI: quick-input flow asking for the repo link first, then
 * (optionally) a PAT — needed for private repos and to lift the 60/hr
 * anonymous rate limit. The PAT is kept for the session only, never persisted.
 *
 * bolt.diy-style ignore rules: node_modules and friends are NEVER imported.
 */

// gitignore-style ignore list (same spirit as bolt.diy's IGNORE_PATTERNS)
const IGNORE_SEGMENTS = new Set([
	'node_modules', '.git', '.github', '.vscode', 'dist', 'build', '.next',
	'.turbo', '.cache', 'coverage', '.idea', 'out', '.parcel-cache', 'target',
]);
const IGNORE_EXTENSIONS = new Set(['.log', '.map']);
const ALWAYS_ALLOW = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']); // lock files are big but useful
const MAX_FILES = 1000;          // bolt.diy's limit
const MAX_FILE_KB_DEFAULT = 512;

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

function shouldInclude(path: string): boolean {
	const name = path.split('/').pop() || '';
	if (ALWAYS_ALLOW.has(name)) { return true; }
	if (path.split('/').some(seg => IGNORE_SEGMENTS.has(seg))) { return false; }
	const dot = path.lastIndexOf('.');
	if (dot >= 0 && IGNORE_EXTENSIONS.has(path.slice(dot))) { return false; }
	return true;
}

interface TreeNode {
	path: string;
	type: 'blob' | 'tree';
	sha: string;
	size?: number;
}

async function ghApi(path: string, token: string | undefined): Promise<any> {
	const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
	if (token) { headers.Authorization = `Bearer ${token}`; }
	const res = await fetch(`https://api.github.com${path}`, { headers });
	if (res.status === 404) { throw new Error('repo, ref or path not found (404) — check the URL' + (token ? '' : ' and whether the repo is private (a token is needed for that)')); }
	if (res.status === 401) { throw new Error('GitHub rejected the token (401).'); }
	if (res.status === 403) {
		const body = await res.json().catch(() => ({} as any));
		if (body?.message?.includes('rate limit')) {
			throw new Error('GitHub rate limit exceeded. Provide a PAT (raises it to 5000/hr).');
		}
		throw new Error(String(body?.message || 'HTTP 403 (forbidden — private repo? a token is needed)'));
	}
	if (!res.ok) { throw new Error(`GitHub returned HTTP ${res.status}`); }
	return res.json();
}

/** Session-only PAT cache — asked once per session at most, never persisted. */
let sessionToken: string | undefined;

export async function importFromGithub(
	inputs: { repoInput: string; tokenInput: string },
	writeFile: (path: string, contents: Uint8Array) => Promise<void>,
	ensureDir: (path: string) => Promise<void>,
	reveal: (folderName: string) => Promise<void>,
): Promise<void> {
	const { repoInput, tokenInput } = inputs;
	const parsed = parseRepoInput(repoInput);
	if (!parsed) {
		vscode.window.showErrorMessage(`Not a GitHub repository: ${repoInput}`);
		return;
	}
	const { owner, repo, ref } = parsed;
	const token = tokenInput.trim() || sessionToken;

	const maxKb = vscode.workspace.getConfiguration('webide-dev').get<number>('githubMaxFileKb', MAX_FILE_KB_DEFAULT);

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: `Importing ${owner}/${repo}${ref ? `#${ref}` : ''}`,
		cancellable: false,
	}, async progress => {
		try {
			// resolve ref → commit sha
			progress.report({ message: 'resolving ref…' });
			let sha: string;
			if (ref && /^[0-9a-f]{40}$/i.test(ref)) {
				sha = ref;
			} else {
				const commit = await ghApi(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref ?? 'HEAD')}`, token);
				sha = commit.sha;
			}
			if (tokenInput.trim()) { sessionToken = tokenInput.trim(); }

			// full recursive tree
			progress.report({ message: 'listing files…' });
			const tree = await ghApi(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, token);
			if (tree.truncated) {
				vscode.window.showWarningMessage('Repo tree truncated by GitHub (very large repo) — importing a subset.');
			}
			const blobs = (tree.tree as TreeNode[]).filter(n =>
				n.type === 'blob' && shouldInclude(n.path) && (n.size ?? 0) <= maxKb * 1024);
			if (blobs.length > MAX_FILES) {
				vscode.window.showWarningMessage(`Repo has ${blobs.length} importable files — importing the first ${MAX_FILES} (large-repo cap).`);
			}
			const queue = blobs.slice(0, MAX_FILES);

			const dirs = new Set<string>();
			let imported = 0, failed = 0;
			let done = 0;

			// bounded-concurrency blob fetch (batched, like bolt.diy)
			const BATCH = 6;
			const workers = Array.from({ length: BATCH }, async () => {
				for (;;) {
					const node = queue.shift();
					if (!node) { return; }
					try {
						const blob = await ghApi(`/repos/${owner}/${repo}/git/blobs/${node.sha}`, token);
						const contents: Uint8Array = blob.encoding === 'base64'
							? base64ToBytes(blob.content)
							: new TextEncoder().encode(blob.content);
						// land files inside <owner>-<repo>/ (same convention as
						// Upload Folder and projectReady), NOT at the container root
						const dir = node.path.split('/').slice(0, -1).join('/');
						const destDir = dir ? `${owner}-${repo}/${dir}` : `${owner}-${repo}`;
						if (!dirs.has(destDir)) {
							await ensureDir(destDir);
							dirs.add(destDir);
						}
						await writeFile(`${owner}-${repo}/${node.path}`, contents);
						imported++;
					} catch (err) {
						failed++;
						console.warn(`[webide-dev] blob fetch failed for ${node.path}:`, err);
					}
					done++;
					const total = Math.min(blobs.length, MAX_FILES);
					if (done % (total < 50 ? 1 : 10) === 0 || done === total) {
						const pct = total > 0 ? Math.round((done / total) * 100) : 100;
						progress.report({ message: `${done}/${total} files · ${pct}%`, increment: 100 / total });
					}
				}
			});
			await Promise.all(workers);

			await reveal(`${owner}-${repo}`);
			vscode.window.showInformationMessage(
				`Imported ${imported} files from ${owner}/${repo}` +
				(failed ? ` — ${failed} failed` : '') + '. node_modules and build artifacts were skipped.');
		} catch (err) {
			vscode.window.showErrorMessage(`GitHub import failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64.replace(/\n/g, ''));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
	return bytes;
}
