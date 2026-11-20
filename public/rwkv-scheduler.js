// SM98 feature preparation adapted from JSchoreels/anki (AGPL-3.0-or-later).
import { seed } from './rwkv-id-seed.js';
const DAY = 86400000;
const localDay = ts => { const d = new Date(ts); return Math.floor((ts - d.getTimezoneOffset() * 60000) / DAY) };
const scale = (x, mean, std) => ((x === -1 ? 0 : Math.log(1.00001 + x)) - mean) / std;
class IdRng {
 constructor(state = seed, index = 4) { this.state = Uint32Array.from(state); this.index = index }
 clone() { return new IdRng(this.state, this.index) }
 next() {
  if (this.index >= 624) {
   for (let i = 0; i < 624; i++) {
    const y = (this.state[i] & 0x80000000) | (this.state[(i + 1) % 624] & 0x7fffffff);
    this.state[i] = this.state[(i + 397) % 624] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0);
   }
   this.index = 0;
  }
  let y = this.state[this.index++]; y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; return (y ^ (y >>> 18)) >>> 0;
 }
 encoding(n) { return Array.from({length:n}, () => this.next() % 4 - 1.5) }
}
export class Features {
 constructor() { this.cards = new Map(); this.encodings = new Map(); this.rng = new IdRng(); this.index = 0; this.today = null; this.todayReviews = -1; this.todayNew = 0; this.firstDay = null; this.previousDay = 0 }
 keys(c) { return ['card:'+c.id,'note:'+c.id,'deck:'+c.topic,'preset:0'] }
 build(c, ts, grade = 0, duration = null, shown = ts) {
  const prev = this.cards.get(c.id), query = !grade, observed = query ? shown : ts, rawDay = localDay(observed), day = this.firstDay == null ? 0 : rawDay - this.firstDay;
  // Show-time models use the interval to display, not answer time. Legacy logs lack display timestamps.
  const sec = prev ? Math.max(0, Math.floor((observed - prev.ts) / 1000)) : query ? Math.max(0, Math.floor((shown - c.created) / 1000)) : -1;
  const days = prev ? Math.max(0, rawDay - prev.rawDay) : query ? Math.max(0, rawDay - localDay(c.created)) : -1;
  const cumSec = (prev?.cumSec || 0) + sec, cumDays = (prev?.cumDays || 0) + days;
  const sameDay = this.today === day, todayReviews = (sameDay ? this.todayReviews : -1) + 1, todayNew = (sameDay ? this.todayNew : 0) + (prev ? 0 : 1);
  const cyclic = n => [Math.sin(n * 2 * Math.PI / 86400), Math.cos(n * 2 * Math.PI / 86400)];
  const f = [scale(days,1.51,1.62),scale(cumDays,2.14,2.25),scale(sec,9.96,5.21),...cyclic(sec),scale(cumSec,10.86,5.8),...cyclic(cumSec),query || duration == null ? 0 : (Math.log(10+duration)-8.9)/1.07,
   ...[1,2,3,4].map(g=>!query && grade===g ? 1:0),0,0,0,Math.log(Math.log(Math.E+Math.max(0,day-this.previousDay))),(day%7-3)/3,
   (Math.log(3+(prev ? this.cards.size-prev.newCount:0))-2.945)/2.011,(Math.log(3+(prev ? Math.max(0,this.index-prev.index-1):0))-4.64)/2.59,
   (Math.log(3+todayNew)-2.55)/1.41,(Math.log(3+todayReviews)-4.59)/1.3,0,query?1:0];
  const rng=this.rng.clone();
  this.keys(c).forEach((k,i)=>f.push(...(this.encodings.get(k)||rng.encoding(i<2?12:8))));
  for (const period of [3,7,30,100,365,3650,36500]) for (const d of [day,prev?.firstDay??day]) f.push(Math.sin((d%period)*2*Math.PI/period),Math.cos((d%period)*2*Math.PI/period));
  return Float32Array.from(f);
 }
 commit(c, ts, grade, duration = null, shown = ts) {
  const f=this.build(c,ts,grade,duration,shown), prev=this.cards.get(c.id), rawDay=localDay(ts), day=this.firstDay==null?0:rawDay-this.firstDay;
  this.keys(c).forEach((k,i)=>{ if(!this.encodings.has(k)) this.encodings.set(k,this.rng.encoding(i<2?12:8)) });
  if(this.firstDay==null) this.firstDay=rawDay;
  if(this.today!==day) { this.today=day; this.todayReviews=-1; this.todayNew=0 }
  this.todayReviews++; if(!prev) this.todayNew++;
  const sec=prev?Math.max(0,Math.floor((ts-prev.ts)/1000)):-1, days=prev?Math.max(0,rawDay-prev.rawDay):-1;
  this.cards.set(c.id,{ts,rawDay,cumSec:(prev?.cumSec||0)+sec,cumDays:(prev?.cumDays||0)+days,firstDay:prev?.firstDay??day,index:this.index++,newCount:this.cards.size+(prev?0:1)});
  this.previousDay=day; return f;
 }
}
export function settingsOf(raw = {}) {
 const num=(key,def,lo,hi)=>Number.isFinite(+raw[key])?Math.min(hi,Math.max(lo,+raw[key])):def;
 const max=Math.round(num('max',100,1,10000));
 return {enabled:raw.enabled!==false,retention:num('retention',0.9,0.7,0.99),max,min:Math.round(num('min',20,0,max)),cooldown:num('cooldown',30,10,3600)};
}
export function selectCards(cards, scores, history, config, now = Date.now()) {
 const today=localDay(now), reviews=history.filter(r=>localDay(r[1])===today);
 const left=Math.max(0,config.max-reviews.length); if(!left) return [];
 const last=new Map(); for(const [id,ts] of history) last.set(id,Math.max(ts,last.get(id)||0));
 const eligible=cards.filter(c=>Number.isFinite(scores[c.id]) && now-(last.get(c.id)||0)>=config.cooldown*1000).sort((a,b)=>scores[a.id]-scores[b.id] || a.id.localeCompare(b.id));
 const below=eligible.filter(c=>scores[c.id]<config.retention), minimum=Math.max(0,config.min-reviews.length);
 return eligible.slice(0,Math.min(left,Math.max(below.length,minimum)));
}
