/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { bootContainer, type NodineContainer, type ContainerProcess } from './nodine';
import { getProjectCwd } from './extensionMain';

/**
 * Hook fired after every terminal command completes so the extension can
 * announce FS changes to the workbench (the runtime has no fs.watch).
 * Set by extensionMain via setAfterCommandHook().
 */
let afterCommandHook: (() => void) | null = null;
let hookFireCount = 0;

export function setAfterCommandHook(fn: () => void): void {
	afterCommandHook = fn;
}

export function getHookFireCount(): number {
	return hookFireCount;
}

/**
 * A VS Code pseudoterminal backed by the nodine runtime.
 *
 * nodine runs one process per spawn (no PTY/REPL in the kernel), so this
 * terminal is line-based and behaves like a real shell:
 *  - `node <file|flags>`, `npm <cmd>` and any container binary are spawned
 *    as real processes (`node -v` prints the version, not a JS eval error)
 *  - cd / pwd / echo / clear are builtins; the cwd is the CONTAINER ROOT
 *    ("/") so browsing matches the Explorer's Nodine root (like C:\)
 *  - process output is CR-normalized (bare \n → \r\n) so nothing staircases
 *  - `clear` wipes screen AND scrollback
 *  - `> 40+2` is the explicit JS-REPL escape hatch
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
	/** cwd for spawned commands — starts at the container root (Explorer root). */
	private cwd: string | null = null;
	/** whether the last fired output ended with a newline (prompt placement) */
	private atLineStart = true;
	/** one-time hint shown when a running program doesn't read stdin */
	private stdinHintShown = false;

	constructor(private readonly runtimeUrl: string) { }

	/** Point the shell at a project folder (e.g. "/my-app"). Silent pre-boot. */
	cd(path: string): void {
		if (path) { this.cwd = path.replace(/\/+$/, '') || '/'; }
		else { this.cwd = '/'; }
		if (this.container) { this.prompt(); }
	}

	/** Absolute directory commands run in: cwd (default the container root). */
	private resolveCwd(container: NodineContainer): string {
		return this.cwd ?? '/';
	}

	/**
	 * Output coalescing: process output arrives as many tiny chunks (clack
	 * writes each cursor sequence separately, npm per line). Fired as-is,
	 * escape sequences split across xterm writes mis-render (stale prompt
	 * frames). Buffer for ~12 ms and fire ONE atomic chunk — a real PTY does
	 * the same, and atomic delivery is proven to render correctly.
	 */
	private outBuf = '';
	private outTimer: ReturnType<typeof setTimeout> | null = null;

	/** All output goes through here: bare \n → \r\n (no staircase output). */
	private write(data: string): void {
		this.outBuf += data.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
		if (this.outTimer === null) {
			this.outTimer = setTimeout(() => this.flushOut(), 12);
		}
	}

	private flushOut(): void {
		if (this.outTimer !== null) {
			clearTimeout(this.outTimer);
			this.outTimer = null;
		}
		if (!this.outBuf) { return; }
		const buf = this.outBuf;
		this.outBuf = '';
		this.atLineStart = buf.endsWith('\r\n') || buf.endsWith('\n');
		this.writeEmitter.fire(buf);
	}

	/** ANSI: clear viewport + scrollback + home (real `clear`). */
	private clearScreen(): void {
		this.flushOut(); // never reorder buffered output behind the clear
		this.writeEmitter.fire('\x1b[2J\x1b[3J\x1b[H');
		this.atLineStart = true;
	}

	async open(_initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
		this.clearScreen();
		this.write('\x1b[90mstarting dev environment…\x1b[0m\r\n');
		try {
			this.container = await bootContainer(this.runtimeUrl);
		} catch (err) {
			console.error('[webide-dev] runtime boot failed:', err);
			this.write('\x1b[31mfailed to start the dev environment (the host must send cross-origin isolation headers).\x1b[0m\r\n');
			this.closeEmitter.fire(1);
			return;
		}
		const version = await this.nodeVersion();
		// clean terminal: wipe the boot status, show just the version
		this.clearScreen();
		if (version) {
			this.write(`Node.js ${version}\r\n\r\n`);
		}
		this.prompt();
	}

	private nodeVersionCache: string | null = null;
	private async nodeVersion(): Promise<string | null> {
		if (this.nodeVersionCache !== null) { return this.nodeVersionCache; }
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
				this.nodeVersionCache = null;
			} else {
				// the kernel's console.log quotes strings — strip them for display
				this.nodeVersionCache = out.trim().replace(/^['"]|['"]$/g, '') || null;
			}
		} catch {
			this.nodeVersionCache = null;
		}
		return this.nodeVersionCache;
	}

	/** "/" renders as the workspace root name — Nodine/ (like C:\). */
	private displayCwd(): string {
		const where = this.cwd ?? '/';
		return where === '/' ? 'Nodine/' : `Nodine${where}`;
	}

	private prompt(): void {
		this.flushOut(); // never reorder buffered output behind the prompt
		if (!this.atLineStart) { this.writeEmitter.fire('\r\n'); this.atLineStart = true; }
		this.writeEmitter.fire(`\x1b[36m${this.displayCwd()}\x1b[0m ❯ `);
	}

	/** `cd <dir>` builtin: resolve relative to the current cwd and switch. */
	private changeDir(arg: string | undefined): void {
		if (!this.container) { return; }
		const base = this.resolveCwd(this.container);
		let next: string;
		if (!arg || arg === '~') {
			next = this.container.workdir;
		} else if (arg === '/' || arg === '-') {
			next = '/';
		} else if (arg.startsWith('/')) {
			next = arg;
		} else {
			next = `${base}/${arg}`;
		}
		this.cwd = next.replace(/\/+$/, '') || '/';
		this.prompt();
	}

	handleInput(data: string): void {
		if (!this.container) { return; }

		// a foreground process owns the terminal
		if (this.running) {
			// Ctrl+C terminates the foreground job (SIGINT semantics) — also
			// fed through stdin so prompt libraries can exit gracefully
			if (data.includes('\u0003')) {
				if (this.inputWriter) { void this.inputWriter.write('\u0003'); }
				this.write('^C\r\n');
				this.atLineStart = true;
				try { void this.current?.kill(); } catch { /* already gone */ }
				return;
			}
			if (this.inputWriter) {
				// forward bytes RAW and do NOT echo: the kernel presents the
				// process with a TTY (isTTY true), so prompt libraries render
				// their own input — clack redraws its frame, npm's `read`
				// echoes each key. A terminal-side echo would interleave with
				// those redraws (doubled chars, text past the placeholder).
				// Enter stays \r: clack submits on the 'return' keypress; node
				// readline treats a lone \r as a line ending too.
				for (const ch of data) {
					if (ch === '\r') {
						this.writeEmitter.fire('\r\n'); // cursor feedback only
						void this.inputWriter.write('\r');
					} else {
						void this.inputWriter.write(ch);
					}
				}
				return;
			}
			// running but the program never opened stdin: swallow keystrokes
			// so they don't pile into the prompt buffer and run as commands
			if (!this.stdinHintShown) {
				this.stdinHintShown = true;
				this.write('\x1b[90m(program running — Ctrl+C to stop)\x1b[0m\r\n');
			}
			return;
		}

		// line editing for the prompt
		for (const ch of data) {
			if (ch === '\r') {
				const line = this.buffer;
				this.buffer = '';
				this.write('\r\n');
				void this.runLine(line);
				return;
			} else if (ch === '\u007f') { // backspace
				if (this.buffer.length > 0) {
					this.buffer = this.buffer.slice(0, -1);
					this.writeEmitter.fire('\b \b');
				}
			} else if (ch === '\u0003') { // ctrl+c
				this.buffer = '';
				this.write('^C\r\n');
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

		// && chains run left to right; a non-zero exit stops the chain (POSIX)
		const segments = splitAndSeq(line);
		if (segments.every(s => tokenize(s).length === 0)) {
			this.prompt();
			return;
		}

		this.running = true;
		try {
			for (const seg of segments) {
				const code = await this.runSegment(seg, container);
				if (code !== 0) { break; }
			}
		} finally {
			this.finishCommand();
		}
	}

	/**
	 * One &&-segment: builtins or a spawned process. Returns the exit code.
	 * Honors `> file` / `>> file` redirection (stdout → container file).
	 */
	private async runSegment(seg: string, container: NodineContainer): Promise<number> {
		const argv = tokenize(seg);
		if (argv.length === 0) { return 0; }

		// redirect parsing: '>' / '>>' as a NON-initial token (a leading '>'
		// stays the JS-REPL escape hatch below)
		let redirect: { path: string; append: boolean } | null = null;
		for (let i = 1; i < argv.length; i++) {
			if (argv[i] === '>' || argv[i] === '>>') {
				const target = argv[i + 1];
				if (!target) {
					this.write('\x1b[31msyntax error: expected file after redirect\x1b[0m\r\n');
					return 2;
				}
				redirect = { path: target, append: argv[i] === '>>' };
				argv.length = i; // the command is everything before the operator
				break;
			}
		}

		if (argv[0] === 'clear') {
			this.clearScreen();
			return 0;
		}
		if (argv[0] === 'cd') {
			this.changeDir(argv[1]);
			return 0;
		}
		if (argv[0] === 'pwd') {
			const out = `${this.resolveCwd(container)}\r\n`;
			if (redirect) { await this.writeContainerFile(container, redirect, out.replace('\r\n', '\n')); }
			else { this.write(out); }
			return 0;
		}
		if (argv[0] === 'echo') {
			const text = `${argv.slice(1).join(' ')}\r\n`;
			if (redirect) { await this.writeContainerFile(container, redirect, argv.slice(1).join(' ') + '\n'); }
			else { this.write(text); }
			return 0;
		}
		if (argv[0] === 'exit') {
			this.closeEmitter.fire(0);
			return 0;
		}
		// explicit JS-REPL escape hatch: `> 40+2` evaluates and prints
		if (argv[0] === '>') {
			const code = seg.replace(/^\s*>\s*/, '');
			if (!code) { return 0; }
			const proc = await container.spawn('node', ['-e', replWrap(code)], {
				cwd: this.resolveCwd(container),
				env: { ...container.baseEnv },
			});
			this.current = proc;
			return await this.pump(proc, container);
		}

		try {
			let proc: ContainerProcess;
			if (argv[0] === 'node') {
				if (argv.length === 1) {
					// bare `node` has no TTY-backed REPL in the kernel — show usage
					this.write('\x1b[90musage: node <file.js> · node -v · node -e "<code>"\x1b[0m\r\n');
					return 0;
				}
				// `node <file>`, `node -v`, `node -e '<code>'` — spawn for real
				proc = await container.spawn('node', argv.slice(1), {
					cwd: this.resolveCwd(container),
					env: { ...container.baseEnv },
				});
			} else {
				// npm / npx / coreutils / anything else in the container:
				// spawn as a real process; a missing binary fails fast
				proc = await container.spawn(argv[0], argv.slice(1), {
					cwd: this.resolveCwd(container),
					env: { ...container.baseEnv, ...(argv[0] === 'npm' || argv[0] === 'npx' ? { npm_config_progress: 'false', npm_config_loglevel: 'info' } : {}) },
				});
			}

			this.current = proc;
			this.inputWriter = proc.input ? proc.input.getWriter() : null;
			return await this.pump(proc, container, redirect);
		} catch (err) {
			// spawn failure (missing binary): one clean line, no stack noise
			const msg = String(err).split('\n')[0].replace(/^FileSystemError:\s*/, '');
			this.write(`\x1b[31m${msg}\x1b[0m\r\n`);
			return 1;
		}
	}

	/** `> file` / `>> file` sink: write (or append) text in the container FS. */
	private async writeContainerFile(container: NodineContainer, redirect: { path: string; append: boolean }, data: string): Promise<void> {
		const base = this.resolveCwd(container);
		const p = redirect.path.startsWith('/') ? redirect.path : `${base}/${redirect.path}`;
		let content = data;
		if (redirect.append) {
			try { content = new TextDecoder().decode(await container.fs.readFile(p)) + data; }
			catch { /* new file */ }
		} else {
			const dir = p.slice(0, p.lastIndexOf('/')) || '/';
			try { await container.fs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
		}
		await container.fs.writeFile(p, content);
	}

	/**
	 * Stream a process's output into the terminal, CR-normalized. With a
	 * redirect, output is captured into the target file instead and the
	 * `(exit N)` line is suppressed (like a real shell).
	 */
	private async pump(proc: ContainerProcess, container: NodineContainer, redirect?: { path: string; append: boolean } | null): Promise<number> {
		let captured = '';
		if (proc.output) {
			const reader = proc.output.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) { break; }
					if (redirect) { captured += value; }
					else { this.write(value); }
				}
			} catch { /* closed */ }
		}
		const code = await proc.exit;
		if (redirect) {
			try { await this.writeContainerFile(container, redirect, captured); }
			catch (err) {
				this.write(`\x1b[31mwrite failed: ${String(err).split('\n')[0]}\x1b[0m\r\n`);
				return 1;
			}
			return code === 0 ? 0 : code;
		}
		if (code !== 0) {
			this.write(`\x1b[90m(exit ${code})\x1b[0m\r\n`);
		}
		return code;
	}

	private finishCommand(): void {
		this.running = false;
		this.current = null;
		this.stdinHintShown = false;
		if (this.inputWriter) {
			try { void this.inputWriter.close(); } catch { /* closed */ }
			this.inputWriter = null;
		}
		// the runtime has no fs.watch (kernel milestone M4) — announce the FS
		// MAY have changed after every command so the Explorer re-reads the
		// root listing (terminal mkdir/rm/node -e/npm writes show up live)
		try { hookFireCount++; afterCommandHook?.(); } catch { /* hook optional */ }
		this.prompt();
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

/** REPL wrapper: print the completion value (like a node REPL). */
function replWrap(code: string): string {
	return `(function(){const __r=eval(${JSON.stringify(code)});if(__r!==undefined)console.log(__r)})()`;
}

/** Split a line on `&&` (quote-aware) into command segments. */
function splitAndSeq(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			cur += ch;
			if (ch === quote) { quote = null; }
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
		} else if (ch === '&' && line[i + 1] === '&') {
			out.push(cur);
			cur = '';
			i++; // skip the second '&'
		} else {
			cur += ch;
		}
	}
	out.push(cur);
	return out.map(s => s.trim());
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

/**
 * Terminal profile provider for the manifest's `terminal.profiles` entry
 * (id "webide-dev.nodine"). Registering the provider is what makes the
 * profile usable as the DEFAULT terminal: without it the profile appears
 * in the picker but creating fails with "No terminal profile provider
 * registered". Every default terminal (+ button, Ctrl+`, "Terminal:
 * Create New Terminal") resolves through here in this static web build,
 * because no local process support exists.
 *
 * The workbench creates the terminal FROM the returned profile: it must
 * carry a pty, which wires the instance to our nodine runtime directly.
 */
export class NodineProfileProvider implements vscode.TerminalProfileProvider {
	private readonly runtimeUrl: string;

	constructor(runtimeUrl: string) {
		this.runtimeUrl = runtimeUrl;
	}

	provideTerminalProfile(_token: vscode.CancellationToken): vscode.ProviderResult<vscode.TerminalProfile> {
		const pty = new NodineTerminal(this.runtimeUrl);
		// start in the project folder if one was uploaded/imported before
		pty.cd(getProjectCwd() ?? '');
		return { name: 'node (nodine)', options: { pty } };
	}
}
