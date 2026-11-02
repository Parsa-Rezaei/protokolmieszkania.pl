// Generuje og-image.png (1200x630), apple-touch-icon.png (180x180) i icon-512.png (Playwright + Chromium).
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const icon = (size) => `<html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" fill="#1f57c3"/><path d="M9 8h10l4 4v12a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" fill="#fff"/><path d="M11.5 18.5l3 3 6-7" stroke="#1f57c3" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></body></html>`;

const og = `<html><body style="margin:0;width:1200px;height:630px;font-family:'DejaVu Sans',Arial,sans-serif;background:linear-gradient(135deg,#1b3463,#1f57c3);color:#fff;display:flex;flex-direction:column;justify-content:center;padding:0 80px;box-sizing:border-box">
<div style="font-size:30px;opacity:.85;margin-bottom:18px">ProtokolMieszkania.pl</div>
<div style="font-size:66px;font-weight:800;line-height:1.1">Protokół zdawczo-odbiorczy mieszkania</div>
<div style="font-size:34px;margin-top:26px;opacity:.95">Zdjęcia liczników · Podpis palcem na ekranie · Gotowy PDF</div>
<div style="font-size:26px;margin-top:40px;background:#10b981;display:inline-block;align-self:flex-start;padding:12px 24px;border-radius:14px">Kalkulator taksy notarialnej i ryczałtu od najmu 2026</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, html, w, h] of [
  ['og-image.png', og, 1200, 630],
  ['apple-touch-icon.png', icon(180), 180, 180],
  ['icon-512.png', icon(512), 512, 512]
]) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html);
  await page.screenshot({ path: join(pub, name), clip: { x: 0, y: 0, width: w, height: h } });
  console.log('zapisano', name);
}
await browser.close();
