#!/usr/bin/env node
// Full terminal verification: line-based shell with node -e eval + npm.
const { chromium } = require('/home/z/my-project/vscode/node_modules/.pnpm/playwright-core@1.61.0-alpha-2026-06-04/node_modules/playwright-core');
const { execSync } = require('child_process');

const CHROME = '/home/z/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const SHOT = '/home/z/my-project/download/vscode-web-preview/terminal-final.png';

async function main() {
	const browser = await chromium.launch({
		executablePath: CHROME,
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
	});
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

	await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 45000 });
	await page.waitForTimeout(12000);

	await page.keyboard.press('Control+Shift+P');
	await page.waitForTimeout(1000);
	await page.keyboard.type('Web IDE: Create Dev Terminal', { delay: 15 });
	await page.keyboard.press('Enter');
	await page.waitForTimeout(35000); // boot + node version probe

	await page.click('.terminal', { timeout: 10000 });
	await page.waitForTimeout(500);

	// JS evaluation through node -e
	await page.keyboard.type('40+2', { delay: 40 });
	await page.keyboard.press('Enter');
	await page.waitForTimeout(15000);

	// npm works in-browser
	await page.keyboard.type('npm --version', { delay: 40 });
	await page.keyboard.press('Enter');
	await page.waitForTimeout(20000);

	await page.screenshot({ path: SHOT });
	await browser.close();

	const ocr = execSync(
		`python3 /home/z/my-project/scripts/ocr_shot.py "${SHOT}"`,
		{ encoding: 'utf8' }
	);
	console.log('OCR OUTPUT:');
	console.log(ocr);
	console.log('EVAL 40+2=42:', /42/.test(ocr));
	console.log('NPM VERSION PRESENT:', /12\.\d+\.\d+/.test(ocr));
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
