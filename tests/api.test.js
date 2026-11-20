import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import worker from '../src/worker.js';
const sql = new DatabaseSync(':memory:');
for (const name of (await readdir(new URL('../migrations/', import.meta.url))).sort()) sql.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
const DB = {prepare(query) { let args = []; return {bind(...values) { args = values; return this },async first() { return sql.prepare(query).get(...args) },async all() { return {results:sql.prepare(query).all(...args)} },async raw() { const s=sql.prepare(query);s.setReturnArrays(true);return s.all(...args) },async run() { return {meta:{changes:sql.prepare(query).run(...args).changes}} }} },async batch(statements) { return Promise.all(statements.map(s=>s.run())) }};
async function call(path, method='GET', body, auth=true) { return worker.fetch(new Request('https://bloom.test/api'+path,{method,headers:auth?{authorization:'Bearer test-only-fixture-key'}:{},body:body?JSON.stringify(body):undefined}),{DB}) }
test('D1 migration and API retain review timing and reject invalid ratings', async () => {
 assert.equal((await call('/claim','POST',{key:'test-only-fixture-key'},false)).status,200);
 assert.equal((await call('/history','GET',null,false)).status,401);
 const added=await (await call('/cards','POST',{cards:[{id:'testcard',topic:'Test',q:'Question?',a:'Answer'}]})).json();assert.equal(added.added.length,1);
 const review={id:'testcard',ts:2000,grade:3,shown:1500,duration:500,state:{s:2,d:5,last:2000,due:900000,reps:1,lapses:0}};
 assert.equal((await call('/reviews','POST',[review])).status,200);
 assert.equal((await call('/reviews','POST',[review])).status,200);
 const rows=await (await call('/history')).json();assert.deepEqual(rows,[['testcard',2000,3,500,1500]]);
 assert.deepEqual(await (await call('/history?since=2001')).json(),[]);
 assert.equal((await call('/reviews','POST',[{...review,grade:5}])).status,400);
 assert.equal((await call('/reviews','POST',[{...review,shown:3000}])).status,400);
 const older={...review,ts:1000,shown:900,state:{...review.state,last:1000,reps:0}};
 await call('/reviews','POST',[older]);
 const incremental=await (await call('/history?after=1')).json();assert.deepEqual(incremental.rows,[['testcard',1000,3,500,900]]);assert.equal(incremental.cursor,2);
 const sync=await (await call('/sync')).json();assert.equal(sync.cards[0].last,2000);assert.equal(sync.cards[0].reps,1);
});
