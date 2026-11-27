// Renders resources/icon.png (1024×1024, macOS icon grid) from HTML.
// electron-builder turns it into the .icns. Run: node scripts/make-icon.mjs
import path from 'node:path'
import { createRequire } from 'node:module'

const { chromium } = createRequire(import.meta.url)('playwright')
const out = path.resolve('resources/icon.png')

const html = `<!doctype html><html><head><style>
  html,body{margin:0;width:1024px;height:1024px;background:transparent}
  .icon{position:absolute;left:100px;top:100px;width:824px;height:824px;border-radius:186px;overflow:hidden;
    background:radial-gradient(120% 90% at 50% 0%,#2a2540 0%,#0d0b16 55%,#050409 100%);
    box-shadow:inset 0 2px 0 rgba(255,255,255,.18), inset 0 0 0 2px rgba(255,255,255,.06), 0 24px 48px rgba(0,0,0,.35)}
  .glow{position:absolute;left:50%;top:50%;width:620px;height:620px;transform:translate(-50%,-50%);border-radius:50%;
    background:radial-gradient(circle,rgba(150,110,255,.55),rgba(150,110,255,0) 65%);filter:blur(30px)}
  .orb{position:absolute;left:50%;top:50%;width:440px;height:440px;transform:translate(-50%,-50%);border-radius:50%;overflow:hidden;
    background:radial-gradient(circle at 50% 55%,#1b1240,#050208 75%);
    box-shadow:0 0 90px rgba(140,100,255,.6), inset 0 0 18px 4px rgba(0,0,0,.6), inset 0 6px 8px rgba(255,255,255,.35)}
  .a{position:absolute;inset:6%;border-radius:50%;background:conic-gradient(from 20deg,#ff2d55,#bf5af2,#5e5ce6,#0a84ff,#64d2ff,#ff375f);filter:blur(16px) saturate(1.3)}
  .b{position:absolute;inset:18%;border-radius:50%;background:conic-gradient(from 160deg,#ff9f0a,#ff2d55,#5e5ce6,#0a84ff,#ff9f0a);filter:blur(20px);mix-blend-mode:screen;opacity:.65}
  .c{position:absolute;inset:0;border-radius:50%;mix-blend-mode:screen;
    background:radial-gradient(circle at 68% 72%,rgba(100,210,255,.85),transparent 45%),radial-gradient(circle at 28% 30%,rgba(255,55,95,.75),transparent 45%)}
  .core{position:absolute;inset:30%;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.95),rgba(255,255,255,0) 70%);filter:blur(6px);opacity:.75}
  .shine{position:absolute;left:12%;top:5%;width:76%;height:40%;border-radius:50%;background:linear-gradient(180deg,rgba(255,255,255,.35),rgba(255,255,255,0));filter:blur(2px)}
</style></head><body><div class="icon"><div class="glow"></div><div class="orb"><div class="a"></div><div class="b"></div><div class="c"></div><div class="core"></div><div class="shine"></div></div></div></body></html>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
await page.setContent(html)
await page.screenshot({ path: out, omitBackground: true })
await browser.close()
console.log(`Wrote ${out}`)
