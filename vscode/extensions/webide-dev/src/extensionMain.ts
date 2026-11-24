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

	// Commands work without the runtime booted; the FS provider and terminal
	// boot it lazily on first use. But auto-boot on startup makes the workspace
	// appear immediately — do it quietly in the background.
	const readyPromise: Promise<NodineContainer | null> = (async () => {
		if (!isCrossOriginIsolated()) {
			return null; // host without COOP/COEP; features degrade gracefully
		}
		try {
			const container = await bootContainer(runtimeUrl);
			const provider = new NodineFileSystemProvider(container);
			_context.subscriptions.push(vscode.workspace.registerFileSystemProvider('nodine', provider, { isCaseSensitive: true }));
			await openNodineWorkspace(container);
			return container;
		} catch (err) {
			console.error('[webide-dev] runtime boot failed:', err);
			vscode.window.showWarningMessage(`Dev environment boot failed: ${err instanceof Error ? err.message : err}. Terminal and imports are unavailable.`);
			return null;
		}
	})();

	const getFs = async (): Promise<{ writeFile: (p: string, c: Uint8Array) => Promise<void>; ensureDir: (p: string) => Promise<void> } | null> => {
		const container = await readyPromise;
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

	_context.subscriptions.push(
		vscode.commands.registerCommand('webide-dev.createTerminal', () => {
			createDevTerminal(_context);
		}),

		vscode.commands.registerCommand('webide-dev.importGithub', async () => {
			const fs = await getFs();
			if (!fs) {
				vscode.window.showErrorMessage('Dev environment is not running (needs cross-origin isolated host with the nodine runtime).');
				return;
			}
			await importFromGithub(fs.writeFile, fs.ensureDir, reveal);
		}),

		vscode.commands.registerCommand('webide-dev.uploadFolder', async () => {
			const fs = await getFs();
			if (!fs) {
				vscode.window.showErrorMessage('Dev environment is not running (needs cross-origin isolated host with the nodine runtime).');
				return;
			}
			await uploadFolder(fs.writeFile, fs.ensureDir, reveal);
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
