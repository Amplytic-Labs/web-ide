/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { bootContainer, getContainer, isCrossOriginIsolated, type NodineContainer } from './nodine';
import { NodineFileSystemProvider, nodineRoot, openNodineWorkspace } from './fsProvider';
import { createDevTerminal, focusDevTerminal, NodineProfileProvider, setAfterCommandHook, getHookFireCount } from './terminal';
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

/** Where the uploaded / imported project lives inside the container. */
export let projectCwd: string | null = null;

export function setProjectCwd(p: string): void {
	projectCwd = p;
}

export function getProjectCwd(): string | null {
	return projectCwd;
}

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
	// Context key: true while no nodine project is loaded — drives the
	// explorer "Dev Environment" welcome view visibility.
	const syncNoProject = () => {
		const loaded = vscode.workspace.workspaceFolders?.some(f => f.uri.scheme === 'nodine') ?? false;
		vscode.commands.executeCommand('setContext', 'webide-dev.noProject', !loaded);
	};
	syncNoProject();
	_context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(syncNoProject));

	// The "Dev Environment" tree view: always empty, so its viewsWelcome
	// content (Upload / Import / Terminal buttons) is always rendered.
	const tree = vscode.window.createTreeView('webide-dev.welcome', {
		treeDataProvider: {
			getChildren: () => [],
			getTreeItem: () => ({ label: '' } as vscode.TreeItem),
		},
	});
	_context.subscriptions.push(tree);
	// expand the section on first activation so the action buttons are visible
	tree.description = 'Upload · Import · Terminal';
	// focusing the view also expands its section (fresh profiles collapse it)
	setTimeout(() => { vscode.commands.executeCommand('webide-dev.welcome.focus').then(() => undefined, () => undefined); }, 1500);

	const config = vscode.workspace.getConfiguration('webide-dev');
	const runtimeUrl = config.get<string>('runtimeUrl', '/nodine/supervisor.mjs');

	// Runtime boot singleton. BOLT.DIY-STYLE EAGER BOOT: bolt.diy boots the
	// WebContainer in a module-level promise as soon as the client loads —
	// the environment is simply always there. Same here: the boot starts at
	// activation, not on the first command; the returned promise is the
	// handle everything else hangs off.
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
					return await bootContainer(runtimeUrl);
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

	// start the boot NOW (activation time) — do not await
	const runtimeReady = ensureRuntime();

	// BOLT.DIY-STYLE FS WIRING: register the nodine: provider SYNCHRONOUSLY,
	// bound to a lazy container reference. Every nodine:/ request that lands
	// during the boot window (workspace-folder restore on reload, snippets
	// service, explorer refresh…) now WAITS for the container instead of
	// failing with ENOPRO / "no file system provider found for nodine:/".
	// bolt.diy never has this class of bug because the container FS is the
	// only FS and it exists from app start; this is the VS Code equivalent.
	const provider = new NodineFileSystemProvider(async () => {
		await runtimeReady;
		return getContainer();
	});
	let providerRegistered = false;
	_context.subscriptions.push(vscode.workspace.registerFileSystemProvider('nodine', provider, { isCaseSensitive: true }));
	providerRegistered = true;

	// One-time Explorer kick: the workbench queries the workspace root during
	// boot, which can land BEFORE the container is up (the provider waits for
	// it, but the tree may cache the empty/error state). A Created event on a
	// synthetic child once the runtime is ready makes the tree re-read the
	// root listing — same mechanism as the afterCommand hook below.
	runtimeReady.then(() => {
		provider.fireExternalChange(vscode.FileChangeType.Created, '/.nodine-sync');
	}).catch(() => { /* boot failed — error already surfaced */ });

	// The runtime has no fs.watch yet (kernel milestone M4) — terminal-side
	// FS writes (mkdir/rm/node -e/npm) would never reach the Explorer. Fire a
	// root + cwd listing-changed signal after every terminal command instead.
	setAfterCommandHook(() => {
		// The runtime has no fs.watch (kernel milestone M4) and there is no
		// explorer-refresh command in this build. A Created event on a
		// synthetic child makes the tree re-read the ROOT listing (the tree
		// refreshes the PARENT of every Created/Deleted uri), so terminal
		// mkdir/rm/node -e/npm writes show up live. Changed events do NOT
		// refresh listings (they only update open editors).
		provider.fireExternalChange(vscode.FileChangeType.Created, '/.nodine-sync');
	});

	// Upload / GitHub import write the project at the CONTAINER ROOT
	// (/<folderName>, not nested in the workdir), so after upload the
	// workspace root IS the project — exactly like WebContainer's mount().
	// The explorer maps nodine:/ → container /.
	const getFs = async (): Promise<{ writeFile: (p: string, c: Uint8Array) => Promise<void>; ensureDir: (path: string) => Promise<void> } | null> => {
		const container = await ensureRuntime();
		if (!container) { return null; }
		// bolt.diy-style: every write is announced to the workbench through the
		// provider's change events — the Explorer tree (and open editors) react
		// to FS changes instead of showing a cached listing.
		const fire = (type: vscode.FileChangeType, p: string) =>
			provider.fireExternalChange(type, `/${p}`);
		return {
			// p is a project-relative path ("<folderName>/src/a.js"); write it
			// at the container root: /<folderName>/src/a.js
			writeFile: async (p, contents) => {
				const dir = p.split('/').slice(0, -1).join('/');
				if (dir) {
					try {
						await container.fs.mkdir(`/${dir}`, { recursive: true });
						fire(vscode.FileChangeType.Created, dir);
					} catch { /* already existed */ }
				}
				await container.fs.writeFile(`/${p}`, contents);
				fire(vscode.FileChangeType.Changed, p);
				// parent listing changed — re-read signal (root included)
				fire(vscode.FileChangeType.Changed, dir);
			},
			ensureDir: async (p) => {
				try {
					await container.fs.mkdir(`/${p}`, { recursive: true });
					fire(vscode.FileChangeType.Created, p);
				} catch { /* already existed */ }
			},
		};
	};

	// Like getFs() but throws a readable error instead of returning null —
	// used inside uploadFolder's progress block after the pick succeeded.
	const requireFs = async () => {
		const fs = await getFs();
		if (!fs) { throw new Error('Dev environment is not running (needs cross-origin isolated host with the nodine runtime).'); }
		return fs;
	};

	// Test hook (headless E2E): simulates Upload Folder's post-copy path
	// without the native picker — writes a small project into the container
	// and runs projectReady(). Not exposed in any menu; `_`-prefixed
	// commands are hidden from the palette by VS Code convention. Reached
	// through globalThis from the extension-host iframe.
	const simulateUpload = async (folderName: string): Promise<string> => {
		const fs = await getFs();
		if (!fs) { return 'no-runtime'; }
		await fs.ensureDir(folderName);
		await fs.writeFile(`${folderName}/package.json`, new TextEncoder().encode(
			JSON.stringify({ name: folderName, version: '1.0.0', scripts: { start: 'node index.js' } }, null, 2)));
		await fs.writeFile(`${folderName}/index.js`, new TextEncoder().encode('console.log("hello from ' + folderName + '");\n'));
		await projectReady(folderName);
		return 'ok';
	};
	vscode.commands.registerCommand('webide-dev._simulateUpload', simulateUpload);
	// headless E2E state probe: workspace folders + provider health from the
	// extension host worker itself (reached via page.workers() in tests)
	(globalThis as Record<string, unknown>).__webideDevTest = {
		simulateUpload,
		provider,
		state: async () => ({
			activated: true,
			providerRegistered: providerRegistered,
			watchCalls: provider.watchCalls,
			hookFired: getHookFireCount(),
			activationEvents: vscode.extensions.getExtension('amplytic.webide-dev')?.packageJSON?.activationEvents ?? null,
			folders: (vscode.workspace.workspaceFolders ?? []).map(f => ({ uri: f.uri.toString(), name: f.name })),
			readdirViaFs: await (async () => {
				try {
					const ents = await vscode.workspace.fs.readDirectory(nodineRoot());
					return ents.map(([n, t]) => n + (t === vscode.FileType.Directory ? '/' : '')).join(',');
				} catch (e) { return 'ERR:' + String(e).slice(0, 90); }
			})(),
			readdirRoot: await (async () => {
				try {
					const c = await ensureRuntime();
					return c ? (await c.fs.readdir('/')).join(',') : 'no-container';
				} catch (e) { return 'err:' + String(e).slice(0, 80); }
			})(),
		}),
	};

	// Adds the nodine: workspace folder exactly once (import / upload
	// completion, and the startup path below). Normally unnecessary: the
	// workbench boots straight into the nodine:/ folder (folderUri in the
	// web configuration), so the folder is already present. Kept as a
	// fallback for odd states (e.g. an empty untitled workspace).
	const openNodineWorkspaceOnce = async (): Promise<void> => {
		const existing = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'nodine');
		if (existing) { return; }
		await openNodineWorkspace();
	};

	/**
	 * Folder settings: hide the runtime's pre-created system directories
	 * (bin/home/project/root/tmp/usr) so the Nodine root is CLEAN — like
	 * C:\ — and users see (and create) their own folders. The runtime still
	 * uses those dirs; this only affects the Explorer/search. Written once;
	 * existing settings are never clobbered.
	 */
	const seedExplorerSettings = async (): Promise<void> => {
		const settingsUri = vscode.Uri.joinPath(nodineRoot(), '.vscode/settings.json');
		try {
			await vscode.workspace.fs.readFile(settingsUri);
			return; // settings already exist — don't clobber
		} catch { /* missing → seed */ }
		const payload = JSON.stringify({
			'files.exclude': {
				'bin': true,
				'home': true,
				'project': true,
				'root': true,
				'tmp': true,
				'usr': true,
				'.vscode': true,
			},
		}, null, 2);
		await vscode.workspace.fs.writeFile(settingsUri, new TextEncoder().encode(payload + '\n'));
	};

	const reveal = async (_folderName: string) => {
		// expand the workspace in the explorer and focus it
		await vscode.commands.executeCommand('revealInExplorer', nodineRoot());
		// nudge the tree to re-read the root listing (synthetic child event —
		// there is no explorer-refresh command in this build)
		provider.fireExternalChange(vscode.FileChangeType.Created, '/.nodine-sync');
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

	// The post-import / post-upload sequence: make the project the workspace
	// root (live, no reload), auto-open the dev terminal booted INTO that
	// folder, and reveal it in the explorer.
	const projectReady = async (folderName: string): Promise<void> => {
		setProjectCwd(`/${folderName}`);
		await openNodineWorkspaceOnce();
		await focusDevTerminal(_context);   // boots (if needed) + shows + cds
		await reveal(folderName);
	};

	// AUTO WORKSPACE + AUTO TERMINAL (bolt.diy behavior): as soon as the
	// container is up, open the nodine workspace so the explorer resolves
	// immediately, and create the dev terminal automatically — the user
	// never opens a workbench with a dead FS or no shell.
	runtimeReady.then(async (container) => {
		if (!container) { return; }
		try {
			await openNodineWorkspaceOnce();
			syncNoProject();

			// clean Nodine root: hide the runtime's pre-created system dirs
			await seedExplorerSettings();

			// Make the Nodine profile the DEFAULT terminal — AFTER the workspace
			// exists (a Workspace-target update with no open workspace fails with
			// "no workspace is opened"). Without a default, the workbench's
			// generic terminal creation has no profile to use (no local process
			// support in a static web build) and silently does nothing; with it,
			// +, Ctrl+` and palette creation all route to the nodine pty.
			const setDefaultProfile = (target: vscode.ConfigurationTarget) =>
				Promise.allSettled([
					vscode.workspace.getConfiguration('terminal.integrated').update('defaultProfile.linux', 'Nodine (Node.js)', target),
					vscode.workspace.getConfiguration('terminal.integrated').update('defaultProfile.osx', 'Nodine (Node.js)', target),
				]);
			void setDefaultProfile(vscode.ConfigurationTarget.Workspace).then(results => {
				const failed = results.some(r => r.status === 'rejected');
				if (failed) {
					// empty/failed workspace write → user-level default instead
					void setDefaultProfile(vscode.ConfigurationTarget.Global);
				}
			});

			// the terminal initiates automatically (skipped if one already exists)
			await focusDevTerminal(_context);
		} catch (err) {
			console.error('[webide-dev] auto workspace/terminal failed:', err);
		}
	});

	_context.subscriptions.push(
		vscode.commands.registerCommand('webide-dev.createTerminal', () => {
			createDevTerminal(_context);
		}),

		// Terminal-profile entry point: invoked by the workbench whenever a
		// DEFAULT terminal is created (the + button, Ctrl+`, menu) because
		// this profile is the only shell in the static web build — no local
		// process support exists. Falls through to the same nodine-backed
		// pseudoterminal the "Create Dev Terminal" command uses.
		vscode.commands.registerCommand('webide-dev.createNodineTerminal', () => {
			return focusDevTerminal(_context);
		}),

		// The profile PROVIDER: without this registration the manifest's
		// terminal profile shows in the picker but cannot create terminals.
		// The workbench creates default terminals from the returned profile
		// (which carries our nodine-backed pty).
		vscode.window.registerTerminalProfileProvider('webide-dev.nodine', new NodineProfileProvider(runtimeUrl)),

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
			await importFromGithub(inputs, fs.writeFile, fs.ensureDir, projectReady);
		}),

		vscode.commands.registerCommand('webide-dev.uploadFolder', async () => {
			// The picker runs FIRST (its native dialog needs the live user
			// activation from this click); the runtime boots after the pick,
			// inside the progress notification. Booting first let the
			// activation expire and the picker fail silently.
			await uploadFolder(
				async (p, c) => (await requireFs()).writeFile(p, c),
				async (p) => (await requireFs()).ensureDir(p),
				projectReady,
				async () => { await requireFs(); },
			);
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
