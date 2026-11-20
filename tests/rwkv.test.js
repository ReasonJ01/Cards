import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RWKV } from '../public/rwkv.js';
const base = new URL('../public/models/rwkv-sm98/', import.meta.url);
const weights = await readFile(new URL('weights.f32.bin', base));
const spec = JSON.parse(await readFile(new URL('architecture.json', base)));
const vectors = JSON.parse(await readFile(new URL('./rwkv-sm98-vectors.json', import.meta.url)));
test('SM98 instant outputs match upstream sequential FP32 reference vectors', () => {
  const model = new RWKV(weights, spec);
  for (const [i, row] of vectors.entries()) {
    const p = model.run(row.features, row.ids, !row.skip);
    for (let g = 0; g < 4; g++) assert.ok(Math.abs(p[g] - row.fp32[g + 1]) < 0.0001, `row ${i}, grade ${g}: ${p[g]} vs ${row.fp32[g + 1]}`);
  }
});
test('querying does not change recurrent state', () => {
  const a = new RWKV(weights, spec), b = new RWKV(weights, spec);
  const row = vectors[0];
  a.run(row.features, row.ids, true); b.run(row.features, row.ids, true);
  a.run(vectors[1].features, vectors[1].ids, false);
  assert.deepEqual(a.run(row.features, row.ids, false), b.run(row.features, row.ids, false));
});
test('reject malformed model files', () => {
  assert.throws(() => new RWKV(new Uint8Array(20), spec));
  assert.throws(() => new RWKV(weights.subarray(0, 100), spec));
});
