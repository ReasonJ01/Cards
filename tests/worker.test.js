import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RWKV } from '../public/rwkv.js';
import { Features } from '../public/rwkv-scheduler.js';
const root=new URL('../public/models/rwkv-sm98/',import.meta.url);
const weights=await readFile(new URL('weights.f32.bin',root)), spec=JSON.parse(await readFile(new URL('architecture.json',root)));
globalThis.fetch=async url=>new Response(await readFile(url));
let result;
globalThis.self={postMessage:r=>{result=r}};
await import('../public/rwkv-worker.js');
const now=Date.now(), cards=[{id:'a',topic:'Science',created:now-172800000,reps:1},{id:'b',topic:'Science',created:now-172800000,reps:1}];
const history=[['a',now-86400000,3,null,null],['b',now-86300000,1,null,null]];
async function run(cs,rows){await self.onmessage({data:{id:1,cards:cs,history:rows}});assert.equal(result.error,undefined);return result.scores}
function replay(cs,rows){const m=new RWKV(weights,spec),f=new Features();for(const [id,ts,g,d,shown] of rows){const c=cs.find(c=>c.id===id);m.run(f.commit(c,ts,g,d,shown??ts),[c.id,c.topic,c.id,'default','owner'],true)}return Object.fromEntries(cs.filter(c=>c.reps).map(c=>[c.id,1-m.run(f.build(c,Date.now()),[c.id,c.topic,c.id,'default','owner'])[0]]))}
function close(a,b){for(const id of Object.keys(a))assert.ok(Math.abs(a[id]-b[id])<0.002,`${id}: ${a[id]} vs ${b[id]}`)}
test('browser worker incremental answers match full replay; reset and rename rebuild safely',async()=>{
 close(await run(cards,history),replay(cards,history));
 const next=[...history,['a',now-60000,2,1000,now-61000]], updated=cards.map(c=>({...c,reps:c.id==='a'?2:1}));
 close(await run(updated,next),replay(updated,next));
 const reset=updated.map(c=>({...c,reps:c.id==='a'?1:0}));
 close(await run(reset,next),replay(reset,[next.at(-1)]));
 const renamed=reset.map(c=>({...c,topic:'Renamed'}));
 close(await run(renamed,next),replay(renamed,[next.at(-1)]));
});
