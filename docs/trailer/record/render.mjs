// Cattura compose.html fotogramma per fotogramma e lo codifica in H.264 (serve ffmpeg).
//   node record/render.mjs "$PWD/compose.html" work/video.mp4 30
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
const [html, out, fpsArg] = process.argv.slice(2);
const fps = +(fpsArg || 30);
const exe = process.env.CHROME_PATH || `${homedir()}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`file://${html}?render=1`);
await page.evaluate(() => document.fonts.ready);
const total = await page.evaluate(() => window.TOTAL);
const n = Math.round(total * fps);
const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
const stage = page.locator("#stage");
for (let i = 0; i < n; i++) {
  await page.evaluate((t) => window.seek(t), i / fps);
  const buf = await stage.screenshot({ type: "png" });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (i % 300 === 0) console.log(`frame ${i}/${n}`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await browser.close();
console.log("done", out);
