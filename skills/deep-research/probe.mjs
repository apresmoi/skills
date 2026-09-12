import { chromium } from 'playwright';
import { join } from 'node:path';
const HOME = process.env.HOME;
const profile = join(HOME, '.deep-research/profiles/chatgpt');
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, viewport: { width: 1440, height: 900 }, ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-blink-features=AutomationControlled'] });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
const out = await page.evaluate(() => {
  const pick = (sel) => [...document.querySelectorAll(sel)].slice(0, 6).map(e => ({
    tag: e.tagName.toLowerCase(),
    id: e.id || null,
    testid: e.getAttribute('data-testid'),
    ce: e.getAttribute('contenteditable'),
    ph: (e.getAttribute('placeholder') || e.getAttribute('aria-label') || '').slice(0, 60),
    cls: (e.className || '').toString().slice(0, 70),
    vis: !!(e.offsetWidth || e.offsetHeight)
  }));
  return {
    url: location.href,
    textarea: pick('textarea, #prompt-textarea'),
    editable: pick('[contenteditable="true"]'),
    composerish: pick('[data-testid*="composer"], [class*="composer"]'),
    newChatBtns: [...document.querySelectorAll('a,button')]
      .map(e => (e.textContent || '').trim()).filter(t => /new chat|new conversation|start/i.test(t)).slice(0, 5),
    tpp: [...document.querySelectorAll('[data-tpp-toggle-value]')].map(e => e.getAttribute('data-tpp-toggle-value') + '=' + e.getAttribute('aria-checked'))
  };
});
console.log(JSON.stringify(out, null, 1));
await ctx.close();
