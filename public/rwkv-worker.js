import { RWKV } from './rwkv.js';
import { Features } from './rwkv-scheduler.js';
let model, features, replay = [], metadata = '';
async function load() {
 const root = new URL('./models/rwkv-sm98/', import.meta.url);
 const [spec, weights] = await Promise.all(['architecture.json','weights.f32.bin'].map(async file => {
  const r=await fetch(new URL(file,root)); if(!r.ok) throw Error('RWKV model download failed');
  return file.endsWith('.json')?r.json():r.arrayBuffer();
 }));
 model=new RWKV(weights,spec); features=new Features();
}
let loading;
self.onmessage = async ({data:{id,cards,history}}) => {
 try {
  await (loading ||= load());
  const cardMap=new Map(cards.map(c=>[c.id,c])), nextMeta=JSON.stringify(cards.map(c=>[c.id,c.topic]));
  let rows=history.filter(r=>cardMap.has(r[0])).sort((a,b)=>a[1]-b[1] || String(a[0]).localeCompare(String(b[0])));
  // Replaying only the last N answers per card respects existing progress resets.
  const counts=new Map();
  rows=rows.slice().reverse().filter(r=>{ const n=(counts.get(r[0])||0)+1;counts.set(r[0],n);return n<=(cardMap.get(r[0]).reps||0) }).reverse();
  const prefix=rows.slice(0,replay.length);
  if(nextMeta!==metadata || JSON.stringify(prefix)!==JSON.stringify(replay)) {
   model.states=Array.from({length:5},()=>new Map()); features=new Features(); replay=[];
  }
  metadata=nextMeta;
  for(const row of rows.slice(replay.length)) {
   const [cid,ts,grade,duration,shown]=row, c=cardMap.get(cid);
   model.run(features.commit(c,ts,grade,duration,shown??ts),[c.id,c.topic,c.id,'default','owner'],true);
  }
  replay=rows;
  const scores={}, now=Date.now();
  for(const c of cards) if(c.reps) {
   scores[c.id]=1-model.run(features.build(c,now),[c.id,c.topic,c.id,'default','owner'])[0];
  }
  self.postMessage({id,scores});
 } catch(error) { self.postMessage({id,error:error.message}) }
};
