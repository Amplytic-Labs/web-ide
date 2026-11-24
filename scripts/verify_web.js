#!/usr/bin/env node
// Verify the static VS Code web build boots in a real browser via playwright-core.
const path = require('path');
const fs = require('fs');

const { chromium } = require('/home/z/my-project/vscode/node_modules/.pnpm/playwright-core@1.61.0-alpha-2026-06-04/node_modules/playwright-core');

const CHROME = '/home/z/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const URL = 'http://127.0.0.1:3000/';
const OUT_DIR = '/home/z/my-project/download/vscode-web-preview';

fs.mkdirSync(OUT_DIR, { recursive: true });

async function main() {
	const browser = await chromium.launch({
		executablePath: CHROME,
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
	});
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

	const errors = [];
	page.on('console', msg => {
		if (msg.type() === 'error' || msg.type() === 'warning') {
			errors.push(`[${msg.type()}] ${msg.text().slice(0, 300)}`);
		}
	});
	page.on('pageerror', err => errors.push(`[pageerror] ${String(err).slice(0, 300)}`));

	console.log('loading', URL);
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

	let rendered = false;
	try {
		await page.waitForSelector('.monaco-workbench', { timeout: 45000 });
		rendered = true;
		console.log('WORKBENCH RENDERED');
	} catch {
		console.log('TIMEOUT waiting for .monaco-workbench');
	}

	// let the UI fully settle (welcome tab, extension host)
	await page.waitForTimeout(12000);

	await page.screenshot({ path: path.join(OUT_DIR, 'workbench.png') });
	console.log('screenshot saved');

	const stats = await page.evaluate(() => ({
		hasWorkbench: !!document.querySelector('.monaco-workbench'),
		hasActivitybar: !!document.querySelector('.activitybar'),
		hasSidebar: !!document.querySelector('.sidebar'),
		hasTitlebar: !!document.querySelector('.titlebar'),
		hasEditorArea: !!document.querySelector('.editor-group-container'),
		bodyText: (document.body.innerText || '').replace(/\n+/g, ' | ').slice(0, 300),
	}));
	console.log('stats:', JSON.stringify(stats, null, 1));

	console.log('console issues (first 15):');
	errors.slice(0, 15).forEach(e => console.log('  ', e));
	console.log(`total console issues: ${errors.length}`);

	await browser.close();
	if (!rendered) process.exit(2);
}

main().catch(err => { console.error('VERIFY FAILED:', err); process.exit(1); });
