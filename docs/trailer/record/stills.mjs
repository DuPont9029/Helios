// Fotogrammi singoli del montaggio, per controllare didascalie e zoom senza renderizzare tutto.
//   node record/stills.mjs "$PWD/compose.html" work/stills 3.5 12 40
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
const [html, out, ...times] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const exe = process.env.CHROME_PATH || `${homedir()}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`file://${html}?render=1`);
await page.evaluate(() => document.fonts.ready);
console.log("total", await page.evaluate(() => window.TOTAL));
for (const t of times) {
  await page.evaluate((t) => window.seek(t), +t);
  await page.locator("#stage").screenshot({ path: `${out}/t${String(t).padStart(6, "0")}.jpg`, quality: 80 });
}
await browser.close();
