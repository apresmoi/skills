#!/usr/bin/env node
// Drive a deep-research session on ChatGPT or Grok through the real UI under
// a logged-in browser on the machine holding the site logins. Headed by
// design: the operator watches and can intervene (answer clarifying
// questions, fix tool/model selection). Topic-agnostic — the prompt is
// whatever intake file or --prompt you pass; nothing here is scoped to a
// subject.
//
// Anti-detection is load-bearing: these sites serve a degraded UI (no
// history, no model picker, deep research hidden) when navigator.webdriver
// is true. We launch a PERSISTENT Chrome profile with the automation flags
// stripped, so the site sees an ordinary browser.
//
//   node run.mjs --check                 # default site: chatgpt
//   node run.mjs --site grok --check
//   node run.mjs --intake ./research/2026-07-07/simfile-priors.md
//   node run.mjs --prompt "..." --out ./reply.md [--model "..."] [--no-send]
//                [--project <name>|--no-project|--url <start url>]

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
// Resolve playwright from wherever it is installed (repo root or a global).
const require = createRequire(join(SKILL_DIR, 'package.json'));
const { chromium } = require('playwright');

const HOME = process.env.HOME;
const STATE_DIR = process.env.DEEP_RESEARCH_HOME || join(HOME, '.deep-research');
const SECRETS_DIR = join(STATE_DIR, 'secrets');
const PROFILES_DIR = join(STATE_DIR, 'profiles');

// ---------- site registry ----------
const SITES = {
  chatgpt: {
    // Starts at the root chat. To run inside a ChatGPT Project (keeps research
    // out of personal history, carries a standing brief as project
    // instructions) pass --url <project url> or set DEEP_RESEARCH_PROJECT_URL.
    url: process.env.DEEP_RESEARCH_PROJECT_URL || 'https://chatgpt.com/',
    cookieFile: 'chatgpt.com_cookies.txt',
    composer: '#prompt-textarea, div[contenteditable="true"]',
    // With Deep research enabled, the effort ladder is Instant/Medium/High/
    // Extra High — "Pro Extended" is a regular-chat tier and isn't offered, so
    // requesting it silently lands on Extra High. Extra High IS the top
    // deep-research tier, so default to it (verification then confirms cleanly).
    // 2026-10-05 UI: the pill is "Select ChatGPT model" and shows the model
    // ("Pro"); effort is a slider inside its menu, read back from
    // data-selected-reasoning-effort. The old Instant..Extra High ladder is gone.
    defaultModel: 'Pro',
    setModel: async (page, label) => {
      const pill = page.locator('button.__composer-pill, button[aria-label="Select ChatGPT model"]').first();
      if (!(await pill.isVisible().catch(() => false))) return false;
      if ((await pill.innerText().catch(() => '')).includes(label)) {
        // Push the effort slider to its top before sending, and refuse
        // anything but GPT-6 Pro or 5.6 Pro: the menu header reads "6 Pro".
        await pill.click().catch(() => undefined); await page.waitForTimeout(800);
        const header = (await page.locator('[data-model-picker-view-toggle]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (!/^(?:GPT-)?(?:6|5\.6) Pro\b/i.test(header)) { await page.keyboard.press('Escape'); return false; }
        const slider = page.locator('[data-reasoning-slider]').first();
        if (await slider.isVisible().catch(() => false)) { await slider.hover().catch(() => undefined); await slider.focus().catch(() => undefined); for (let k = 0; k < 4; k++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250); } }
        await page.keyboard.press('Escape'); await page.waitForTimeout(400);
        return true;
      }
      await pill.click(); await page.waitForTimeout(800);
      // 2026-10-05: with Deep research on, the pill opens a 5-step "Thinking effort"
      // slider (Instant … 6 Pro). End does nothing; ArrowRight on the hovered slider
      // row moves it. Max step reads "6 Pro" in the header and "Pro" on the pill.
      const effortSlider = page.locator('[data-reasoning-slider]').first();
      if (/pro/i.test(label) && await effortSlider.isVisible().catch(() => false)) {
        await effortSlider.hover().catch(() => undefined); await effortSlider.focus().catch(() => undefined);
        for (let k = 0; k < 4; k++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250); }
        const hdr = (await page.locator('[data-model-picker-view-toggle]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        await page.keyboard.press('Escape'); await page.waitForTimeout(400);
        return /^(?:GPT-)?(?:6|5\.6) Pro\b/i.test(hdr);
      }
      // "Instant" is the slider's bottom step: the fastest model, for checks
      // that only need an answer, not research.
      if (/^instant$/i.test(label) && await effortSlider.isVisible().catch(() => false)) {
        await effortSlider.hover().catch(() => undefined); await effortSlider.focus().catch(() => undefined);
        for (let k = 0; k < 4; k++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(250); }
        await page.keyboard.press('Escape'); await page.waitForTimeout(400);
        return true;
      }
      const item = page.getByRole('menuitemradio', { name: new RegExp(`^${label}$`, 'i') })
        .or(page.getByRole('menuitem', { name: new RegExp(`^${label}$`, 'i') }))
        .or(page.getByText(new RegExp(`^${label}$`, 'i'))).first();
      if (await item.isVisible().catch(() => false)) { await item.click(); await page.waitForTimeout(500); return true; }
      await page.keyboard.press('Escape'); return false;
    },
    // ChatGPT now opens in one of two product modes, a radio pair above the
    // composer: Chat and Work. Work routes the prompt to an agentic task run,
    // which is metered differently and is not what a research session wants.
    // Force Chat, and refuse to run at all if that cannot be confirmed —
    // sending a research prompt into Work silently is worse than not sending it.
    ensureChatMode: async (page) => {
      const chat = page.locator('[data-tpp-toggle-value="chatgpt"], button[aria-pressed]:text-is("Chat")').first();
      const work = page.locator('[data-tpp-toggle-value="work"], button[aria-pressed]:text-is("Work")').first();
      const selected = async (el) =>
        (await el.getAttribute('aria-checked').catch(() => null)) === 'true' ||
        (await el.getAttribute('aria-pressed').catch(() => null)) === 'true' ||
        (await el.getAttribute('data-state').catch(() => null)) === 'on';

      if (!(await chat.isVisible().catch(() => false))) {
        // No toggle rendered: either an older UI without the split, or the page
        // did not finish loading. Only the first is safe, and we cannot tell
        // them apart, so treat a visible Work button as proof the split exists.
        if (await work.isVisible().catch(() => false)) return { ok: false, why: 'Work toggle present but Chat toggle not found' };
        return { ok: true, why: 'no Chat/Work toggle in this UI' };
      }
      if (await selected(chat)) return { ok: true, why: 'Chat already selected' };

      await chat.click().catch(() => undefined);
      await page.waitForTimeout(700);
      if (await selected(chat)) return { ok: true, why: 'switched to Chat' };
      return { ok: false, why: 'clicked Chat but it did not become selected' };
    },
    enableResearch: async (page) => {           // + menu → Deep research
      // ChatGPT's + menu items are now plain buttons/labels (no role=menuitem),
      // grouped under "Add files and more". Match the "Deep research" label by text,
      // falling back to a "More"/"Tools" submenu if it's nested there.
      // Scoped away from <nav>: a sidebar PROJECT named "Deep research" matched
      // the bare text and was clicked instead of the menu item (2026-10-05).
      // 2026-10-05 (later): rows are plain divs ("Deep research · Get a detailed
      // report"), so also match the row by its unique subtitle.
      // .or().first() is DOM order, and the project page's <h1><button>Deep research</button>
      // (the project title) comes first — so try the subtitle row before the label match.
      const drItem = () => {
        const bySubtitle = page.getByText('Get a detailed report', { exact: true }).first();
        const byLabel = page.locator('button:not(nav button):not(h1 button), [role^="menuitem"]').filter({ hasText: /^deep research/i }).first();
        return { isVisible: async () => (await bySubtitle.isVisible().catch(() => false)) || byLabel.isVisible(),
                 click: async () => (await bySubtitle.isVisible().catch(() => false)) ? bySubtitle.click() : byLabel.click() };
      };
      const plus = page.locator('[data-testid="composer-plus-btn"], button[aria-label="Add files and more"]').first();
      await plus.click(); await page.waitForTimeout(900);
      if (!(await drItem().isVisible().catch(() => false))) {
        const more = page.getByText(/^(more|tools)$/i).first();
        if (await more.isVisible().catch(() => false)) { await more.hover(); await page.waitForTimeout(700); }
      }
      const dr = drItem();
      if (await dr.isVisible().catch(() => false)) {
        await dr.click(); await page.waitForTimeout(900);
        // Ground truth: the composer shows a "Deep research" chip once enabled.
        // 2026-10-05: the composer is no longer a <form>; the chip is a span inside
        // [data-composer-body] (the "New chat in Deep research" placeholder is an attribute, not text).
        return await page.locator('form, [data-composer-body] span').filter({ hasText: /^\s*deep research\s*$/i }).first().isVisible().catch(() => false)
          || await page.locator('form').filter({ hasText: /deep research/i }).first().isVisible().catch(() => false);
      }
      await page.keyboard.press('Escape'); return false;
    },
    // 2026-10-05: the send button lost data-testid and is now aria-label "Send".
    sendSel: '[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"]',
    streamingSel: '[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]',
    assistantSel: '[data-message-author-role="assistant"]',
    healthPill: () => 'button.__composer-pill, button[aria-label="Select ChatGPT model"]',
  },
  grok: {
    // Root chat by default; runs then move into a Project (found or created
    // by name, see ensureProject). A project's composer keeps the model menu
    // (Auto/Fast/Expert/Build/Heavy), so Expert/Heavy is still verified.
    url: process.env.DEEP_RESEARCH_GROK_PROJECT_URL || 'https://grok.com/',
    cookieFile: 'grok.com_cookies.txt',
    composer: '.ProseMirror',
    defaultModel: 'Expert',                     // Auto | Fast | Expert | Heavy
    setModel: async (page, label) => {
      // Each row is a menuitem with a title + subtitle. A loose /Expert/ regex
      // also matches the Auto row ("Chooses Fast or Expert"), so match the
      // menuitem that CONTAINS an exact-text node equal to the label.
      const pill = page.locator('button[aria-label="Model select"]').first();
      if (!(await pill.isVisible().catch(() => false))) return false;
      await pill.click(); await page.waitForTimeout(900);
      const item = page.locator('[role="menuitem"], [role="menuitemradio"], [role="menu"] button')
        .filter({ has: page.getByText(label, { exact: true }) }).first();
      if (await item.isVisible().catch(() => false)) { await item.click(); await page.waitForTimeout(700); return true; }
      await page.keyboard.press('Escape'); return false;
    },
    enableResearch: async () => true,           // Grok: depth is the model (Expert/Heavy), no separate tool
    sendSel: 'button[aria-label="Submit"]',
    streamingSel: 'button[aria-label="Stop model response"]',
    assistantSel: '.response-content-markdown',
    healthPill: () => 'button[aria-label="Model select"]',
  },
};

// ---------- args ----------
const args = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);

const SITE_KEY = opt('site', 'chatgpt');
const site = SITES[SITE_KEY];
if (!site) { console.error(`Unknown --site "${SITE_KEY}". Known: ${Object.keys(SITES).join(', ')}`); process.exit(1); }

// --url overrides the site's start page (e.g. a ChatGPT Project URL).
const EXPLICIT_URL = Boolean(opt('url')
  || (SITE_KEY === 'chatgpt' && process.env.DEEP_RESEARCH_PROJECT_URL)
  || (SITE_KEY === 'grok' && process.env.DEEP_RESEARCH_GROK_PROJECT_URL));
if (opt('url')) site.url = opt('url');

// Runs land inside a Project (ChatGPT and Grok both have them) so they stay
// out of the personal chat history. The project is found or created by name
// on first use and its URL is remembered in <state>/projects.json (not a
// secret). --no-project or an explicit --url / *_PROJECT_URL env skips this.
const PROJECTS_FILE = join(STATE_DIR, 'projects.json');
const PROJECT_NAME = opt('project', process.env.DEEP_RESEARCH_PROJECT_NAME || 'Deep research');
const USE_PROJECT = !flag('no-project') && !EXPLICIT_URL;

const CHECK = flag('check');
const NO_SEND = flag('no-send');
const COOKIES_PATH = opt('cookies', join(SECRETS_DIR, site.cookieFile));
// --profile lets several sessions on the SAME site run in parallel: each gets
// its own persistent Chrome dir (Chrome locks a profile to one instance),
// seeded from the same cookie file on first run. Defaults to the site name.
const PROFILE_DIR = join(PROFILES_DIR, opt('profile', SITE_KEY));
const INTAKE = opt('intake');
const PROMPT_ARG = opt('prompt');
const OUT = opt('out');
const COMPOSE = flag('compose');         // regular chat (no deep research), fast done-detection
const EXPLICIT_MODEL = opt('model');     // null unless --model passed
const MODEL = EXPLICIT_MODEL || site.defaultModel;
// GPT-6 Pro thinks for 8-20 min even in regular chat (2026-10-06).
const TIMEOUT_MIN = Number(opt('timeout-min', COMPOSE ? (SITE_KEY === 'chatgpt' ? '45' : '15') : '90'));
// ChatGPT is read through its conversation API, which answers 429 when polled
// every 4 s (2026-10-06): a finished chat reply then read as 0 chars.
const POLL_S = COMPOSE ? (SITE_KEY === 'chatgpt' ? 15 : 4) : 10;
const STABLE_S = COMPOSE ? 12 : 150;
const MIN_REPORT_CHARS = COMPOSE ? 500 : 2500;

// ---------- prompt / output resolution ----------
let prompt = PROMPT_ARG, outPath = OUT;
if (INTAKE) {
  const intakeAbs = resolve(INTAKE);
  const md = readFileSync(intakeAbs, 'utf8');
  const fence = md.match(/```\n([\s\S]*?)```/);
  if (!fence) { console.error(`No fenced prompt block found in ${intakeAbs}`); process.exit(1); }
  prompt = fence[1].trim(); outPath = intakeAbs;
}
if (!CHECK && !prompt) { console.error('Need --intake <file>, --prompt <text>, or --check'); process.exit(1); }
if (!CHECK && !outPath) { console.error('Need --out <file> when using --prompt'); process.exit(1); }

// ---------- cookies (only to seed a fresh profile) ----------
function parseNetscapeCookies(path) {
  const out = [];
  for (let line of readFileSync(path, 'utf8').split('\n')) {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice('#HttpOnly_'.length); }
    if (!line.trim() || line.startsWith('#')) continue;
    let parts = line.split('\t');
    if (parts.length < 7) parts = line.trim().split(/\s+/);
    if (parts.length < 7) continue;
    const [domain, , path_, secure, expires, name, ...valueParts] = parts;
    out.push({ name, value: valueParts.join('\t'), domain, path: path_,
      expires: Number(expires) > 0 ? Number(expires) : -1, secure: secure === 'TRUE', httpOnly, sameSite: 'Lax' });
  }
  return out;
}

const ts = () => new Date().toTimeString().slice(0, 8);
const log = (m) => console.log(`[${ts()}] ${m}`);
const waitForEnter = (msg) => new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`\n${msg}\n   Press Enter here when done... `, () => { rl.close(); res(); });
});

// ---------- Project: find or create by name ----------
const PROJECT_URL_RES = {
  chatgpt: /\/g\/g-p-[^/]+\/project/,        // https://chatgpt.com/g/g-p-<id>[-slug]/project
  grok: /\/project\/[0-9a-f-]{36}/,           // https://grok.com/project/<uuid>
};
const PROJECT_URL_RE = PROJECT_URL_RES[SITE_KEY];
const readProjects = () => { try { return JSON.parse(readFileSync(PROJECTS_FILE, 'utf8')); } catch { return {}; } };
const rememberProject = (url) => {
  const db = readProjects();
  db[SITE_KEY] ??= {};
  db[SITE_KEY][PROJECT_NAME] = url;
  writeFileSync(PROJECTS_FILE, JSON.stringify(db, null, 2) + '\n');
};

async function ensureProject(page) {
  const known = readProjects()[SITE_KEY]?.[PROJECT_NAME];
  if (known) {
    await page.goto(known, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2000);
    if (PROJECT_URL_RE.test(page.url())) { log(`Project "${PROJECT_NAME}" → ${known} (remembered)`); return known; }
    log(`Remembered project URL no longer resolves; re-resolving "${PROJECT_NAME}" from the sidebar.`);
    await page.goto(SITE_KEY === 'grok' ? 'https://grok.com/' : 'https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2500);
  }
  await page.keyboard.press('Escape').catch(() => {});
  return SITE_KEY === 'grok' ? ensureGrokProject(page) : ensureChatgptProject(page);
}

async function ensureGrokProject(page) {
  // Sidebar: li[data-sidebar=menu-item] > div[role=button] "<name>", with
  // hover-only "New chat" / "Options" buttons. "New chat" lands on /project/<uuid>.
  const row = page.locator('li[data-sidebar="menu-item"]')
    .filter({ has: page.locator('div[role="button"]', { hasText: new RegExp(`^${PROJECT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
  if (await row.count()) {
    await row.locator('div[role="button"]').first().hover();
    await page.waitForTimeout(600);
    await row.locator('button[aria-label="New chat"]').first().click({ force: true });
    await page.waitForURL(PROJECT_URL_RE, { timeout: 30_000 });
    const url = page.url().replace(/[?#].*$/, '');
    rememberProject(url);
    log(`Project "${PROJECT_NAME}" → ${url} (found in sidebar)`);
    return url;
  }
  // Create: "Add project" opens a dialog whose text input is focused; Enter creates.
  await page.locator('button[aria-label="Add project"]').first().click();
  const nameInput = page.locator('input[placeholder="New project"], dialog input, [role="dialog"] input').first();
  await nameInput.waitFor({ state: 'visible', timeout: 15_000 });
  await nameInput.fill(PROJECT_NAME);
  await page.keyboard.press('Enter');
  await page.waitForURL(PROJECT_URL_RE, { timeout: 30_000 });
  const url = page.url().replace(/[?#].*$/, '');
  rememberProject(url);
  log(`Project "${PROJECT_NAME}" → ${url} (created)`);
  return url;
}

async function ensureChatgptProject(page) {
  // Sidebar rows carry "Open project options for <name>"; "Show more" may hide some.
  const optionsBtn = () => page.locator(`button[aria-label="Open project options for ${PROJECT_NAME}"]`).first();
  if (await optionsBtn().count() === 0) {
    const more = page.locator('nav button', { hasText: /^Show more$/ }).first();
    if (await more.count()) { await more.click().catch(() => {}); await page.waitForTimeout(800); }
  }
  if (await optionsBtn().count()) {
    const row = optionsBtn().locator('xpath=ancestor::*[contains(@class,"project-unfurl-row")]').first();
    await row.hover();
    await page.waitForTimeout(500);
    await row.locator('button[aria-label="Open project home"]').first().click();
    await page.waitForURL(PROJECT_URL_RE, { timeout: 30_000 });
    const url = page.url();
    rememberProject(url);
    log(`Project "${PROJECT_NAME}" → ${url} (found in sidebar)`);
    return url;
  }

  // Create: native <dialog> with one text input and a "Create project" submit.
  await page.locator('button[aria-label="New project"]').first().click();
  const nameInput = page.locator('dialog input[type="text"]').first();
  await nameInput.waitFor({ state: 'visible', timeout: 15_000 });
  await nameInput.fill(PROJECT_NAME);
  await page.locator('dialog button[type="submit"]').first().click();
  await page.waitForURL(PROJECT_URL_RE, { timeout: 30_000 });
  const url = page.url();
  rememberProject(url);
  log(`Project "${PROJECT_NAME}" → ${url} (created)`);
  return url;
}

// ---------- launch ----------
mkdirSync(PROFILES_DIR, { recursive: true });
const firstRun = !existsSync(PROFILE_DIR);
if (firstRun && !existsSync(COOKIES_PATH)) {
  console.error(`No ${SITE_KEY} profile yet and no cookie file at ${COOKIES_PATH} to seed it.`);
  process.exit(1);
}
// A shared browser (browser-host.mjs) holds this profile open: attach to it
// and work in a tab of our own, so several runs proceed at once. Without a
// host, launch the profile ourselves as before.
const HOST_FILE = join(STATE_DIR, 'browsers', `${basename(PROFILE_DIR)}.json`);
async function attachToHost() {
  if (!existsSync(HOST_FILE)) return null;
  try {
    const { port } = JSON.parse(readFileSync(HOST_FILE, 'utf8'));
    return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
  } catch (error) {
    log(`⚠ Shared browser listed in ${HOST_FILE} did not answer (${error.message.split('\n')[0]}); launching our own.`);
    return null;
  }
}
const hostBrowser = await attachToHost();
const context = hostBrowser ? hostBrowser.contexts()[0] : await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
});
if (firstRun && !hostBrowser) {
  const cookies = parseNetscapeCookies(COOKIES_PATH);
  await context.addCookies(cookies);
  log(`First run — seeded ${cookies.length} cookies into ${PROFILE_DIR}`);
}
const page = hostBrowser ? await context.newPage() : (context.pages()[0] || await context.newPage());
if (hostBrowser) {
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  log(`Attached to the shared ${basename(PROFILE_DIR)} browser: own tab (${context.pages().length} open).`);
}
// Close only what this run opened: its tab in a shared browser, else the browser.
async function closeSession() {
  if (hostBrowser) { await page.close().catch(() => undefined); await hostBrowser.close().catch(() => undefined); }
  else await context.close().catch(() => undefined);
}
process.on('SIGINT', async () => { log('Interrupted — closing browser.'); await closeSession(); process.exit(130); });
process.on('SIGTERM', async () => { await closeSession(); process.exit(143); });

log(`[${SITE_KEY}] Opening ${site.url} ...`);
await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

const composer = page.locator(site.composer).first();
const ok = await composer.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
if (!ok) {
  console.error(`\n✗ Composer never appeared — ${SITE_KEY} cookies likely expired. Delete ${PROFILE_DIR} and re-export cookies.`);
  await page.screenshot({ path: `/tmp/${SITE_KEY}-research-login.png` });
  await closeSession();
  process.exit(2);
}
await page.waitForTimeout(2500);

const webdriver = await page.evaluate(() => navigator.webdriver);
const pillText = await page.locator(site.healthPill()).first().innerText().catch(() => '');
const history = await page.locator('a[href^="/c/"]').count().catch(() => 0);
log(`navigator.webdriver=${webdriver} · model="${pillText.trim().replace(/\n/g, ' ')}" · history=${history}`);
if (webdriver) log('⚠ webdriver=true — UI may be bot-detected/degraded.');

if (USE_PROJECT) {
  try {
    site.url = await ensureProject(page);
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
  } catch (e) {
    console.error(`\n✗ Could not open or create project "${PROJECT_NAME}": ${e.message}`);
    await page.screenshot({ path: `/tmp/${SITE_KEY}-research-project.png` });
    await closeSession();
    process.exit(2);
  }
}

if (CHECK) {
  await page.screenshot({ path: `/tmp/${SITE_KEY}-research-check.png` });
  log(`Check passed. Screenshot: /tmp/${SITE_KEY}-research-check.png`);
  await closeSession();
  process.exit(webdriver ? 2 : 0);
}

// ---------- dismiss onboarding/feature modals ----------
// Grok shows a feature-tour dialog (#dialog-portal) on fresh sessions that
// overlays and intercepts clicks on the composer/model picker. Clear it first.
// The "Grok Build / Imagine" announcement dialog appears a few seconds AFTER
// load, so poll for its Close button rather than checking once.
async function dismissOverlays() {
  for (let i = 0; i < 14; i++) {
    const close = page.locator(
      '#dialog-portal button[aria-label*="lose" i], [role="dialog"] button[aria-label*="lose" i], #dialog-portal button[aria-label*="dismiss" i]'
    ).first();
    if (await close.isVisible().catch(() => false)) {
      await close.click().catch(() => {});
      await page.waitForTimeout(500);
      return true;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(550);
  }
  return false;
}
await dismissOverlays();

// ---------- enable research depth + model ----------
let researchOn = true;
if (COMPOSE) {
  log('✎ Compose mode — regular chat (deep research OFF), fast done-detection.');
} else {
  if (site.ensureChatMode) {
    const mode = await site.ensureChatMode(page);
    if (!mode.ok) {
      throw new Error(`refusing to run: ChatGPT is not in Chat mode (${mode.why}). Work mode routes this to an agentic task run, not research.`);
    }
    log(`✓ Chat mode: ${mode.why}.`);
  }
  // ChatGPT restores an unsent draft into the composer; on 2026-10-05 a test
  // prompt went out glued to the previous run's leftover text. Clear it BEFORE
  // enabling Deep research, whose chip lives inside the composer.
  if (SITE_KEY === 'chatgpt') {
    await composer.click().catch(() => undefined);
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);
  }
  researchOn = await site.enableResearch(page);
  if (SITE_KEY === 'chatgpt') log(researchOn ? '✓ Deep research enabled.' : '⚠ Could not auto-enable Deep research.');
}
// Set the model when NOT composing, or when compose was given an explicit
// --model; otherwise compose rides the account's default (logged for the record).
if (!COMPOSE || EXPLICIT_MODEL) {
  await site.setModel(page, MODEL);
  // Re-read the pill after selecting — ground truth, not an assumption.
  const pillAfter = (await page.locator(site.healthPill()).first().innerText().catch(() => '')).replace(/\n/g, ' ').trim();
  const applied = pillAfter.toLowerCase().includes(MODEL.toLowerCase());
  const effort = await page.locator(site.healthPill()).first().getAttribute('data-selected-reasoning-effort').catch(() => null);
  log(`${applied ? '✓' : '⚠'} Model/effort: requested "${MODEL}" · pill now shows "${pillAfter}"${effort ? ` · reasoning effort "${effort}"` : ''}${applied ? '' : ' — NOT applied, fix before relying on output'}`);
  if (!applied) {
    await page.screenshot({ path: `/tmp/${SITE_KEY}-research-model-failed.png` });
    await closeSession();
    throw new Error(`Refusing to send: requested model/effort "${MODEL}" was not verified.`);
  }
} else {
  const pill = (await page.locator(site.healthPill()).first().innerText().catch(() => '')).replace(/\n/g, ' ').trim();
  log(`✎ Compose model = account default "${pill}" (pass --model to override).`);
}

// ---------- fill prompt ----------
await dismissOverlays();  // re-check: the modal can pop after model selection
await composer.click();
await page.keyboard.insertText(prompt);
log(`Prompt filled (${prompt.length} chars).`);
if (SITE_KEY === 'chatgpt') {
  // Refuse to send anything but this run's prompt (plus the Deep research chip).
  const filled = ((await composer.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const expected = prompt.replace(/\s+/g, ' ').trim();
  const extra = filled.replace(expected, '').replace(/deep research/i, '').trim();
  if (!filled.includes(expected.slice(0, 200)) || extra.length > 40) {
    await page.screenshot({ path: `/tmp/${SITE_KEY}-research-composer-dirty.png` });
    await closeSession();
    throw new Error(`Refusing to send: the composer holds text beyond this prompt (${extra.length} extra chars).`);
  }
}

if (!researchOn || NO_SEND) {
  await waitForEnter(
    researchOn ? '→ --no-send: review in the browser, then press SEND there yourself.'
               : '→ Could not auto-configure. Set the tool/model in the browser, then SEND there.'
  );
} else {
  log('Sending in 8s — Ctrl+C to abort, or send in the browser yourself.');
  await page.waitForTimeout(8_000);
  const send = page.locator(site.sendSel).first();
  if (await send.isEnabled().catch(() => false)) await send.click().catch(() => undefined);
  // "Sent." used to be logged unconditionally: on 2026-10-05 the send button's
  // selector had gone stale, nothing was clicked, and the run idled 40 min.
  // A ChatGPT send is proven by the page moving to its new /c/<id> thread.
  if (SITE_KEY === 'chatgpt') {
    const moved = () => page.waitForURL(/\/c\/[0-9a-f-]{36}/, { timeout: 30_000 }).then(() => true).catch(() => false);
    let ok = await moved();
    if (!ok) { await composer.click().catch(() => undefined); await page.keyboard.press('Enter'); ok = await moved(); }
    if (!ok) {
      await page.screenshot({ path: `/tmp/${SITE_KEY}-research-send-failed.png` });
      await closeSession();
      throw new Error('Refusing to wait: the prompt was not sent (no conversation was created).');
    }
    log(`Sent → ${page.url()}`);
  } else log('Sent.');
}

// ---------- wait for the report ----------
log(COMPOSE
  ? `Waiting for the reply (timeout ${TIMEOUT_MIN} min) — regular chat, usually a couple of minutes.`
  : `Waiting for the report (timeout ${TIMEOUT_MIN} min). Deep research can take 15-60 min — leave the window open.`);
const deadline = Date.now() + TIMEOUT_MIN * 60_000;
let lastLen = 0, stableSince = Date.now(), warnedClarify = false, lastLogged = 0;

const lastAssistantText = async () =>
  page.locator(site.assistantSel).last().innerText({ timeout: 5_000 }).catch(() => '');
const isStreaming = async () =>
  page.locator(site.streamingSel).first().isVisible().catch(() => false);

// ChatGPT deep research renders EVERYTHING — the progress card, the clarifying/
// plan card, and the final report — inside a sandboxed cross-origin iframe, NOT
// as a [data-message-author-role="assistant"] turn. So the assistant selector
// reads empty for the whole run. Read the report frame directly instead.
const CHATGPT_DR = SITE_KEY === 'chatgpt' && !COMPOSE;
// The conversation JSON is the ground truth. On 2026-10-05 ChatGPT's thread DOM
// stopped carrying [data-message-author-role] and conversation-turn test ids,
// so DOM scraping read nothing. Read the backend conversation the page itself
// renders: the current turn is everything after the last user message, and
// the report is its final assistant text message (end_turn === true).
// Citation markers (\ue200cite…\ue201) are replaced by each reference's `alt`,
// which is markdown carrying the real URL.
async function chatgptApiReport(capturePage = page) {
  const id = (capturePage.url().match(/\/c\/([0-9a-f-]{36})/) || [])[1];
  if (!id) return null;
  return await capturePage.evaluate(async (conversationId) => {
    const session = await (await fetch('/api/auth/session')).json();
    const response = await fetch(`/backend-api/conversation/${conversationId}`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
    if (!response.ok) return { error: `conversation ${response.status}` };
    const json = await response.json();
    const chain = [];
    for (let node = json.current_node; node && json.mapping[node]; node = json.mapping[node].parent) chain.unshift(json.mapping[node]);
    const lastUser = chain.map((n) => n.message?.author?.role).lastIndexOf('user');
    const turn = chain.slice(lastUser + 1).map((n) => n.message).filter(Boolean);
    const render = (m) => {
      let t = (m.content?.parts || []).filter((x) => typeof x === 'string').join('\n');
      const refs = [...(m.metadata?.content_references || [])].filter((r) => r.matched_text).sort((a, b) => (b.start_idx ?? 0) - (a.start_idx ?? 0));
      for (const r of refs) t = t.split(r.matched_text).join(r.alt ? ` ${r.alt}` : '');
      return t.replace(/\ue200[^\ue201]*\ue201/g, '').trim();
    };
    const texts = turn.filter((m) => m.author?.role === 'assistant' && m.content?.content_type === 'text' && (m.recipient ?? 'all') === 'all');
    const final = [...texts].reverse().find((m) => m.end_turn === true);
    const latest = turn.at(-1);
    const links = [];
    for (const m of texts) for (const r of m.metadata?.content_references || []) {
      for (const u of r.safe_urls || []) links.push(u);
      for (const hit of String(r.alt || '').matchAll(/\((https?:[^)\s]+)\)/g)) links.push(hit[1]);
    }
    const text = final ? render(final) : texts.length ? render(texts.at(-1)) : '';
    const done = !!final && final.status === 'finished_successfully';
    const working = !done && turn.length > 0 && (latest?.status === 'in_progress' || latest?.end_turn !== true || !!json.async_status);
    return { text, links, done, working, model: final?.metadata?.resolved_model_slug || texts.at(-1)?.metadata?.resolved_model_slug || '', raw: JSON.stringify(json).length };
  }, id).catch((error) => ({ error: String(error) }));
}
async function chatgptReport(capturePage = page)                          {
  const empty = { text: '', html: '', links: []            , done: false, working: false };
  const api = await chatgptApiReport(capturePage);
  let apiShort = null;
  if (api && !api.error && (api.text || api.working)) {
    const links = [...new Set(api.links)].filter((url) => { try { return !/(?:^|\.)(?:chatgpt\.com|oaiusercontent\.com)$/.test(new URL(url).hostname); } catch { return false; } });
    // A short "done" turn is an acknowledgement or a question; the Deep
    // research app may still be writing its report in a widget frame below.
    if (api.done && api.text && api.text.length >= MIN_REPORT_CHARS) return { text: api.text, html: '', links, done: true, working: false, model: api.model };
    if (api.done && api.text) apiShort = { text: api.text, html: '', links, done: true, working: false, model: api.model };
    if (api.working || (api.text && !api.done)) return { text: api.text, html: '', links, done: false, working: true, model: api.model };
  }
  const main = await capturePage.evaluate(() => {
    const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
    const turn = turns.at(-1);
    const pendingUser = turn?.getAttribute('data-turn') === 'user';
    const messages = turn?.querySelectorAll             ('[data-message-author-role="assistant"]');
    const message = messages?.[messages.length - 1];
    const stop = Array.from(document.querySelectorAll             (
      '[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]'
    )).some(button => button.getClientRects().length > 0);
    const complete = !!turn?.querySelector('button[data-testid="copy-turn-action-button"]');
    // innerText drops citation hrefs. Expand each real anchor in a disposable
    // off-screen clone so a per-story split retains its own source linkage.
    let text = message?.innerText ?? '';
    if (message && complete && !stop) {
      const clone = message.cloneNode(true)               ;
      const original = Array.from(message.querySelectorAll                   ('a[href^="http"]'));
      Array.from(clone.querySelectorAll                   ('a[href^="http"]')).forEach((anchor, i) => {
        const label = original[i].innerText.trim();
        anchor.textContent = `${label} (${anchor.href})`;
      });
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;left:-100000px;top:0;width:1440px;opacity:0;pointer-events:none';
      container.appendChild(clone);
      document.body.appendChild(container);
      try { text = clone.innerText; } finally { container.remove(); }
    }
    return {
      text, html: message?.innerHTML ?? '', 
      links: Array.from(message?.querySelectorAll                   ('a[href^="http"]') ?? [])
        .map(anchor => anchor.href),
      done: !!message && complete && !stop,
      working: stop, pendingUser, hasFrame: !!turn?.querySelector('iframe'),
    };
  }).catch(() => null);
  const sourceLinks = (links          ) => [...new Set(links)].filter(url => {
    try {
      const host = new URL(url).hostname;
      return !/(?:^|\.)(?:chatgpt\.com|oaiusercontent\.com)$/.test(host);
    } catch { return false; }
  });
  if (main?.pendingUser) return { ...empty, working: main.working };
  if (main?.working) return { text: main.text, html: main.html,
    links: sourceLinks(main.links), done: false, working: true };

  let candidate                        = null;
  for (const frame of capturePage.frames().filter(frame => frame !== capturePage.mainFrame())) {
    // Previous turns may retain completed research frames. Only the latest
    // turn's own frame can answer the current prompt.
    const current = await frame.frameElement().then(element => element.evaluate(node => {
      const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
      return turns.length === 0 || !!turns.at(-1)?.contains(node);
    })).catch(() => false);
    if (!current) continue;
    const report = await frame.evaluate(() => {
      const raw = document.body?.innerText ?? '';
      const text = raw.replace(/(?:\n\s*[0-9]){8,}/g, '')
        .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      const anchors = Array.from(document.querySelectorAll                   ('a[href^="http"]'))
        .map(anchor => anchor.href);
      const bare = (text.match(/https?:\/\/[^\s)\]]+/g) ?? [])
        .map(url => url.replace(/[).,\];:'"]+$/, ''));
      return {
        text, html: document.body?.innerHTML ?? '', links: [...anchors, ...bare],
        done: /Research completed in/i.test(raw),
        working: /\d[\d,]*\s+searches|Researching|Reading|Thinking|Deciding|Browsing|Searching|Seeking|Synthesi/i.test(raw),
      };
    }).catch(() => null);
    if (!report?.text) continue;
    if (!candidate || (report.done && !candidate.done) ||
      (report.done === candidate.done && report.text.length > candidate.text.length)) candidate = report;
  }
  if (candidate && (!apiShort || candidate.text.length > apiShort.text.length)) return { ...candidate, links: sourceLinks(candidate.links) };
  if (apiShort) return apiShort;
  if (main) {
    const links = sourceLinks(main.links);
    const done = main.done && !main.hasFrame && main.text.trim().length >= 2500 && links.length > 0;
    return { text: main.text.trim(), html: main.html, links, done, working: main.working };
  }
  return empty;
}
// Best-effort: if a deep-research plan/confirm form appears (the one you must
// accept), click its start button in whichever frame holds it.
async function acceptResearchForm() {
  for (const f of [page.mainFrame(), ...page.frames().filter((x) => x !== page.mainFrame())]) {
    const btn = f.locator('button:has-text("Start research"), button:has-text("Start now"), button:has-text("Begin research"), button:has-text("Confirm"), button:has-text("Go ahead"), button:has-text("Start")').first();
    if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); log('✓ Accepted deep-research plan/confirm form.'); return true; }
  }
  return false;
}

let finalText = '';
let acceptedForm = false;
let lastFrameKind = '';
let loggedIdleSample = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(POLL_S * 1000);
  let text = '', streaming = false, done = false;
  if (CHATGPT_DR) {
    const r = await chatgptReport();
    text = r.text; done = r.done; streaming = r.working && !done;
    lastFrameKind = `${done ? 'done' : r.working ? 'working' : 'idle'}:${text.length}`;
    if (!r.working && !done && text && !loggedIdleSample) { log(`CHATGPT_IDLE_SAMPLE ${JSON.stringify(text.replace(/\\s+/g, ' ').slice(0, 800))}`); loggedIdleSample = true; }
    if (!acceptedForm && !r.working && !done) {
      acceptedForm = await acceptResearchForm();
      if (!acceptedForm && text.length > 0 && text.length < 1500 && /\?\s*$/.test(text.trim())) {
        log(`→ ChatGPT iframe asked a question; auto-answering. sample=${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 500))}`);
        await composer.click().catch(() => {});
        await page.keyboard.insertText('Use reasonable defaults and proceed with the research now. No further clarification needed.');
        const s2 = page.locator(site.sendSel).first();
        if (await s2.isEnabled().catch(() => false)) await s2.click().catch(() => {});
        warnedClarify = true;
      }
    }
  } else if (SITE_KEY === 'chatgpt') {
    // Regular chat reads the same conversation JSON: since 2026-10-05 the
    // thread DOM has no [data-message-author-role], so the DOM read 0 chars
    // and a finished reply timed out.
    const r = await chatgptApiReport();
    text = r?.text || ''; done = !!r?.done; streaming = !!r?.working && !done;
  } else {
    text = await lastAssistantText();
    streaming = await isStreaming();
  }
  if (text.length !== lastLen) { lastLen = text.length; stableSince = Date.now(); }
  const stableFor = (Date.now() - stableSince) / 1000;

  // Grok / compose: clarifying question is a short assistant message ending in '?'
  if (!CHATGPT_DR && !streaming && !warnedClarify && text.length > 0 && text.length < 1500 && /\?\s*$/.test(text.trim().slice(-200))) {
    warnedClarify = true;
    log('⚠ Looks like a clarifying question — answer it in the browser; I keep waiting for the full report.');
  }
  // ChatGPT: a clarifying question can land in the MAIN thread before research
  // starts — auto-answer it so the run proceeds unattended (headless).
  if (CHATGPT_DR && !warnedClarify && !done && !streaming) {
    const mainQ = (await chatgptApiReport())?.text || await lastAssistantText();
    if (mainQ && mainQ.length < 1500 && /\?\s*$/.test(mainQ.trim().slice(-200))) {
      warnedClarify = true;
      log('→ ChatGPT asked a clarifying question — auto-answering to proceed.');
      await composer.click().catch(() => {});
      await page.keyboard.insertText('Use reasonable defaults and proceed with the research now. No further clarification needed.');
      const s2 = page.locator(site.sendSel).first();
      if (await s2.isEnabled().catch(() => false)) await s2.click().catch(() => {});
    }
  }

  if (CHATGPT_DR && done && !warnedClarify && text.length < 1500 && /\?\s*$/.test(text.trim().slice(-200))) {
    warnedClarify = true;
    log(`→ ChatGPT asked a clarifying question — auto-answering. sample=${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 300))}`);
    await composer.click().catch(() => {});
    await page.keyboard.insertText('Use reasonable defaults and proceed with the research now. No further clarification needed.');
    const s3 = page.locator(site.sendSel).first();
    if (await s3.isEnabled().catch(() => false)) await s3.click().catch(() => {}); else await page.keyboard.press('Enter');
    continue;
  }
  if (CHATGPT_DR) {
    if (done && text.length >= MIN_REPORT_CHARS && stableFor >= 15) { finalText = text; break; }
  } else {
    if (SITE_KEY === 'chatgpt' && done && text.length > 0 && stableFor >= 4) { finalText = text; break; }
    if (!streaming && text.length >= MIN_REPORT_CHARS && stableFor >= STABLE_S) { finalText = text; break; }
    if (!streaming && text.length > 0 && stableFor >= (COMPOSE ? 30 : 600)) { finalText = text; break; }
  }

  if (Date.now() - lastLogged > 60_000) {
    lastLogged = Date.now();
    const state = streaming ? 'researching' : (done ? 'finishing' : 'idle');
    log(`...${state} — report ${text.length} chars, stable ${Math.round(stableFor)}s`);
  }
}
if (!finalText) {
  if (CHATGPT_DR) {
    const r = await chatgptReport();
    const sample = r.text.replace(/\s+/g, ' ').slice(0, 800);
    console.error(`CHATGPT_DIAGNOSTIC frame=${lastFrameKind} done=${r.done} working=${r.working} chars=${r.text.length} sample=${JSON.stringify(sample)}`);
  }
  console.error(`\n✗ Timed out after ${TIMEOUT_MIN} min.${hostBrowser ? ` Conversation: ${page.url()}` : ' The browser stays open — copy the reply manually.'}`);
  if (hostBrowser) await closeSession();
  process.exit(3);
}

// ---------- extract & save ----------
let html = '', links = [];
if (CHATGPT_DR) {
  const r = await chatgptReport();
  if (r.text && r.text.length > finalText.length) finalText = r.text;
  links = r.links;
  html = r.html || '';
} else if (SITE_KEY === 'chatgpt') {
  const r = await chatgptApiReport();
  if (r?.text && r.text.length > finalText.length) finalText = r.text;
  links = [...new Set(r?.links || [])].filter((u) => !/^https:\/\/(chatgpt\.com|grok\.com)/.test(u));
} else {
  const msg = page.locator(site.assistantSel).last();
  html = await msg.innerHTML().catch(() => '');
  links = [...new Set(
    await msg.locator('a[href^="http"]').evaluateAll((as) => as.map((a) => a.href)).catch(() => [])
  )].filter((u) => !/^https:\/\/(chatgpt\.com|grok\.com)/.test(u));
}

let body = `\n${finalText.trim()}\n`;
body = `\n_[${SITE_KEY} · ${COMPOSE ? 'compose' : MODEL}]_\n${body}`;
if (links.length) body += `\n### Links cited\n${links.map((u) => `- ${u}`).join('\n')}\n`;

if (INTAKE) { appendFileSync(outPath, body); log(`✓ Appended ${finalText.length} chars + ${links.length} links to ${outPath}`); }
else { writeFileSync(outPath, body.trimStart()); log(`✓ Wrote ${finalText.length} chars + ${links.length} links to ${outPath}`); }
const htmlPath = outPath.replace(/\.md$/, '') + `.${SITE_KEY}.reply.html`;
writeFileSync(htmlPath, html);
log(`✓ Raw HTML (citation links preserved): ${htmlPath}`);

await closeSession();
