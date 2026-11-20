import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Features, selectCards, settingsOf } from '../public/rwkv-scheduler.js';
const now = Date.parse('2026-11-20T12:00:00Z');
test('ascending R ignores FSRS due dates and honours cooldown and max', () => {
 const cards = [{id:'a'},{id:'b'},{id:'c'}], scores={a:0.8,b:0.2,c:0.95};
 const history=[['a',now-1000,3]], cfg=settingsOf({max:10,min:0});
 assert.deepEqual(selectCards(cards,scores,history,cfg,now).map(c=>c.id),['b']);
 assert.deepEqual(selectCards(cards,scores,history,settingsOf({max:1}),now),[]);
});
test('minimum reviews includes strongest cards but never overrides cooldown or max', () => {
 const cards=[{id:'a'},{id:'b'}], scores={a:0.99,b:0.98};
 assert.deepEqual(selectCards(cards,scores,[],settingsOf({min:2}),now).map(c=>c.id),['b','a']);
 assert.equal(selectCards(cards,scores,[['a',now-1000,3]],settingsOf({min:2,max:1}),now).length,0);
});
test('feature queries are pure and replay is deterministic', () => {
 const a=new Features(), b=new Features(), c={id:'a',topic:'Science',created:now-86400000};
 assert.equal(a.build(c,now,0).length,92);
 assert.equal(a.build(c,now,0)[23],1);
 a.build({...c,id:'unseen'},now,0);
 a.commit(c,now,3); b.commit(c,now,3);
 assert.deepEqual(a.build(c,now+60000,0),b.build(c,now+60000,0));
 assert.equal(a.build(c,now+60000,0)[9],0);
});
test('settings clamp bad input and preserve defaults', () => {
 const s=settingsOf({retention:5,max:-1,min:500,cooldown:0});
 assert.equal(s.retention,0.99); assert.equal(s.max,1); assert.equal(s.min,1); assert.equal(s.cooldown,10);
 assert.equal(settingsOf().max,100);
});
