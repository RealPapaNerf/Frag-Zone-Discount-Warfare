/**
 * Architecture guard: src/engine must stay renderer-free so the simulation can
 * run in Node, in a worker, or on a host peer with no canvas. Also keeps the
 * engine from reaching up into the client or the DOM.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const RULES = [
  {
    dir: 'src/engine',
    forbid: [
      { pattern: /from\s+['"]three['"]/, why: 'imports three.js' },
      { pattern: /from\s+['"]\.\.\/\.\.\/(render|client)\//, why: 'imports the render/client layer' },
      { pattern: /\b(document|window|navigator)\./, why: 'touches the DOM' },
    ],
  },
  {
    dir: 'src/render',
    forbid: [{ pattern: /from\s+['"]\.\.\/client\//, why: 'imports the client layer' }],
  },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

let failures = 0;
for (const rule of RULES) {
  const base = join(ROOT, rule.dir);
  let files;
  try { files = walk(base); } catch { continue; }
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const { pattern, why } of rule.forbid) {
      const lines = source.split('\n');
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
        if (pattern.test(line)) {
          console.error(`layering violation: ${relative(ROOT, file)}:${i + 1} ${why}\n  ${line.trim()}`);
          failures++;
        }
      });
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} layering violation(s). The engine stays pure.`);
  process.exit(1);
}
console.log('layering ok: src/engine is renderer-free');
