import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const text = await readFile(new URL('AGENTS.md', root), 'utf8');
const rules = text.slice(text.indexOf('## Where cards go'), text.indexOf('## Code layout')).trim();
if (!rules.includes('Writing good cards')) throw new Error('Card-writing rules missing from AGENTS.md');
await writeFile(new URL('src/card-rules.json', root), JSON.stringify(rules) + '\n');
