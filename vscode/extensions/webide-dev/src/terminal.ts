/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { bootContainer, type NodineContainer, type ContainerProcess } from './nodine';
import { getProjectCwd } from './extensionMain';

/**
 * A VS Code pseudoterminal backed by the nodine runtime.
 *
 * nodine runs one process per spawn (no interactive shell yet — the kernel
 * has no PTY/REPL), so this terminal is line-based: each submitted line is
 * tokenized and run as a real process (`node -e`, `npm install`, …) with
 * output streamed back, then a fresh prompt appears.
 */

class NodineTerminal implements vscode.Pseudoterminal {
	private writeEmitter = new vscode.EventEmitter<string>();
	onDidWrite: vscode.Event<string> = this.writeEmitter.event;

	private closeEmitter = new vscode.EventEmitter<number>();
	onDidClose: vscode.Event<number> = this.closeEmitter.event;

	private container: NodineContainer | null = null;
	private current: ContainerProcess | null = null;
	private inputWriter: WritableStreamDefaultWriter<string> | null = null;
	private buffer = '';
	private running = false;
	/** cwd for spawned commands — the project folder once one is uploaded. */
	private cwd: string | null = null;

	constructor(private readonly runtimeUrl: string) { }

	/** Point the shell at a project folder (e.g. "/my-app"). */
	cd(path: string): void {
		this.cwd = path;
		this.writeEmitter.fire(`\x1b[90mcd ${path}\x1b[0m\r\n`);
		this.prompt();
	}

	/** Absolute directory commands run in: project folder if set, else workdir. */
	private resolveCwd(container: NodineContainer): string {
		return this.cwd ?? container.workdir;
	}

	async open(_initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
		this.writeEmitter.fire('Booting dev environment (nodine: real Node.js in your browser)…\r\n');
		try {
			this.container = await bootContainer(this.runtimeUrl);
			console.log('[webide-dev] terminal: container ready');
		} catch (err) {
			console.error('[webide-dev] runtime boot failed:', err);
			this.writeEmitter.fire(`\x1b[31mFailed to boot runtime: ${err}\x1b[0m\r\n`);
			this.writeEmitter.fire('The host must send COOP: same-origin + COEP: credentialless headers.\r\n');
			this.closeEmitter.fire(1);
			return;
		}
		const version = await this.nodeVersion();
		console.log('[webide-dev] terminal: node version =', version);
		this.writeEmitter.fire(`\x1b[32mready\x1b[0m — Node.js ${version} dev environment in ${this.resolveCwd(this.container)}\r\n`);
		this.writeEmitter.fire('Line-based shell: type JS to evaluate, or run `npm <cmd>`, `node <file>`.\r\n\r\n');
		this.prompt();
	}

	private nodeVersionCache: string | null = null;
	private async nodeVersion(): Promise<string> {
		if (this.nodeVersionCache) { return this.nodeVersionCache; }
		try {
			const proc = await this.container!.spawn('node', ['-p', 'process.version']);
			let out = '';
			const readAll = (async () => {
				if (!proc.output) { return; }
				const reader = proc.output.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) { break; }
					out += value;
				}
			})();
			// guard: never let the terminal hang on the probe
			const code = await Promise.race([
				proc.exit,
				new Promise<null>(r => setTimeout(() => r(null), 20000)),
			]);
			await Promise.race([readAll, new Promise(r => setTimeout(r, 2000))]);
			if (code === null) {
				try { await proc.kill(); } catch { /* gone */ }
				this.nodeVersionCache = '(probe timed out)';
			} else {
				this.nodeVersionCache = out.trim() || '(no output)';
			}
			console.log('[webide-dev] nodeVersion probe:', JSON.stringify(this.nodeVersionCache), 'code:', code);
		} catch (err) {
			console.error('[webide-dev] nodeVersion probe failed:', err);
			this.nodeVersionCache = '(unknown)';
		}
		return this.nodeVersionCache;
	}

	private prompt(): void {
		const where = this.cwd ?? (this.container ? this.resolveCwd(this.container) : '');
		this.writeEmitter.fire(`\x1b[36m${where || 'node'}>\x1b[0m `);
	}

	/** `cd <dir>` builtin: resolve relative to the current cwd and switch. */
	private changeDir(arg: string | undefined): void {
		if (!this.container) { return; }
		const base = this.resolveCwd(this.container);
		if (!arg || arg === '~') {
			this.cwd = this.container.workdir;
		} else if (arg.startsWith('/')) {
			this.cwd = arg.replace(/\/+$/, '') || '/';
		} else {
			this.cwd = `${base}/${arg}`.replace(/\/+$/, '');
		}
		this.prompt();
	}

	handleInput(data: string): void {
		if (!this.container) { return; }

		// a foreground process owns stdin
		if (this.running && this.inputWriter) {
			// forward raw input to the process (CR → LF)
			void this.inputWriter.write(data.replace(/\r/g, '\n'));
			return;
		}

		// line editing for the prompt
		for (const ch of data) {
			if (ch === '\r') {
				const line = this.buffer;
				this.buffer = '';
				this.writeEmitter.fire('\r\n');
				void this.runLine(line);
				return;
			} else if (ch === '\u007f') { // backspace
				if (this.buffer.length > 0) {
					this.buffer = this.buffer.slice(0, -1);
					this.writeEmitter.fire('\b \b');
				}
			} else if (ch === '\u0003') { // ctrl+c
				this.buffer = '';
				this.writeEmitter.fire('^C\r\n');
				this.prompt();
			} else if (ch >= ' ') {
				this.buffer += ch;
				this.writeEmitter.fire(ch);
			}
		}
	}

	private async runLine(line: string): Promise<void> {
		const container = this.container;
		if (!container) { return; }

		const argv = tokenize(line);
		if (argv.length === 0) {
			this.prompt();
			return;
		}

		if (argv[0] === 'clear') {
			this.writeEmitter.fire('\x1b[2J\x1b[H');
			this.prompt();
			return;
		}
		if (argv[0] === 'cd') {
			this.changeDir(argv[1]);
			return;
		}
		if (argv[0] === 'pwd') {
			this.writeEmitter.fire(`${this.resolveCwd(container)}\r\n`);
			this.prompt();
			return;
		}
		if (argv[0] === 'exit') {
			this.closeEmitter.fire(0);
			return;
		}

			this.running = true;
			try {
				let proc: ContainerProcess;
				// REPL-like evaluation: wrap code so the completion value prints
				// (node -e alone swallows it; `40+2` should show 42 like a REPL)
				const evalCode = (code: string) => `(function(){const __r=eval(${JSON.stringify(code)});if(__r!==undefined)console.log(__r)})()`;
				if (argv[0] === 'node') {
					// `node file.js …` runs the file; bare JS goes through -e
					if (argv.length > 1 && !argv[1].startsWith('-')) {
						proc = await container.spawn('node', argv.slice(1), {
							cwd: this.resolveCwd(container),
							env: { ...container.baseEnv },
						});
					} else {
						// evaluate remaining args as code: `node console.log(1)` → node -e
						const code = argv.slice(1).join(' ');
						if (!code) { this.prompt(); this.running = false; return; }
						proc = await container.spawn('node', ['-e', evalCode(code)], {
							cwd: this.resolveCwd(container),
							env: { ...container.baseEnv },
						});
					}
				} else if (argv[0] === 'npm' || argv[0] === 'npx') {
					proc = await container.spawn(argv[0], argv.slice(1), {
						cwd: this.resolveCwd(container),
						env: { ...container.baseEnv, npm_config_progress: 'false', npm_config_loglevel: 'info' },
					});
				} else if (argv[0] === 'ls' || argv[0] === 'cat' || argv[0] === 'pwd' || argv[0] === 'mkdir' || argv[0] === 'grep' || argv[0] === 'wc' || argv[0] === 'head' || argv[0] === 'sh') {
					// nodine coreutils are real /usr/bin programs
					proc = await container.spawn(argv[0], argv.slice(1), {
						cwd: this.resolveCwd(container),
						env: { ...container.baseEnv },
					});
				} else {
					// treat unknown commands as JS to evaluate (shell-ish convenience)
					proc = await container.spawn('node', ['-e', evalCode(line)], {
						cwd: this.resolveCwd(container),
						env: { ...container.baseEnv },
					});
				}

			this.current = proc;
			this.inputWriter = proc.input ? proc.input.getWriter() : null;

			if (proc.output) {
				const reader = proc.output.getReader();
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) { break; }
						this.writeEmitter.fire(value);
					}
				} catch { /* closed */ }
			}

			const code = await proc.exit;
			if (code !== 0) {
				this.writeEmitter.fire(`\x1b[90m(exit ${code})\x1b[0m\r\n`);
			}
		} catch (err) {
			this.writeEmitter.fire(`\x1b[31m${err}\x1b[0m\r\n`);
		} finally {
			this.running = false;
			this.current = null;
			if (this.inputWriter) {
				try { await this.inputWriter.close(); } catch { /* closed */ }
				this.inputWriter = null;
			}
			this.prompt();
		}
	}

	setDimensions(_dimensions: vscode.TerminalDimensions): void {
		// nodine's kernel is fixed at 80×24 (resize NotYetImplemented)
	}

	async close(): Promise<void> {
		if (this.inputWriter) {
			try { await this.inputWriter.close(); } catch { /* already closed */ }
			this.inputWriter = null;
		}
		if (this.current) {
			try { await this.current.kill(); } catch { /* already gone */ }
		}
	}
}

/** Minimal shell-style tokenizer (quotes + backslash escapes). */
function tokenize(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let quote: '"' | "'" | null = null;
	let has = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			if (ch === quote) { quote = null; }
			else { cur += ch; }
		} else if (ch === '"' || ch === "'") {
			quote = ch; has = true;
		} else if (ch === '\\' && i + 1 < line.length) {
			cur += line[++i]; has = true;
		} else if (/\s/.test(ch)) {
			if (cur || has) { out.push(cur); cur = ''; has = false; }
		} else {
			cur += ch; has = true;
		}
	}
	if (cur || has) { out.push(cur); }
	return out;
}

export function createDevTerminal(context: vscode.ExtensionContext): vscode.Terminal {
	const config = vscode.workspace.getConfiguration('webide-dev');
	const runtimeUrl = config.get<string>('runtimeUrl', '/nodine/supervisor.mjs');

	const pty = new NodineTerminal(runtimeUrl);
	const terminal = vscode.window.createTerminal({
		name: 'node (nodine)',
		pty,
		iconPath: new vscode.ThemeIcon('terminal'),
	});
	context.subscriptions.push(terminal);
	terminal.show();
	return terminal;
}

/**
 * The one dev terminal for this window. `focusDevTerminal` after an upload /
 * import: reuses the open terminal (cd'ing it into the project) or boots a
 * fresh one — the boot progress is visible in the terminal itself, so the
 * user never stares at a silent workbench.
 */
let devTerminal: vscode.Terminal | null = null;
let devPty: NodineTerminal | null = null;

export function focusDevTerminal(context: vscode.ExtensionContext): vscode.Terminal {
	if (devTerminal && devTerminal.exitStatus === undefined) {
		if (devPty) { devPty.cd(getProjectCwd() ?? ''); }
		devTerminal.show();
		return devTerminal;
	}
	const config = vscode.workspace.getConfiguration('webide-dev');
	const runtimeUrl = config.get<string>('runtimeUrl', '/nodine/supervisor.mjs');
	const pty = new NodineTerminal(runtimeUrl);
	// if a project was uploaded before this boot, start inside it
	pty.cd(getProjectCwd() ?? '');
	const terminal = vscode.window.createTerminal({
		name: 'node (nodine)',
		pty,
		iconPath: new vscode.ThemeIcon('terminal'),
	});
	devTerminal = terminal;
	devPty = pty;
	context.subscriptions.push(terminal);
	terminal.show();
	return terminal;
}
