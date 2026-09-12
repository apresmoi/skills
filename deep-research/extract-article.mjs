import { readFileSync, writeFileSync } from 'node:fs';
const [, , inFile, outFile] = process.argv;
const raw = readFileSync(inFile, 'utf8');
const marker = raw.includes('_[grok · compose]_') ? '_[grok · compose]_' : '_[chatgpt · compose]_';
let seg = raw.split(marker).pop().split('### Links cited')[0];
let jsonStr = seg.slice(seg.indexOf('{'), seg.lastIndexOf('}') + 1);
// Compose models sometimes leave a trailing newline inside a string value
// (notably source_url). Trim whitespace inside url/string values that broke JSON.
jsonStr = jsonStr.replace(/("(?:source_url|source_id|retrieved_at)":\s*")([^"]*)"/g, (m, p1, p2) => p1 + p2.trim() + '"');
let a;
try { a = JSON.parse(jsonStr); }
catch (e) { console.error('PARSE FAIL:', e.message); process.exit(1); }
const name = (inFile.split('/').pop() || '').replace('.md', '').padEnd(24);
const evIds = (a.evidence_box || []).map((e) => e.source_note?.source_id);
const refsOk = JSON.stringify(a.refs) === JSON.stringify(evIds);
const deckE = /\[E\d+\]/.test(a.deck || '');
writeFileSync(outFile, JSON.stringify(a, null, 2) + '\n');
console.log(name, 'body:' + (a.body?.length), 'ev:' + evIds.length, 'refs✓:' + refsOk, 'deckE:' + deckE);
