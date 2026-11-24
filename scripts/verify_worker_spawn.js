#!/usr/bin/env node
// Reproduce the extension-host context: a module Worker (blob URL, like the
// ext host) that imports the SDK, boots, and spawns node. If spawn hangs
// here but works on the page, the problem is worker-nesting in nodine.
const { chromium } = require('/home/z/my-project/vscode/node_modules/.pnpm/playwright-core@1.61.0-alpha-2026-06-04/node_modules/playwright-core');

const CHROME = '/home/z/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';

const WORKER_SRC = `
self.onmessage = async (e) => {
  const post = (m) => self.postMessage(m);
  try {
    post({ stage: 'importing' });
    const mod = await import(new URL('/nodine/sdk.mjs', self.location.origin).href);
    post({ stage: 'imported' });
    const container = await mod.Container.boot({ runtimeUrl: '/nodine/supervisor.mjs', coep: 'credentialless', workdirName: 'workertest' });
    post({ stage: 'booted' });
    const proc = await container.spawn('node', ['-p', 'process.version']);
    post({ stage: 'spawned' });
    let out = '';
    if (proc.output) {
      const reader = proc.output.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += value;
      }
    }
    const code = await proc.exit;
    post({ stage: 'done', out, code });
  } catch (err) {
    post({ stage: 'error', error: String(err).slice(0, 500) });
  }
};
`;

async function main() {
	const browser = await chromium.launch({
		executablePath: CHROME,
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
	});
	const page = await browser.newPage();
	await page.goto('http://127.0.0.1:3000/out/vs/code/browser/workbench/callback.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForTimeout(2000);

	const result = await page.evaluate(async (src) => {
		const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
		return await new Promise((resolve) => {
			const w = new Worker(url, { type: 'module' });
			const stages = [];
			const timeout = setTimeout(() => resolve({ stage: 'TIMEOUT', stages }), 45000);
			w.onmessage = (ev) => {
				stages.push(ev.data.stage || JSON.stringify(ev.data).slice(0, 100));
				if (ev.data.stage === 'done' || ev.data.stage === 'error') {
					clearTimeout(timeout);
					resolve({ ...ev.data, stages });
				}
			};
			w.onerror = (e) => {
				clearTimeout(timeout);
				resolve({ stage: 'worker-error', error: String(e.message || e).slice(0, 300), stack: String(e.error && e.error.stack || e.filename || '').slice(0, 500), lineno: e.lineno, stages });
			};
			w.postMessage('go');
		});
	}, WORKER_SRC);

	console.log('WORKER TEST RESULT:', JSON.stringify(result, null, 1));
	await browser.close();
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
