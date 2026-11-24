/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { bootContainer, getContainer, isCrossOriginIsolated, type NodineContainer } from './nodine';
import { NodineFileSystemProvider, openNodineWorkspace } from './fsProvider';
import { createDevTerminal } from './terminal';
import { importFromGithub } from './githubImport';
import { uploadFolder } from './folderUpload';

/** A pseudoterminal that runs one command (`node <file>`) and exits. */
class RunOnceTerminal implements vscode.Pseudoterminal {
	private writeEmitter = new vscode.EventEmitter<string>();
	onDidWrite: vscode.Event<string> = this.writeEmitter.event;
	private closeEmitter = new vscode.EventEmitter<number>();
	onDidClose: vscode.Event<number> = this.closeEmitter.event;

	constructor(private readonly container: NodineContainer, private readonly relPath: string) { }

	async open(): Promise<void> {
		try {
			const proc = await this.container.spawn('node', [this.relPath], {
				cwd: this.container.workdir,
				env: this.container.baseEnv,
			});
			if (proc.output) {
				const reader = proc.output.getReader();
				(async () => {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) { break; }
						this.writeEmitter.fire(value);
					}
				})();
			}
			const code = await proc.exit;
			this.writeEmitter.fire(`\r\n\x1b[90mexited with code ${code}\x1b[0m\r\n`);
		} catch (err) {
			this.writeEmitter.fire(`\r\n\x1b[31m${err}\x1b[0m\r\n`);
		}
		this.closeEmitter.fire(0);
	}

	handleInput(): void { /* no interactive input */ }
	close(): void { /* nothing to clean up */ }
}

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
	const config = vscode.workspace.getConfiguration('webide-dev');
	const runtimeUrl = config.get<string>('runtimeUrl', '/nodine/supervisor.mjs');

	// LAZY BOOT: nothing happens on startup. The runtime boots on the first
	// command that needs it — Create Dev Terminal, Import from GitHub or
	// Upload Folder. A fresh start shows the plain welcome page, no
	// "untitled (nodine)" workspace, no boot toast.
	let readyPromise: Promise<NodineContainer | null> | null = null;

	const ensureRuntime = (): Promise<NodineContainer | null> => {
		if (!readyPromise) {
			readyPromise = (async () => {
				if (!isCrossOriginIsolated()) {
					vscode.window.showErrorMessage(
						'Dev environment needs a cross-origin isolated host: the server must send ' +
						'Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless headers.');
					return null;
				}
				try {
					const container = await bootContainer(runtimeUrl);
					// Register the nodine: provider; the workspace folder is only
					// added on demand (adding it from an empty workspace would
					// reload the window and destroy the in-memory container).
					const provider = new NodineFileSystemProvider(container);
					_context.subscriptions.push(vscode.workspace.registerFileSystemProvider('nodine', provider, { isCaseSensitive: true }));
					return container;
				} catch (err) {
					console.error('[webide-dev] runtime boot failed:', err);
					readyPromise = null; // allow retry on next command
					vscode.window.showErrorMessage(`Dev environment boot failed: ${err instanceof Error ? err.message : err}`);
					return null;
				}
			})();
		}
		return readyPromise;
	};

	// Adds the nodine: workspace folder exactly once, on demand (import /
	// upload completion). Accepts the window reload this causes on web: at
	// that point the files were written to the container and the user is
	// done — the reloaded window opens the (fresh) nodine workspace.
	const openNodineWorkspaceOnce = async (): Promise<void> => {
		const existing = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'nodine');
		if (existing) { return; }
		await openNodineWorkspace(await ensureRuntime() as NodineContainer);
	};

	const getFs = async (): Promise<{ writeFile: (p: string, c: Uint8Array) => Promise<void>; ensureDir: (path: string) => Promise<void> } | null> => {
		const container = await ensureRuntime();
		if (!container) { return null; }
		return {
			writeFile: async (p, contents) => {
				const dir = p.split('/').slice(0, -1).join('/');
				if (dir) { await container.fs.mkdir(`${container.workdir}/${dir}`, { recursive: true }).catch(() => { }); }
				await container.fs.writeFile(`${container.workdir}/${p}`, contents);
			},
			ensureDir: async (p) => {
				await container.fs.mkdir(`${container.workdir}/${p}`, { recursive: true }).catch(() => { });
			},
		};
	};

	const reveal = async (_folderName: string) => {
		// expand the workspace in the explorer and focus it
		await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.parse('nodine:/'));
		vscode.commands.executeCommand('workbench.view.explorer');
	};

	// bolt.diy-style two-step ask: repo link, then optional PAT (private repos
	// + rate limits). Collected BEFORE the container boot so the user never
	// waits on a silent prompt.
	const collectGithubInputs = async (): Promise<{ repoInput: string; tokenInput: string } | null> => {
		const repoInput = await vscode.window.showInputBox({
			prompt: 'GitHub repository — paste the URL or owner/repo',
			placeHolder: 'https://github.com/owner/repo (add #branch for a specific branch)',
			ignoreFocusOut: true,
		});
		if (!repoInput) { return null; }
		const tokenInput = await vscode.window.showInputBox({
			prompt: 'GitHub PAT — optional for public repos, required for private repos',
			placeHolder: 'github_pat_… or ghp_… (kept for this session only, empty for public)',
			password: true,
			ignoreFocusOut: true,
		});
		if (tokenInput === undefined) { return null; }
		return { repoInput, tokenInput };
	};

	_context.subscriptions.push(
		vscode.commands.registerCommand('webide-dev.createTerminal', () => {
			createDevTerminal(_context);
		}),

		vscode.commands.registerCommand('webide-dev.importGithub', async () => {
			// Ask for input FIRST (the boot takes ~40s; asking first means no
			// silent wait), then boot + import.
			const inputs = await collectGithubInputs();
			if (!inputs) { return; }
			const fs = await getFs();
			if (!fs) {
				vscode.window.showErrorMessage('Dev environment is not running (needs cross-origin isolated host with the nodine runtime).');
				return;
			}
			await importFromGithub(inputs, fs.writeFile, fs.ensureDir, async (name) => {
				// reveal: switch to the nodine workspace (accepts one reload)
				await openNodineWorkspaceOnce();
				await reveal(name);
			});
		}),

		vscode.commands.registerCommand('webide-dev.uploadFolder', async () => {
			const fs = await getFs();
			if (!fs) {
				vscode.window.showErrorMessage('Dev environment is not running (needs cross-origin isolated host with the nodine runtime).');
				return;
			}
			await uploadFolder(fs.writeFile, fs.ensureDir, async (name) => {
				await openNodineWorkspaceOnce();
				await reveal(name);
			});
		}),

		vscode.commands.registerCommand('webide-dev.runFile', async (uri?: vscode.Uri) => {
			const target = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!target || target.scheme !== 'nodine') {
				vscode.window.showErrorMessage('Open a file from the nodine workspace to run it.');
				return;
			}
			const container = getContainer();
			if (!container) { return; }
			// Run `node <file>` in a dedicated streaming terminal.
			const rel = target.path.replace(/^\/+/, '');
			const terminal = vscode.window.createTerminal({ name: `node ${rel}`, pty: new RunOnceTerminal(container, rel) });
			_context.subscriptions.push(terminal);
			terminal.show();
		}),

		vscode.commands.registerCommand('webide-dev.previewPort', async () => {
			const container = getContainer();
			if (!container) { return; }
			const portStr = await vscode.window.showInputBox({ prompt: 'Port number', placeHolder: '3000' });
			const port = Number(portStr);
			if (!Number.isFinite(port)) { return; }
			const url = container.previewUrl(port);
			await vscode.env.openExternal(vscode.Uri.parse(url));
		}),
	);
}
