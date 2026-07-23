import { writeFileSync } from 'node:fs';
import { manifest } from '../dist/fbneo/fbneo.manifest.js';

const out = new URL('../dist/manifest.json', import.meta.url);
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote dist/manifest.json');
