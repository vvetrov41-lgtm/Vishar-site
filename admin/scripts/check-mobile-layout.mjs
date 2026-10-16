// Statistics on a phone: the four headline figures and "Needs attention"
// must be fully visible above the bottom tab bar, in English and Russian, on
// the iPhone sizes the studio uses, with no horizontal scroll anywhere.
//
// Renders layout-check/ (the real App over the test fixtures) with Vite and
// measures it in Chromium. Uses playwright-core, which downloads no browser:
// a local Playwright Chromium is used when present (PLAYWRIGHT_BROWSERS_PATH),
// otherwise the runner's installed Google Chrome.
//
// Usage: npm run check:mobile-layout [-- --screenshots <dir>]

import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const admin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotsArg = process.argv.indexOf('--screenshots');
const shots = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (shots) mkdirSync(shots, { recursive: true });

const DEVICES = [
  { name: 'iPhone 13/14', width: 390, height: 844 },
  { name: 'iPhone 15/16', width: 393, height: 852 },
  { name: 'iPhone Pro Max', width: 430, height: 932 },
];
// The "Needs attention" heading proves which language actually rendered.
const LANGUAGES = [
  { code: 'en', attention: 'Needs attention' },
  { code: 'ru', attention: 'Требует внимания' },
];

async function launch() {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ channel: 'chrome' });
  }
}

const server = await createServer({
  configFile: false,
  root: join(admin, 'layout-check'),
  plugins: [react()],
  logLevel: 'error',
  server: { port: 0, strictPort: false, fs: { allow: [admin] } },
});
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await launch();
const failures = [];
try {
  for (const device of DEVICES) {
    for (const { code: language, attention: attentionHeading } of LANGUAGES) {
      const label = `${device.name} ${device.width}x${device.height} ${language}`;
      const context = await browser.newContext({
        viewport: { width: device.width, height: device.height },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      await context.addInitScript((lang) => {
        window.localStorage.setItem('vishar-crm-language', lang);
      }, language);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForSelector('.stats-headline .stats-kpi');
      await page.waitForSelector('.stats-attention li');

      const m = await page.evaluate(() => {
        const rect = (el) => el.getBoundingClientRect();
        const tabbar = document.querySelector('.tabbar');
        const fold = tabbar ? rect(tabbar).top : window.innerHeight;
        const kpis = [...document.querySelectorAll('.stats-headline .stats-kpi')];
        const attention = document.querySelector('.stats-attention');
        const items = [...document.querySelectorAll('.stats-attention li')];
        const tooWide = [...document.querySelectorAll('body *')]
          .filter((el) => {
            const r = rect(el);
            if (r.width === 0 || r.height === 0) return false;
            // Elements inside a horizontally scrolling box may extend past it.
            for (let p = el.parentElement; p; p = p.parentElement) {
              const o = getComputedStyle(p).overflowX;
              if (o === 'auto' || o === 'scroll' || o === 'hidden') return false;
            }
            return r.right > window.innerWidth + 1 || r.left < -1;
          })
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
        return {
          fold,
          tabbarVisible: Boolean(tabbar) && getComputedStyle(tabbar).display !== 'none',
          kpiCount: kpis.length,
          kpiBottom: Math.max(...kpis.map((el) => rect(el).bottom)),
          attentionTop: attention ? rect(attention).top : null,
          attentionBottom: attention ? rect(attention).bottom : null,
          attentionItems: items.length,
          attentionHeading: attention?.querySelector('h2')?.textContent ?? '',
          kpisBeforeAttention: attention ? Math.max(...kpis.map((el) => rect(el).bottom)) <= rect(attention).top : false,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          tooWide,
        };
      });
      if (shots) await page.screenshot({ path: join(shots, `statistics-${device.width}x${device.height}-${language}.png`) });

      const problems = [];
      if (m.attentionHeading !== attentionHeading) problems.push(`rendered "${m.attentionHeading}", not the ${language} screen`);
      if (!m.tabbarVisible) problems.push('the bottom tab bar is not shown');
      if (m.kpiCount !== 4) problems.push(`${m.kpiCount} headline figures instead of 4`);
      if (m.kpiBottom > m.fold) problems.push(`headline figures end at ${Math.round(m.kpiBottom)}px, below the tab bar at ${Math.round(m.fold)}px`);
      if (m.attentionItems < 5) problems.push(`only ${m.attentionItems} attention items rendered; the fixture has 5`);
      if (m.attentionBottom === null || m.attentionBottom > m.fold) {
        problems.push(`Needs attention ends at ${Math.round(m.attentionBottom ?? -1)}px, below the tab bar at ${Math.round(m.fold)}px`);
      }
      if (!m.kpisBeforeAttention) problems.push('the headline figures do not come before Needs attention');
      if (m.scrollWidth > m.innerWidth) problems.push(`horizontal scroll: page is ${m.scrollWidth}px wide in a ${m.innerWidth}px viewport`);
      if (m.tooWide.length > 0) problems.push(`elements past the screen edge: ${m.tooWide.join(', ')}`);
      if (errors.length > 0) problems.push(`console errors: ${errors.slice(0, 3).join(' | ')}`);

      console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${label}: figures end ${Math.round(m.kpiBottom)}px, attention ${Math.round(m.attentionTop)}-${Math.round(m.attentionBottom)}px, tab bar ${Math.round(m.fold)}px, width ${m.scrollWidth}/${m.innerWidth}`);
      for (const problem of problems) {
        console.log(`     - ${problem}`);
        failures.push(`${label}: ${problem}`);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} mobile layout problem(s).`);
  process.exit(1);
}
console.log('\nStatistics first screen fits every checked phone.');
