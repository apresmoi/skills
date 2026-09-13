#!/usr/bin/env node
// Named research exercises: a recipe with the blanks filled for one recurring
// question, kept outside the repo so it survives skill updates and stays private.
//   ~/.deep-research/exercises/<name>.md          the exercise (frontmatter + sections)
//   ~/.deep-research/exercises/<name>/runs/<ts>/  one dir per run: intake.md, run.json
import { mkdir, readdir, readFile, stat, writeFile, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOME = process.env.DEEP_RESEARCH_HOME ?? path.join(homedir(), ".deep-research");
const EX = path.join(HOME, "exercises");
const RECIPES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "recipes", "research");
const SENTINEL = "=== REPORT COMPLETE ===";

const USAGE = `deep-research exercises

  node exercise.mjs list                                  exercises and their run counts
  node exercise.mjs recipes                               built-in recipes to start from
  node exercise.mjs new <name> --from <recipe> | --blank  scaffold ~/.deep-research/exercises/<name>.md
  node exercise.mjs show <name>                           print the exercise
  node exercise.mjs render <name> --set k=v [--set k=v]   fill slots → runs/<ts>/intake.md (prints its path)
  node exercise.mjs runs <name>                           list runs with version and verdict
  node exercise.mjs log <name> --run <ts> --verdict "..." record how a run went

Exercise file: frontmatter (name, site, mode, slots, version), then
## Brief (with {slot} placeholders), ## Output contract, ## Verify, ## Changelog.
Tune by editing the brief, bumping version, and adding a changelog line.`;

const die = (m, c = 2) => { console.error(`exercise: ${m}`); process.exit(c); };
const parse = (argv) => { const pos = [], opt = {}, sets = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === "--set") { const [k, ...v] = argv[++i].split("="); sets[k] = v.join("="); } else if (a.startsWith("--")) { const n = argv[i + 1]; if (n === undefined || n.startsWith("--")) opt[a.slice(2)] = true; else opt[a.slice(2)] = argv[++i]; } else pos.push(a); } return { pos, opt, sets }; };
const slug = (s) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(s) ? s : die(`name must be lowercase letters, digits, dashes: ${s}`);

export const parseExercise = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error("missing frontmatter");
  const fm = {};
  for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  fm.slots = (fm.slots ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  fm.version = Number(fm.version ?? 1);
  const sections = {};
  let cur = null;
  for (const line of m[2].split("\n")) { const h = /^## (.+)$/.exec(line); if (h) { cur = h[1].trim().toLowerCase(); sections[cur] = []; } else if (cur) sections[cur].push(line); }
  for (const k of Object.keys(sections)) sections[k] = sections[k].join("\n").trim();
  return { ...fm, sections };
};

export const renderIntake = (ex, sets, name) => {
  const missing = ex.slots.filter((s) => !(s in sets));
  if (missing.length) throw new Error(`missing --set for: ${missing.join(", ")} (slots: ${ex.slots.join(", ")})`);
  const unknown = Object.keys(sets).filter((k) => !ex.slots.includes(k));
  if (unknown.length) throw new Error(`unknown slot(s): ${unknown.join(", ")}`);
  const fill = (t) => t.replace(/\{([a-z0-9_]+)\}/g, (_, k) => (k in sets ? sets[k] : `{${k}}`));
  const brief = fill(ex.sections.brief ?? "");
  const contract = ex.sections["output contract"] ?? "";
  const leftover = brief.match(/\{[a-z0-9_]+\}/g);
  if (leftover) throw new Error(`unfilled placeholders in brief: ${[...new Set(leftover)].join(", ")}`);
  const prompt = [brief, "", contract, contract.includes(SENTINEL) ? "" : `End with the literal line ${SENTINEL}`].filter(Boolean).join("\n").trim();
  const title = `${name} — ${ex.slots.map((s) => `${s}: ${sets[s]}`).join(" · ")} (v${ex.version}, ${ex.site}/${ex.mode})`;
  return `# ${title}\n\n\`\`\`\n${prompt}\n\`\`\`\n\n## Output\n`;
};

const exPath = (name) => path.join(EX, `${name}.md`);
const runsDir = (name) => path.join(EX, name, "runs");
const loadEx = async (name) => { try { return parseExercise(await readFile(exPath(name), "utf8")); } catch (e) { die(`cannot load exercise "${name}": ${e.message}`); } };

const main = async () => {
  const { pos, opt, sets } = parse(process.argv.slice(2));
  const [cmd, name] = pos;
  if (!cmd || cmd === "--help" || cmd === "-h") { console.log(USAGE); return; }

  if (cmd === "recipes") {
    for (const f of (await readdir(RECIPES)).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
      const ex = parseExercise(await readFile(path.join(RECIPES, f), "utf8"));
      console.log(`${f.slice(0, -3).padEnd(20)} ${ex.site}/${ex.mode}  slots: ${ex.slots.join(", ")}`);
    }
    return;
  }
  if (cmd === "list") {
    let names = []; try { names = (await readdir(EX)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort(); } catch { /* none */ }
    if (!names.length) { console.log(`no exercises in ${EX}`); return; }
    for (const n of names) { const ex = await loadEx(n); let runs = 0; try { runs = (await readdir(runsDir(n))).length; } catch { /* none */ } console.log(`${n.padEnd(24)} v${ex.version}  ${ex.site}/${ex.mode}  slots: ${ex.slots.join(", ") || "-"}  runs: ${runs}`); }
    return;
  }
  if (cmd === "new") {
    slug(name ?? die("usage: new <name> --from <recipe> | --blank"));
    await mkdir(EX, { recursive: true, mode: 0o700 });
    try { await stat(exPath(name)); die(`exercise "${name}" already exists at ${exPath(name)}`); } catch (e) { if (e.code !== "ENOENT") throw e; }
    let body;
    if (opt.from) {
      const src = path.join(RECIPES, `${opt.from}.md`);
      try { body = await readFile(src, "utf8"); } catch { die(`no built-in recipe "${opt.from}" (see: recipes)`); }
      body = body.replace(/^name: .*$/m, `name: ${name}`).replace(/^---\n([\s\S]*?)\n---/, (m0, fm) => `---\n${fm}\nversion: 1\n---`);
    } else if (opt.blank) {
      body = `---\nname: ${name}\nsite: grok\nmode: Expert\nslots: subject, window\nversion: 1\n---\n## Brief\n\nResearch {subject} over {window}.\n\n1. ...\n\n## Output contract\n\n- \`### Findings\`: ...\nEnd with \`${SENTINEL}\`.\n\n## Verify\n\n- ...\n`;
    } else die("choose --from <recipe> or --blank");
    body = body.trimEnd() + `\n\n## Changelog\n\n- v1 (${new Date().toISOString().slice(0, 10)}): created${opt.from ? ` from recipe ${opt.from}` : ""}\n`;
    await writeFile(exPath(name), body, { mode: 0o600 });
    console.log(`created ${exPath(name)}\nedit the brief, then: node exercise.mjs render ${name} --set ...`);
    return;
  }
  if (cmd === "show") { if (!name) die("usage: show <name>"); process.stdout.write(await readFile(exPath(name), "utf8")); return; }
  if (cmd === "render") {
    if (!name) die("usage: render <name> --set k=v");
    const ex = await loadEx(name);
    let intake; try { intake = renderIntake(ex, sets, name); } catch (e) { die(e.message); }
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = path.join(runsDir(name), ts);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "intake.md"), intake);
    await writeFile(path.join(dir, "run.json"), JSON.stringify({ exercise: name, version: ex.version, site: ex.site, mode: ex.mode, slots: sets, rendered_at: new Date().toISOString(), verdict: null }, null, 2) + "\n");
    console.log(path.join(dir, "intake.md"));
    console.error(`run with: node run.mjs --site ${ex.site} --model "${ex.mode}" --intake "${path.join(dir, "intake.md")}"`);
    return;
  }
  if (cmd === "runs") {
    if (!name) die("usage: runs <name>");
    let dirs = []; try { dirs = (await readdir(runsDir(name))).sort(); } catch { console.log("no runs"); return; }
    for (const d of dirs) { const r = JSON.parse(await readFile(path.join(runsDir(name), d, "run.json"), "utf8")); console.log(`${d}  v${r.version}  ${Object.entries(r.slots).map(([k, v]) => `${k}=${v}`).join(" ")}  ${r.verdict ?? "(no verdict)"}`); }
    return;
  }
  if (cmd === "log") {
    if (!name || !opt.run || !opt.verdict) die('usage: log <name> --run <ts> --verdict "..."');
    const f = path.join(runsDir(name), String(opt.run), "run.json");
    let r; try { r = JSON.parse(await readFile(f, "utf8")); } catch { die(`no run ${opt.run} for ${name}`); }
    r.verdict = String(opt.verdict); r.logged_at = new Date().toISOString();
    await writeFile(f, JSON.stringify(r, null, 2) + "\n");
    console.log(`logged ${name}/${opt.run}: ${r.verdict}`);
    return;
  }
  die(`unknown command ${cmd}\n\n${USAGE}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => die(e.message, 1));
