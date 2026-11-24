#!/usr/bin/env node
// Drive the workbench via keyboard: command palette → New Text File, then type code.
const path = require('path');
const fs = require('fs');
const { chromium } = require('/home/z/my-project/vscode/node_modules/.pnpm/playwright-core@1.61.0-alpha-2026-06-04/node_modules/playwright-core');

const CHROME = '/home/z/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const URL = 'http://127.0.0.1:3000/';
const OUT_DIR = '/home/z/my-project/download/vscode-web-preview';

async function main() {
	const browser = await chromium.launch({
		executablePath: CHROME,
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
	});
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 45000 });
	await page.waitForTimeout(6000);
	console.log('workbench up');

	// Command palette → New Text File
	await page.keyboard.press('Control+Shift+P');
	await page.waitForTimeout(1200);
	await page.keyboard.type('New Text File', { delay: 25 });
	await page.waitForTimeout(800);
	await page.screenshot({ path: path.join(OUT_DIR, 'command-palette.png') });
	await page.keyboard.press('Enter');
	await page.waitForTimeout(4000);

	const st = await page.evaluate(() => ({
		monacoEditor: !!document.querySelector('.monaco-editor'),
		tabs: [...document.querySelectorAll('.tab .label-name')].map(t => t.textContent),
	}));
	console.log('after New Text File:', JSON.stringify(st));

	if (!st.monacoEditor) {
		// fallback: Ctrl+N
		await page.keyboard.press('Control+N');
		await page.waitForTimeout(3000);
		const st2 = await page.evaluate(() => !!document.querySelector('.monaco-editor'));
		console.log('after Ctrl+N monacoEditor:', st2);
	}

	// type code
	await page.click('.monaco-editor', { timeout: 10000 });
	await page.keyboard.type('function hello(name) {\n  return `Hello ${name}!`;\n}\n\nconst msg = hello("VS Code Web");\n', { delay: 15 });
	await page.waitForTimeout(2500);

	const model = await page.evaluate(() => {
		const m = window.monaco?.editor?.getModels?.()[0];
		return m ? m.getValue().slice(0, 150) : null;
	});
	console.log('typed:', JSON.stringify(model));

	// syntax highlighting: count colored tokens
	const tokens = await page.evaluate(() => {
		const spans = document.querySelectorAll('.view-lines span[class*="mtk"]');
		return spans.length;
	});
	console.log('colored token spans:', tokens);

	await page.screenshot({ path: path.join(OUT_DIR, 'editing.png') });
	console.log('editing screenshot saved');

	// open search widget
	await page.keyboard.press('Control+F');
	await page.waitForTimeout(1000);
	await page.keyboard.type('hello', { delay: 20 });
	await page.waitForTimeout(1000);
	await page.screenshot({ path: path.join(OUT_DIR, 'find-widget.png') });
	console.log('find widget screenshot saved');

	await browser.close();
	console.log('KEYBOARD DRIVE DONE');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
