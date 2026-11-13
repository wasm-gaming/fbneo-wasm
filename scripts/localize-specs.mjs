#!/usr/bin/env node
// Make dist/fbneo/ a closed set of modules: no bare specifiers left.
//
// tsc leaves `from '@wasm-gaming/engine-specs'` in the emitted JS, which a browser
// cannot resolve without a bundler or an import map. `build-specs` copies the
// contract's runtime next to the SDK (dist/fbneo/engine-specs.js, inside the
// package's `files`), and this rewrites the specifier to point at that copy — so
// `import FbneoSDK from '…/fbneo/fbneo.sdk.js'` works from any static server.
//
// Only the .js files: the .d.ts keep the bare specifier, because types come from the
// package dependency, which is where an editor or a bundler looks for them.
//
//   node scripts/localize-specs.mjs [dir]   # default: dist/fbneo

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist/fbneo';
const SPEC = '@wasm-gaming/engine-specs';
const LOCAL = './engine-specs.js';

if (!existsSync(join(dir, 'engine-specs.js'))) {
  console.error(`localize-specs: ${dir}/engine-specs.js is missing — run \`make build-specs\``);
  process.exit(1);
}

const pattern = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])@wasm-gaming\/engine-specs\2/g;
let rewritten = 0;
for (const name of readdirSync(dir)) {
  if (!name.endsWith('.js') || name === 'engine-specs.js') continue;
  const file = join(dir, name);
  const before = readFileSync(file, 'utf8');
  const after = before.replace(pattern, (_, lead, quote) => `${lead}${quote}${LOCAL}${quote}`);
  if (after !== before) {
    writeFileSync(file, after);
    rewritten++;
  }
  if (after.includes(`'${SPEC}'`) || after.includes(`"${SPEC}"`)) {
    console.error(`localize-specs: ${file} still names ${SPEC}`);
    process.exit(1);
  }
}

// The copied runtime must itself be closed, or the rewrite only moved the problem.
if (/^\s*import\s|\bfrom\s*['"][^./]/m.test(readFileSync(join(dir, 'engine-specs.js'), 'utf8'))) {
  console.error('localize-specs: engine-specs.js has imports of its own — it can no longer be copied as one file');
  process.exit(1);
}

console.log(`localize-specs: ${rewritten} module(s) now import ${LOCAL}`);
