// Browser-only mock fixture. Never included in the deployed asset directory.
(() => {
window.__qa_errors=[];
addEventListener('error',e=>window.__qa_errors.push(e.message));
addEventListener('unhandledrejection',e=>window.__qa_errors.push(String(e.reason)));
localStorage.setItem('bloom-key','mock-only-not-a-real-credential');
const now=Date.now(), yesterday=now-86400000;
const cards=[
 {id:'testcard1',topic:'Test',q:'Test question one?',a:'Answer one',created:yesterday-86400000,updated:now,s:2,d:5,last:yesterday,due:now+86400000,reps:1,lapses:0},
 {id:'testcard2',topic:'Test',q:'Test question two?',a:'Answer two',created:yesterday-86400000,updated:now,s:2,d:5,last:yesterday,due:now+86400000,reps:1,lapses:0},
 {id:'testcard3',topic:'Test',q:'New test question?',a:'New answer',created:now,updated:now,reps:0,lapses:0}
];
const reviews=[['testcard1',yesterday,3,null,null],['testcard2',yesterday+1000,1,null,null]];
window.__fixture={cards,reviews};
const realFetch=window.fetch.bind(window);
window.fetch=async (url,opts={})=>{
 const path=String(url);if(!path.startsWith('/api')) return realFetch(url,opts);
 let value={};
 if(path.startsWith('/api/sync'))value={cards,stats:{},links:[],now:Date.now()};
 else if(path.startsWith('/api/history'))value=path.includes('after=')?{rows:reviews,cursor:reviews.length}:reviews;
 else if(path==='/api/reviews'){
  for(const r of JSON.parse(opts.body)){reviews.push([r.id,r.ts,r.grade,r.duration,r.shown]);Object.assign(cards.find(c=>c.id===r.id),r.state,{updated:Date.now()})}
  value={ok:true};
 }
 else if(path==='/api/status')value={claimed:true};
 return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
};
})();
