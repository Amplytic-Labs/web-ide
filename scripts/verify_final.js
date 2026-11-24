#!/usr/bin/env node
// Final proof: type code and read it back from the Monaco DOM (view-lines text).
const { chromium } = require('/home/z/my-project/vscode/node_modules/.pnpm/playwright-core@1.61.0-alpha-2026-06-04/node_modules/playwright-core');
const CHROME = '/home/z/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const URL = 'http://127.0.0.1:3000/';

async function main() {
	const browser = await chromium.launch({
		executablePath: CHROME,
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
	});
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 45000 });
	await page.waitForTimeout(5000);

	// New Text File via command palette
	await page.keyboard.press('Control+Shift+P');
	await page.waitForTimeout(1000);
	await page.keyboard.type('New Text File', { delay: 20 });
	await page.keyboard.press('Enter');
	await page.waitForTimeout(3000);

	await page.click('.monaco-editor', { timeout: 10000 });
	const CODE = 'const greeting = "Hello from real VS Code Web";';
	await page.keyboard.type(CODE + '\n', { delay: 15 });
	await page.waitForTimeout(2000);

	const domText = await page.evaluate(() =>
		[...document.querySelectorAll('.view-lines .view-line')]
			.map(l => l.textContent).join('\n').trim()
	);
	console.log('DOM editor content:', JSON.stringify(domText));
	console.log('MATCH:', domText.includes('Hello from real VS Code Web'));

	// token colors present (syntax highlighting)
	const colored = await page.evaluate(() =>
		document.querySelectorAll('.view-lines span[class*="mtk"]').length
	);
	console.log('colored spans:', colored);

	// status bar visible?
	const statusbar = await page.evaluate(() => ({
		remoteIndicator: !!document.querySelector('.remote-viewlet'),
		statusbarText: (document.querySelector('.statusbar')?.innerText || '').slice(0, 120),
	}));
	console.log('statusbar:', JSON.stringify(statusbar));

	await browser.close();
	console.log('FINAL PROOF DONE');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
