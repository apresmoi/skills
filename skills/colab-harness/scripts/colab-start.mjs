#!/usr/bin/env node
// colab-start — start a Colab runtime with no human in the loop, through Playwright.
// Drives a real Chrome with its own persistent profile (~/.colab-harness/chrome) that
// is signed into the Google account owning Colab, independent of whatever account the
// terminal, the Claude extension, or the default Chrome are on. Headless after the
// one-time headed sign-in.
//
//   node colab-start.mjs status                 headless: is the profile signed in? prints the account label
//   (sign-in is never typed: the user exports Google cookies and `colab.mjs auth install` seeds
//    them into the profile; colab-start reseeds from ~/.colab-harness/google-cookies.txt on demand)
//   node colab-start.mjs seed                   (re)create the profile from the cookie file, then verify
//   node colab-start.mjs start [--gpu L4] [--headed] [--no-wait]
//                                               open the notebook, pick the GPU, Run all, print the tunnel URL,
//                                               then keep the tab open (the notebook's watchdog cell) until the runtime is gone
//   node colab-start.mjs stop                   Runtime → Disconnect and delete runtime
//
// Playwright is resolved from an existing install (env PLAYWRIGHT_ROOT, this skill's
// node_modules, or any project listed in ~/.colab-harness/config.json "playwright_roots");
// nothing is downloaded. Uses the installed Google Chrome (channel "chrome").
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOME = process.env.COLAB_HARNESS_HOME ?? path.join(homedir(), ".colab-harness");
const PROFILE = path.join(HOME, "chrome");
const COOKIES = path.join(HOME, "google-cookies.txt");   // seeded by the user via `colab.mjs auth install`; never printed
const CONFIG = path.join(HOME, "config.json");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOTEBOOK = process.env.COLAB_NOTEBOOK ?? "https://colab.research.google.com/github/apresmoi/skills/blob/main/skills/colab-harness/Colab_Harness.ipynb";
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("--")) ?? "start";
const opt = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) { const k = argv[i].slice(2), v = argv[i + 1]; if (v !== undefined && !v.startsWith("--") && !["headed", "no-wait", "high-ram"].includes(k)) { opt[k] = v; i++; } else opt[k] = true; }
const GPU = String(opt.gpu ?? "L4").toUpperCase();
const log = (m) => console.error(`[colab-start ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright() {
  const cfg = JSON.parse(await readFile(CONFIG, "utf8").catch(() => "{}"));
  const roots = [process.env.PLAYWRIGHT_ROOT, path.join(HERE, ".."), ...(cfg.playwright_roots ?? []), process.cwd()].filter(Boolean);
  for (const r of roots) {
    try { const req = createRequire(path.join(r, "package.json")); const p = req("playwright"); if (p?.chromium) { log(`playwright from ${r}`); return p; } } catch { /* next */ }
  }
  console.error("colab-start: no Playwright install found. Point at one with PLAYWRIGHT_ROOT=<project with node_modules/playwright> or add it to " + CONFIG + ' as "playwright_roots": ["<dir>"]');
  process.exit(2);
}

async function launch(pw, headed) {
  await mkdir(PROFILE, { recursive: true, mode: 0o700 });
  return pw.chromium.launchPersistentContext(PROFILE, {
    channel: "chrome", headless: !headed, viewport: { width: 1440, height: 900 },
    ignoreDefaultArgs: ["--enable-automation"], args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  });
}

function parseNetscape(text) {
  const out = [];
  for (let line of text.split("\n")) {
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) { httpOnly = true; line = line.slice("#HttpOnly_".length); }
    if (!line.trim() || line.startsWith("#")) continue;
    let parts = line.split("\t"); if (parts.length < 7) parts = line.trim().split(/\s+/); if (parts.length < 7) continue;
    const [domain, , path_, secure, expires, name, ...v] = parts;
    out.push({ name, value: v.join("\t"), domain, path: path_, expires: Number(expires) > 0 ? Number(expires) : -1, secure: secure === "TRUE", httpOnly, sameSite: "Lax" });
  }
  return out;
}

async function seedProfile(pw) {
  // Fresh profile from the cookie file: the only way auth ever enters the profile.
  const text = await readFile(COOKIES, "utf8").catch(() => null);
  if (text === null) throw new Error("NO_COOKIES");
  const cookies = parseNetscape(text).filter((c) => /google\.com$|googleusercontent\.com$|colab\.research\.google\.com$/.test(c.domain.replace(/^\./, "")));
  if (!cookies.length) throw new Error("NO_COOKIES");
  await rm(PROFILE, { recursive: true, force: true });
  const ctx = await launch(pw, false);
  await ctx.addCookies(cookies);
  await ctx.close();
  log(`profile seeded with ${cookies.length} google cookies`);
  return cookies.length;
}

async function accountLabel(page) {
  // Colab's avatar carries aria-label "Google Account: Name (email)"; absent when signed out.
  const a = page.locator('[aria-label^="Google Account"]').first();
  try { return (await a.getAttribute("aria-label", { timeout: 8000 }))?.replace(/^Google Account:\s*/, "") ?? null; } catch { return null; }
}

async function openNotebook(page) {
  await page.goto(NOTEBOOK, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  if (/accounts\.google\.com/.test(page.url())) throw new Error("NOT_LOGGED_IN");
  await page.waitForSelector("colab-run-button, .cell, .notebook-content", { timeout: 60000 });
}

async function dismissDialogs(page) {
  for (const label of ["Run anyway", "Connect anyway", "OK", "Got it"]) {
    const b = page.getByRole("button", { name: label, exact: true }).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); log(`dismissed "${label}"`); await page.waitForTimeout(800); }
  }
}

async function menu(page, top, item) {
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: new RegExp(`^${top}$`) }).first().click();
  const it = page.getByText(item, { exact: true }).first();
  await it.waitFor({ timeout: 10000 });
  return it;
}

async function setRuntimeType(page) {
  await (await menu(page, "Runtime", "Change runtime type")).click();
  const dlg = page.locator("[role=dialog]").last();
  await dlg.waitFor({ timeout: 15000 });
  const radio = dlg.getByText(new RegExp(`^${GPU}(\\s+GPU)?$`)).first();
  if (!(await radio.count())) throw new Error(`GPU "${GPU}" is not offered in the runtime dialog`);
  await radio.click();
  if (opt["high-ram"]) { const hr = dlg.getByText("High-RAM", { exact: true }).first(); if (await hr.count()) await hr.click(); }
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  log(`runtime type: ${GPU}`);
  await page.waitForTimeout(1500);
}

async function waitForTunnel(page, timeoutMs = 6 * 60 * 1000) {
  const t0 = Date.now(); let lastGpu = null;
  while (Date.now() - t0 < timeoutMs) {
    await dismissDialogs(page);
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) return m[0];
    const g = text.match(/NVIDIA [^\n,]+/); if (g && g[0] !== lastGpu) { lastGpu = g[0]; log(`VM up: ${lastGpu}`); }
    const bad = text.match(/[^\n]*(?:Cannot connect to GPU backend|Unable to connect to the runtime|cannot currently connect)[^\n]*/i);
    if (bad) throw new Error("COLAB: " + bad[0].trim());
    await sleep(5000);
  }
  throw new Error(`TIMEOUT: no tunnel URL after ${Math.round(timeoutMs / 60000)} min`);
}

async function main() {
  const pw = await loadPlaywright();
  const profileExists = await stat(path.join(PROFILE, "Default")).then(() => true).catch(() => false);
  const cookiesExist = await stat(COOKIES).then(() => true).catch(() => false);
  if (cmd === "seed" || (!profileExists && cookiesExist)) {
    try { await seedProfile(pw); } catch (e) { if (e.message === "NO_COOKIES") { console.log("no google cookie file: run `node colab.mjs auth` for the export steps"); process.exit(3); } throw e; }
    if (cmd === "seed") { const c2 = await launch(pw, false); const pg = c2.pages()[0] ?? await c2.newPage(); await pg.goto("https://colab.research.google.com/", { waitUntil: "domcontentloaded", timeout: 60000 }); await pg.waitForTimeout(3000); const label = /accounts\.google\.com/.test(pg.url()) ? null : await accountLabel(pg); await c2.close(); console.log(label ? `signed in: ${label}` : "cookies did not sign in (expired or wrong account): re-export and `auth install` again"); process.exit(label ? 0 : 1); }
  }
  const ctx = await launch(pw, !!opt.headed); const page = ctx.pages()[0] ?? await ctx.newPage();
  try {
    if (cmd === "status") {
      await page.goto("https://colab.research.google.com/", { waitUntil: "domcontentloaded", timeout: 60000 }); await page.waitForTimeout(3000);
      const label = /accounts\.google\.com/.test(page.url()) ? null : await accountLabel(page);
      console.log(label ? `signed in: ${label}` : (cookiesExist ? "not signed in: cookies expired; re-export and `node colab.mjs auth install`" : "not signed in: no cookie file; run `node colab.mjs auth`")); process.exitCode = label ? 0 : 1; return;
    }
    if (cmd === "stop") {
      await openNotebook(page);
      const item = await menu(page, "Runtime", "Disconnect and delete runtime");
      if (!(await item.isEnabled().catch(() => false))) { console.log("no runtime attached"); return; }
      await item.click(); await page.waitForTimeout(800); await page.getByRole("button", { name: /^Yes$/ }).first().click().catch(() => {});
      console.log("runtime deleted"); return;
    }
    log(`opening the notebook (profile ${PROFILE}, ${opt.headed ? "headed" : "headless"})`);
    await openNotebook(page);
    log(`account: ${(await accountLabel(page)) ?? "unknown"}`);
    await dismissDialogs(page);
    await setRuntimeType(page);
    await (await menu(page, "Runtime", "Run all")).click();
    await page.waitForTimeout(1500); await dismissDialogs(page); log("Run all sent");
    const url = await waitForTunnel(page);
    log("tunnel up");
    await writeFile(path.join(HOME, "last-start.json"), JSON.stringify({ url, gpu: GPU, started: new Date().toISOString(), pid: process.pid }, null, 2) + "\n", { mode: 0o600 });
    console.log(url);
    if (!opt["no-wait"]) {
      // The tab must stay open: the notebook's last cell is the lease watchdog.
      log("holding the notebook tab open for the watchdog; exits when the runtime is gone");
      for (;;) {
        await sleep(30000);
        const alive = await fetch(url + "/health", { signal: AbortSignal.timeout(8000) }).then((r) => r.status !== 530).catch(() => false);
        if (!alive) { log("runtime gone"); break; }
        await dismissDialogs(page);
      }
    }
  } catch (e) {
    if (e.message === "NOT_LOGGED_IN") { console.error("colab-start: AUTH_EXPIRED: the Google cookies no longer sign in. Ask the user to re-export (node colab.mjs auth) and run `auth install`."); process.exit(3); }
    console.error("colab-start: " + e.message); process.exit(1);
  } finally { await ctx.close().catch(() => {}); }
}
main();
