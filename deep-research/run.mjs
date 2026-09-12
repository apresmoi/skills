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
import { dirname, resolve, join } from 'node:path';
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
    defaultModel: 'Extra High',           // composer pill effort, deep-research mode
    setModel: async (page, label) => {
      const pill = page.locator('button.__composer-pill').first();
      if (!(await pill.isVisible().catch(() => false))) return false;
      if ((await pill.innerText().catch(() => '')).includes(label)) return true;
      await pill.click(); await page.waitForTimeout(800);
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
      const chat = page.locator('[data-tpp-toggle-value="chatgpt"]').first();
      const work = page.locator('[data-tpp-toggle-value="work"]').first();
      const selected = async (el) =>
        (await el.getAttribute('aria-checked').catch(() => null)) === 'true' ||
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
      const drItem = () => page.getByText(/^deep research$/i).first();
      const plus = page.locator('[data-testid="composer-plus-btn"]').first();
      await plus.click(); await page.waitForTimeout(900);
      if (!(await drItem().isVisible().catch(() => false))) {
        const more = page.getByText(/^(more|tools)$/i).first();
        if (await more.isVisible().catch(() => false)) { await more.hover(); await page.waitForTimeout(700); }
      }
      const dr = drItem();
      if (await dr.isVisible().catch(() => false)) { await dr.click(); await page.waitForTimeout(700); return true; }
      await page.keyboard.press('Escape'); return false;
    },
    sendSel: '[data-testid="send-button"]',
    streamingSel: '[data-testid="stop-button"]',
    assistantSel: '[data-message-author-role="assistant"]',
    healthPill: () => 'button.__composer-pill',
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
const TIMEOUT_MIN = Number(opt('timeout-min', COMPOSE ? '15' : '90'));
const POLL_S = COMPOSE ? 4 : 10;
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
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
});
if (firstRun) {
  const cookies = parseNetscapeCookies(COOKIES_PATH);
  await context.addCookies(cookies);
  log(`First run — seeded ${cookies.length} cookies into ${PROFILE_DIR}`);
}
const page = context.pages()[0] || await context.newPage();
process.on('SIGINT', async () => { log('Interrupted — closing browser.'); await context.close().catch(() => {}); process.exit(130); });

log(`[${SITE_KEY}] Opening ${site.url} ...`);
await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

const composer = page.locator(site.composer).first();
const ok = await composer.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
if (!ok) {
  console.error(`\n✗ Composer never appeared — ${SITE_KEY} cookies likely expired. Delete ${PROFILE_DIR} and re-export cookies.`);
  await page.screenshot({ path: `/tmp/${SITE_KEY}-research-login.png` });
  await context.close();
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
    await context.close();
    process.exit(2);
  }
}

if (CHECK) {
  await page.screenshot({ path: `/tmp/${SITE_KEY}-research-check.png` });
  log(`Check passed. Screenshot: /tmp/${SITE_KEY}-research-check.png`);
  await context.close();
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
  log(`${applied ? '✓' : '⚠'} Model/effort: requested "${MODEL}" · pill now shows "${pillAfter}"${applied ? '' : ' — NOT applied, fix before relying on output'}`);
  if (!applied) {
    await page.screenshot({ path: `/tmp/${SITE_KEY}-research-model-failed.png` });
    await context.close();
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

if (!researchOn || NO_SEND) {
  await waitForEnter(
    researchOn ? '→ --no-send: review in the browser, then press SEND there yourself.'
               : '→ Could not auto-configure. Set the tool/model in the browser, then SEND there.'
  );
} else {
  log('Sending in 8s — Ctrl+C to abort, or send in the browser yourself.');
  await page.waitForTimeout(8_000);
  const send = page.locator(site.sendSel).first();
  if (await send.isEnabled().catch(() => false)) await send.click();
  log('Sent.');
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
async function chatgptReport() {
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  let chosen = null, ci = null;
  for (const f of frames) {
    let info;
    try {
      info = await f.evaluate(() => {
        const t = (document.body && document.body.innerText) || '';
        return {
          len: t.length,
          done: /Research completed in/i.test(t),
          working: /\d[\d,]*\s+searches|Researching|Reading|Thinking|Deciding|Browsing|Searching|Seeking|Synthesi/i.test(t),
        };
      });
    } catch { continue; }
    if (!info.len) continue;
    if (!chosen || (info.done && !ci.done) || (info.done === ci.done && info.len > ci.len)) { chosen = f; ci = info; }
  }
  if (!chosen) return { text: '', links: [], done: false, working: false };
  const data = await chosen.evaluate(() => {
    let t = (document.body && document.body.innerText) || '';
    t = t.replace(/(?:\n\s*[0-9]){8,}/g, '');            // drop the animated digit-roll counter
    t = t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    const urls = [...new Set((t.match(/https?:\/\/[^\s)\]]+/g) || [])
      .map((u) => u.replace(/[).,\];:'"]+$/, '').replace(/\?utm_source=chatgpt\.com/, '')))]
      .filter((u) => !/openai\.com|oaiusercontent|chatgpt\.com/.test(u));
    return { text: t, urls };
  });
  return { text: data.text, links: data.urls, done: ci.done, working: ci.working };
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
    const mainQ = await lastAssistantText();
    if (mainQ && mainQ.length < 1500 && /\?\s*$/.test(mainQ.trim().slice(-200))) {
      warnedClarify = true;
      log('→ ChatGPT asked a clarifying question — auto-answering to proceed.');
      await composer.click().catch(() => {});
      await page.keyboard.insertText('Use reasonable defaults and proceed with the research now. No further clarification needed.');
      const s2 = page.locator(site.sendSel).first();
      if (await s2.isEnabled().catch(() => false)) await s2.click().catch(() => {});
    }
  }

  if (CHATGPT_DR) {
    if (done && text.length >= MIN_REPORT_CHARS && stableFor >= 15) { finalText = text; break; }
  } else {
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
  console.error(`\n✗ Timed out after ${TIMEOUT_MIN} min. The browser stays open — copy the reply manually.`);
  process.exit(3);
}

// ---------- extract & save ----------
let html = '', links = [];
if (CHATGPT_DR) {
  const r = await chatgptReport();
  if (r.text && r.text.length > finalText.length) finalText = r.text;
  links = r.links;
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

await context.close();
