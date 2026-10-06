#!/usr/bin/env node
// One long-lived Chrome per site profile, shared by every run.mjs as tabs.
//
// Chrome refuses to open one profile twice, so without this every research
// run waited for the previous one to close its browser. Run this once per site
// (a user service on the research box); run.mjs then attaches over the Chrome
// DevTools port and opens its own tab, so N runs share one logged-in browser.
//
//   node browser-host.mjs --site grok [--port 9241] [--profile grok]
//
// It records {port, pid} in $DEEP_RESEARCH_HOME/browsers/<profile>.json while
// it is up, and removes it on exit, so run.mjs falls back to launching its own
// browser when no host is running.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(SKILL_DIR, 'package.json'));
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const site = opt('site');
const DEFAULT_PORTS = { grok: 9241, chatgpt: 9242 };
const port = Number(opt('port', DEFAULT_PORTS[site]));
if (!site || !Number.isInteger(port)) { console.error('usage: browser-host.mjs --site <site> --port <port> [--profile <name>]'); process.exit(64); }
const profile = opt('profile', site);
const stateDir = process.env.DEEP_RESEARCH_HOME || join(process.env.HOME, '.deep-research');
const profileDir = join(stateDir, 'profiles', profile);
const hostFile = join(stateDir, 'browsers', `${profile}.json`);
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] [host:${profile}] ${m}`);

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--disable-blink-features=AutomationControlled',
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    // Background tabs must keep running their pages: a research tab is
    // rarely the visible one.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});
mkdirSync(dirname(hostFile), { recursive: true });
writeFileSync(hostFile, `${JSON.stringify({ site, profile, port, pid: process.pid, started: new Date().toISOString() })}\n`);
log(`up on 127.0.0.1:${port} (${profileDir})`);

let closing = false;
const shutdown = async (code) => {
  if (closing) return; closing = true;
  rmSync(hostFile, { force: true });
  await context.close().catch(() => undefined);
  log('closed');
  process.exit(code);
};
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
// Chrome gone (crash, manual close): exit so the service manager restarts us.
context.on('close', () => { if (!closing) { rmSync(hostFile, { force: true }); log('browser exited'); process.exit(1); } });
