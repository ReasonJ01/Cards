import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

test('MCP rejects unauthenticated requests before reading the database', async () => {
  const r = await worker.fetch(new Request('https://cards.reason.place/mcp', { method: 'POST', body: '{}' }), { ASSETS: { fetch: () => new Response('not found', {status:404}) } });
  assert.equal(r.status, 401);
});
