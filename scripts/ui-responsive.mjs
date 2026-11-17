// Headless check of the layout: no horizontal overflow at any window size, and
// the scroll position survives ticks. Run: node scripts/ui-responsive.mjs
// Requires a Chromium binary in CHROME_PATH (or the default Windows location).
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:4173/';
const OUT = process.env.UI_OUT || 'ui-responsive';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!existsSync(CHROME)) { console.log(JSON.stringify({ skipped: `no Chromium at ${CHROME}` })); process.exit(0); }
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const report = { screens: [], overflow: [], scroll: null };

const nodes = Array.from({ length: 40 }, (_, index) => ({
  id: `n${index}`,
  name: `Node ${index}`,
  country: ['DE', 'NL', 'FR', 'PL', 'US', 'FI'][index % 6],
  protocol: ['vless', 'hysteria2', 'trojan'][index % 3],
  outbound: { type: ['vless', 'hysteria2', 'trojan'][index % 3], server: `10.0.${index}.1`, server_port: 443, uuid: '11111111-1111-4111-8111-111111111111' },
  latency: 30 + (index % 90)
}));

async function seed(page, language) {
  await page.evaluate((servers, lang) => {
    const state = { version: 2, subscriptions: [], nodes: servers, selectedId: servers[0].id, routeMode: 'all', language: lang, settings: {}, routing: null };
    localStorage.setItem('kartoshka.state.v2', JSON.stringify(state));
  }, nodes, language);
  await page.reload({ waitUntil: 'networkidle0' });
}

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(BASE, { waitUntil: 'networkidle0' });

for (const language of ['ru', 'en']) {
  await seed(page, language);
  for (const width of [640, 760, 900, 1080, 1280, 1600]) {
    for (const height of [520, 700, 900]) {
      await page.setViewport({ width, height });
      for (const screen of ['home', 'servers', 'stats', 'settings', 'logs', 'about']) {
        await page.click(`[data-nav="${screen}"]`);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) report.overflow.push({ language, width, height, screen, overflow });
        if ([760, 1280].includes(width) && height === 700) {
          const file = `${OUT}/${screen}-${language}-${width}x${height}.png`;
          await page.screenshot({ path: file });
          report.screens.push(file);
        }
      }
    }
  }
}

// Two scroll checks. A tick that changes nothing must keep the offset exactly.
// A tick that changes the list (ping results arrive, the progress bar goes away)
// may shift it: rows use content-visibility, so their real height is only known
// once they are near the viewport. Such a tick must not jump to the top.
await page.setViewport({ width: 760, height: 700 });
await seed(page, 'ru');
await page.click('[data-nav="servers"]');
await page.evaluate(() => new Promise(requestAnimationFrame));
const scrollTo = () => page.evaluate(() => {
  const main = document.querySelector('.main');
  main.scrollTop = Math.round(main.scrollHeight * 0.6);
  return { top: main.scrollTop, max: main.scrollHeight - main.clientHeight };
});
const readScroll = () => page.evaluate(() => {
  const main = document.querySelector('.main');
  return { top: main.scrollTop, max: main.scrollHeight - main.clientHeight };
});
const quiet = await scrollTo();
await new Promise((resolve) => setTimeout(resolve, 1600));
const afterQuiet = await readScroll();
const busy = await scrollTo();
await page.evaluate(() => document.querySelector('[data-action="refresh"]')?.click());
await new Promise((resolve) => setTimeout(resolve, 1500));
const afterBusy = await readScroll();
const limit = Math.min(busy.top, afterBusy.max);
report.scroll = {
  quiet: { before: quiet, after: afterQuiet, exact: Math.abs(afterQuiet.top - quiet.top) <= 2 },
  busy: { before: busy, after: afterBusy, expected: limit, keptAbove70: afterBusy.top >= limit * 0.7 },
};
report.scroll.preserved = report.scroll.quiet.exact && report.scroll.busy.keptAbove70;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ overflow: report.overflow.length, scroll: report.scroll, screens: report.screens.length }));
if (report.overflow.length || !report.scroll.preserved) process.exitCode = 1;
await browser.close();
