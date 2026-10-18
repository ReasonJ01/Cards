import { review, preview } from './fsrs.js';

const KEY = 'bloom-v2', ROUND = 10, NEW_PER_DAY = 15, GILD_CHANCE = 1 / 12;
const XP = { 1: 4, 2: 8, 3: 10, 4: 12 };
const app = document.getElementById('app'), sheet = document.getElementById('sheet');

let st;
try { st = JSON.parse(localStorage.getItem(KEY)) } catch {}
st = { cards: {}, reviews: {}, outbox: [], pending: [], since: 0, xp: 0, streak: 0, lastDay: null, newDay: null, newCount: 0, ...st };
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)) } catch {} };

/* ---------- Server ---------- */
let apiKey = localStorage.getItem('bloom-key');
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey }, body: opts.body && JSON.stringify(opts.body) });
  if (res.status === 401) { localStorage.removeItem('bloom-key'); apiKey = null; gate(); throw new Error('unauthorized') }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  return res.json();
}
const STATS = ['xp', 'streak', 'lastDay', 'newDay', 'newCount'];
const statsOf = () => Object.fromEntries(STATS.map(k => [k, st[k]]));
// Writes are optimistic: they land in local state at once and queue here.
// sync() drains the queues in order (new cards before reviews of them) and
// retries with capped exponential backoff and full jitter until it succeeds.
const normTopic = t => t.trim().split(/\s*(?:›|>|::|\/)\s*/).filter(Boolean).join(' › ');
let syncing = null, again = false, attempt = 0, retryTimer;
function sync() {
  if (syncing) { again = true; return syncing }
  clearTimeout(retryTimer);
  syncing = syncOnce().then(ok => {
    syncing = null;
    if (ok) attempt = 0;
    else if (apiKey) retryTimer = setTimeout(sync, Math.random() * Math.min(60e3, 1e3 * 2 ** attempt++));
    if (again) { again = false; return sync() }
    return ok;
  });
  return syncing;
}
async function syncOnce() {
  try {
    if (st.pending.length) {
      const out = st.pending.slice(), r = await api('/cards', { method: 'POST', body: { cards: out } });
      for (const s of r.skipped) if (s.reason !== 'already added') {
        delete st.cards[s.id]; st.outbox = st.outbox.filter(o => o.id !== s.id); delete st.reviews[s.id];
        toast(s.reason === 'duplicate question in this topic' ? 'You already had that card' : 'A card couldn’t be saved: ' + s.reason);
      }
      st.pending = st.pending.slice(out.length); save();
    }
    if (st.outbox.length) { const out = st.outbox.slice(); await api('/reviews', { method: 'POST', body: out }); st.outbox = st.outbox.slice(out.length) }
    const r = await api('/sync?since=' + st.since);
    for (const c of r.cards) {
      if (c.deleted) { delete st.cards[c.id]; delete st.reviews[c.id]; continue }
      st.cards[c.id] = { id: c.id, topic: c.topic, q: c.q, a: c.a };
      // Local state wins while a review of this card is still waiting to upload.
      if (c.reps && !st.outbox.some(o => o.id === c.id)) st.reviews[c.id] = { s: c.s, d: c.d, last: c.last, due: c.due, reps: c.reps, lapses: c.lapses };
    }
    if ((r.stats.xp || 0) > st.xp) Object.assign(st, r.stats);
    st.since = r.cards.length ? Math.max(...r.cards.map(c => c.updated)) : st.since;
    await api('/stats', { method: 'PUT', body: statsOf() });
    save(); merge(); return true;
  } catch { save(); return false }
}

let deck = [];
const day = (t = Date.now()) => new Date(t - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const md = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/\n/g, '<br>');
const fmt = ms => { const m = ms / 6e4; return m < 60 ? Math.max(1, Math.round(m)) + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : m < 43200 ? Math.round(m / 1440) + 'd' : m < 525600 ? Math.round(m / 43200) + 'mo' : (m / 525600).toFixed(1) + 'y' };
const inTopic = (c, t) => !t || c.topic === t || c.topic.startsWith(t + ' › ');
const topics = () => [...new Set(deck.map(c => c.topic))].sort();

// Levels: level L starts at 50·L·(L−1) XP — quick early, slower later.
const levelOf = xp => Math.floor((1 + Math.sqrt(1 + xp / 12.5)) / 2);
const levelStart = L => 50 * L * (L - 1);

function newLeft() { if (st.newDay !== day()) { st.newDay = day(); st.newCount = 0 } return Math.max(0, NEW_PER_DAY - st.newCount) }
function ready(topic) {
  const now = Date.now(), cs = deck.filter(c => inTopic(c, topic));
  const due = cs.filter(c => st.reviews[c.id]?.due <= now).sort((a, b) => st.reviews[a.id].due - st.reviews[b.id].due);
  const fresh = cs.filter(c => !st.reviews[c.id]).slice(0, newLeft());
  return { due, fresh, total: due.length + fresh.length };
}

function toast(t) { document.querySelector('.toast')?.remove(); const e = Object.assign(document.createElement('div'), { className: 'toast', textContent: t }); document.body.append(e); setTimeout(() => e.remove(), 1600) }
function float(t) { const e = Object.assign(document.createElement('div'), { className: 'float', textContent: t }); document.body.append(e); setTimeout(() => e.remove(), 1000) }

/* ---------- Home ---------- */
function home() {
  round = null;
  const L = levelOf(st.xp), p = (st.xp - levelStart(L)) / (levelStart(L + 1) - levelStart(L));
  const all = ready(), C = 2 * Math.PI * 25;
  const rows = topics().map(t => { const r = ready(t); return `<button class="topic" data-t="${esc(t)}"><span>${esc(t)}</span><span class="${r.total ? 'hot' : ''}">${r.total ? r.total + ' ready' : '✓'}</span></button>` }).join('');
  app.innerHTML = `
    <div class="top">
      <div class="ring"><svg width="58" height="58"><circle cx="29" cy="29" r="25" fill="none" stroke="#ffffff14" stroke-width="4"/><circle cx="29" cy="29" r="25" fill="none" stroke="#c9a35a" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - p)}"/></svg><b>${L}</b></div>
      <div class="who"><div class="serif" style="font-size:20px">Level ${L}</div><small>${st.xp - levelStart(L)} / ${levelStart(L + 1) - levelStart(L)} xp</small></div>
      ${st.streak ? `<div class="streak">${st.streak} day${st.streak > 1 ? 's' : ''}</div>` : ''}
    </div>
    ${all.total ? `<button class="hero" data-t=""><div class="label" style="margin:0 0 8px">Everything</div><h2 class="serif">${all.total} ready</h2><small class="label" style="text-transform:none;letter-spacing:0;font-size:14px">A round is ${Math.min(ROUND, all.total)} card${Math.min(ROUND, all.total) > 1 ? 's' : ''}. Stop whenever.</small><div><span class="go">Play a round</span></div></button>`
      : `<div class="hero"><h2 class="serif">All caught up</h2><small style="color:var(--muted)">${deck.length ? 'Nothing is ready. Add something new, or come back later.' : 'No cards yet — tap + to add your first.'}</small></div>`}
    ${rows ? `<div class="label">Focus on a topic</div>${rows}` : ''}
    <button class="fab" aria-label="Add a card">+</button>`;
  app.querySelectorAll('[data-t]').forEach(b => b.onclick = () => start(b.dataset.t));
  app.querySelector('.fab').onclick = () => openAdd();
}

/* ---------- Round ---------- */
let round = null;
function start(topic) {
  const r = ready(topic);
  if (!r.total) return toast('Nothing ready here');
  // Interleave new cards among reviews so a round never feels like a wall of unknowns.
  const q = [...r.due.slice(0, ROUND)], fresh = r.fresh.slice(0, ROUND - Math.min(q.length, ROUND - Math.min(3, r.fresh.length)));
  q.length = Math.min(q.length, ROUND - fresh.length);
  fresh.forEach((c, i) => q.splice(Math.round((i + 1) * q.length / (fresh.length + 1)) + i, 0, c));
  round = { topic, queue: q, size: q.length, done: 0, xp: 0, combo: 0, best: 0, right: 0, startLevel: levelOf(st.xp), again: new Set() };
  next();
}
function next() {
  if (!round.queue.length) return summary();
  round.card = round.queue[0]; round.flipped = false; round.gilded = Math.random() < GILD_CHANCE;
  draw();
}
function draw() {
  const c = round.card, s = st.reviews[c.id];
  const iv = round.flipped ? preview(s || {}, Date.now()) : [];
  app.innerHTML = `
    <div class="bar"><button class="x" aria-label="End round">×</button><div class="progress"><i style="width:${100 * round.done / round.size}%"></i></div><div class="xp">${round.xp} xp</div></div>
    <div class="combo ${round.combo >= 3 ? 'on' : ''}">COMBO ×${mult().toFixed(1)}</div>
    <div class="card ${round.gilded ? 'gilded' : ''} ${round.flipped ? '' : 'enter'}">
      <div class="t">${round.gilded ? 'Gilded · ×5 xp' : esc(c.topic)}${s ? '' : ' · new'}</div>
      <div class="q serif">${md(c.q)}</div>
      ${round.flipped ? `<div class="a serif">${md(c.a)}</div>` : '<div class="tap">tap to reveal</div>'}
    </div>
    ${round.flipped ? `<div class="dock"><div class="grades">${['Again', 'Hard', 'Good', 'Easy'].map((n, i) => `<button class="g${i + 1}" data-g="${i + 1}">${n}<small>${fmt(iv[i])}</small></button>`).join('')}</div></div>` : ''}`;
  app.querySelector('.x').onclick = () => round.done ? summary() : home();
  app.querySelector('.card').onclick = () => { if (!round.flipped) { round.flipped = true; draw() } };
  app.querySelectorAll('[data-g]').forEach(b => b.onclick = () => grade(+b.dataset.g));
}
const mult = () => 1 + Math.min(round.combo, 10) * 0.1;

function grade(g) {
  const c = round.card, wasNew = !st.reviews[c.id];
  st.reviews[c.id] = review(st.reviews[c.id] || {}, g);
  st.outbox.push({ id: c.id, grade: g, ts: Date.now(), state: st.reviews[c.id] });
  if (wasNew) { newLeft(); st.newCount++ }
  round.combo = g === 1 ? 0 : round.combo + 1;
  round.best = Math.max(round.best, round.combo);
  const gain = Math.round(XP[g] * (g > 1 ? mult() : 1) * (round.gilded ? 5 : 1));
  round.xp += gain; st.xp += gain;
  float(`+${gain}`);
  round.queue.shift();
  // A missed card comes back once at the end of the round, so you finish on a win.
  if (g === 1 && !round.again.has(c.id)) { round.again.add(c.id); round.queue.push(c); round.size++ }
  else if (g > 1) round.right++;
  round.done++;
  const t = day();
  if (st.lastDay !== t) { st.streak = st.lastDay === day(Date.now() - 864e5) ? st.streak + 1 : 1; st.lastDay = t }
  save(); next(); sync();
}

// Variable reward: most draws are modest, a few are big, rarely a jackpot.
function draw_bonus() {
  const r = Math.random();
  if (r < .01) return [500, 'Jackpot'];
  if (r < .10) return [80 + (Math.random() * 70 | 0), 'Lucky'];
  if (r < .40) return [30 + (Math.random() * 30 | 0), 'Nice'];
  return [10 + (Math.random() * 15 | 0), 'Bonus'];
}
function summary() {
  const R = round, acc = R.done ? Math.round(100 * R.right / R.done) : 0;
  app.innerHTML = `<div class="summary">
    <div class="label" style="margin:0">Round complete</div>
    <h2 class="serif">${acc >= 90 ? 'Superb' : acc >= 70 ? 'Well played' : 'Good work'}</h2>
    <div class="stat"><div><b>${R.xp}</b><small class="label">xp</small></div><div><b>${acc}%</b><small class="label">recalled</small></div><div><b>${R.best}</b><small class="label">best combo</small></div></div>
    <button class="chest" id="chest">?</button><small id="cap" style="color:var(--muted)">Tap to draw your bonus</small>
    <div id="lvl"></div>
  </div>
  <div class="dock"><div><button class="btn" id="more" hidden>Another round</button><button class="btn ghost" id="done">Done</button></div></div>`;
  const chest = document.getElementById('chest');
  chest.onclick = () => {
    if (chest.classList.contains('open')) return;
    const [n, label] = draw_bonus();
    st.xp += n; save(); sync();
    chest.classList.add('open'); chest.textContent = '+' + n;
    document.getElementById('cap').textContent = label;
    const L = levelOf(st.xp);
    if (L > R.startLevel) document.getElementById('lvl').innerHTML = `<p class="levelup">Level ${L} reached</p>`;
    if (ready(R.topic).total) document.getElementById('more').hidden = false;
  };
  document.getElementById('more').onclick = () => start(R.topic);
  document.getElementById('done').onclick = home;
}

/* ---------- Add ---------- */
function openAdd() {
  let topic = localStorage.getItem('bloom-topic') || topics()[0] || '';
  const paint = () => {
    sheet.innerHTML = `<form>
      <div style="display:flex;justify-content:space-between;align-items:center"><span class="serif" style="font-size:20px">New card</span><button type="button" class="chip" data-close>Done</button></div>
      <div class="chips">${[...new Set([topic, ...topics()].filter(Boolean))].map(t => `<button type="button" class="chip ${t === topic ? 'on' : ''}" data-t="${esc(t)}">${esc(t)}</button>`).join('')}<button type="button" class="chip" data-new>+ topic</button></div>
      <input name="topic" placeholder="New topic" ${topic ? 'hidden' : ''} value="${esc(topic)}">
      <textarea name="q" placeholder="Question" required></textarea>
      <textarea name="a" placeholder="Answer" required></textarea>
      <button class="btn">Add card</button>
    </form>`;
    const f = sheet.querySelector('form');
    sheet.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { topic = b.dataset.t; paint() });
    sheet.querySelector('[data-new]').onclick = () => { f.topic.hidden = false; f.topic.value = ''; f.topic.focus() };
    f.onsubmit = async e => {
      e.preventDefault();
      topic = f.topic.value.trim() || topic || 'Inbox';
      topic = normTopic(topic);
      const card = { id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), topic, q: f.q.value.trim(), a: f.a.value.trim() };
      st.cards[card.id] = card; st.pending.push({ ...card, source: 'app' });
      save(); merge(); localStorage.setItem('bloom-topic', topic);
      home(); toast(`Added to ${topic}`); paint(); sync();
    };
    f.q.focus();
  };
  sheet.hidden = false; paint();
  sheet.onclick = e => { if (e.target === sheet || e.target.dataset.close != null) { sheet.hidden = true; home() } };
}

/* ---------- Boot ---------- */
const merge = () => { deck = Object.values(st.cards) };
function gate() {
  sheet.hidden = true;
  fetch('/api/status').then(r => r.json()).then(({ claimed }) => {
    app.innerHTML = `<div class="summary"><h2 class="serif">Bloom</h2>
      <p style="color:var(--muted);max-width:300px">${claimed ? 'Enter your key to unlock your cards on this device.' : 'Choose a key (12+ characters). You’ll use it on each device, and give it to agents that add cards.'}</p>
      <form id="k" style="width:100%;display:grid;gap:10px"><input name="k" type="password" autocomplete="current-password" placeholder="Key" required minlength="12"><button class="btn">${claimed ? 'Unlock' : 'Set key'}</button></form></div>`;
    document.getElementById('k').onsubmit = async e => {
      e.preventDefault(); const k = e.target.k.value;
      if (!claimed) { const r = await fetch('/api/claim', { method: 'POST', body: JSON.stringify({ key: k }) }); if (!r.ok) return toast((await r.json()).error) }
      apiKey = k; localStorage.setItem('bloom-key', k);
      if (await sync()) home(); else toast('That key didn’t work');
    };
  });
}
document.addEventListener('keydown', e => {
  if (!round?.card || !sheet.hidden || e.target.matches('input,textarea')) return;
  if (!round.flipped && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); round.flipped = true; draw() }
  else if (round.flipped && '1234'.includes(e.key)) grade(+e.key);
});
merge();
if (!apiKey) gate();
else { home(); sync().then(ok => { if (ok && !round && sheet.hidden) home() }) }
addEventListener('online', () => apiKey && sync());
addEventListener('visibilitychange', () => { if (!document.hidden && apiKey) sync().then(() => { if (!round && sheet.hidden) home() }) });
