import { review, preview, retrievability } from './fsrs.js';
import { stats } from './stats.js';
import { map } from './map.js';
import { parsePaste, normTopic, normQ } from './paste.js';
import { checkLink } from './dag.js';

const KEY = 'bloom-v2', ROUND = 10, NEW_PER_DAY = 15, GILD_CHANCE = 1 / 12;
const XP = { 1: 4, 2: 8, 3: 10, 4: 12 };
const app = document.getElementById('app'), sheet = document.getElementById('sheet');

let st;
try { st = JSON.parse(localStorage.getItem(KEY)) } catch {}
st = { cards: {}, reviews: {}, outbox: [], pending: [], ops: [], links: [], since: 0, xp: 0, streak: 0, lastDay: null, newDay: null, newCount: 0, ...st };
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)) } catch {} };

/* ---------- Server ---------- */
let apiKey = localStorage.getItem('bloom-key');
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey }, body: opts.body && JSON.stringify(opts.body) });
  if (res.status === 401) { localStorage.removeItem('bloom-key'); apiKey = null; gate(); throw new Error('unauthorized') }
  if (!res.ok) throw Object.assign(new Error((await res.json().catch(() => ({}))).error || res.status), { status: res.status });
  return res.json();
}
const STATS = ['xp', 'streak', 'lastDay', 'newDay', 'newCount'];
const statsOf = () => Object.fromEntries(STATS.map(k => [k, st[k]]));
// Writes are optimistic: they land in local state at once and queue here.
// sync() drains the queues in order (new cards before reviews of them) and
// retries with capped exponential backoff and full jitter until it succeeds.
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
    // Edits, deletes and topic renames, in the order they were made.
    while (st.ops.length) {
      const o = st.ops[0];
      try {
        if (o.kind === 'patch') await api('/cards/' + o.id, { method: 'PATCH', body: o.body });
        else if (o.kind === 'delete') await api('/cards/' + o.id, { method: 'DELETE' });
        else if (o.kind === 'bulk') await api('/cards/bulk', { method: 'POST', body: { ids: o.ids, ...o.body } });
        else if (o.kind === 'rename') await api('/topics/rename', { method: 'POST', body: { from: o.from, to: o.to } });
        else if (o.kind === 'link' || o.kind === 'unlink') await api('/links', { method: o.kind === 'link' ? 'POST' : 'DELETE', body: { topic: o.topic, requires: o.requires } });
      } catch (e) { if (e.status !== 404) throw e }
      st.ops.shift(); save();
    }
    if (st.outbox.length) { const out = st.outbox.slice(); await api('/reviews', { method: 'POST', body: out }); st.outbox = st.outbox.slice(out.length) }
    const r = await api('/sync?since=' + st.since);
    for (const c of r.cards) {
      if (c.deleted) { delete st.cards[c.id]; delete st.reviews[c.id]; continue }
      st.cards[c.id] = { id: c.id, topic: c.topic, q: c.q, a: c.a, explanation: c.explanation || '', created: c.created, flagged: c.flagged ? 1 : 0 };
      // Local state wins while a review of this card is still waiting to upload.
      if (!st.outbox.some(o => o.id === c.id)) {
        if (c.reps) st.reviews[c.id] = { s: c.s, d: c.d, last: c.last, due: c.due, reps: c.reps, lapses: c.lapses };
        else delete st.reviews[c.id]; // progress reset elsewhere
      }
    }
    // Ops are drained above, so the server's links are current.
    st.links = r.links || [];
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

// Motion: short, eased, and skipped entirely under prefers-reduced-motion.
const still = matchMedia('(prefers-reduced-motion: reduce)');
const ease = k => 1 - (1 - k) ** 3;
function countUp(el, from, to, ms = 600, show = n => n) {
  if (!el) return;
  if (still.matches || from === to) { el.textContent = show(to); return }
  const t0 = performance.now();
  const step = t => { const k = Math.min(1, (t - t0) / ms); el.textContent = show(Math.round(from + (to - from) * ease(k))); if (k < 1) requestAnimationFrame(step) };
  el.textContent = show(from); requestAnimationFrame(step);
}
const later = (fn, ms) => still.matches ? fn() : setTimeout(fn, ms);
let homeXp = null;

function toast(t) { document.querySelector('.toast')?.remove(); const e = Object.assign(document.createElement('div'), { className: 'toast', textContent: t }); document.body.append(e); setTimeout(() => e.remove(), 1600) }
function float(t) { const e = Object.assign(document.createElement('div'), { className: 'float', textContent: t }); document.body.append(e); setTimeout(() => e.remove(), 1000) }

/* ---------- Home ---------- */
let view = 'home';

// Home topic list as a collapsible tree: each row shows only its own name, and
// a parent's row studies (and counts) everything beneath it.
let open;
try { open = new Set(JSON.parse(localStorage.getItem('bloom-open')) || []) } catch { open = new Set() }
function topicTree() {
  const paths = new Set();
  for (const t of topics()) t.split(' › ').forEach((_, i, a) => paths.add(a.slice(0, i + 1).join(' › ')));
  const all = [...paths].sort((a, b) => a.localeCompare(b));
  return all.filter(p => { const a = p.split(' › '); return a.every((_, i) => i === a.length - 1 || open.has(a.slice(0, i + 1).join(' › '))) }).map(p => {
    const depth = p.split(' › ').length - 1, kids = all.some(q => q.startsWith(p + ' › ')), r = ready(p);
    return `<div class="trow" style="--d:${depth}">
      ${kids ? `<button class="tog ${open.has(p) ? 'open' : ''}" data-tog="${esc(p)}" aria-label="${open.has(p) ? 'Collapse' : 'Expand'} ${esc(p)}" aria-expanded="${open.has(p)}">›</button>` : '<span class="tog"></span>'}
      <button class="topic" data-t="${esc(p)}"><span>${esc(p.split(' › ').at(-1))}</span><span class="${r.total ? 'hot' : ''}">${r.total ? r.total + ' ready' : deck.filter(c => inTopic(c, p)).length + ' cards'}</span></button>
    </div>`;
  }).join('');
}

// Navigation: every screen and open sheet is a history entry, so browser
// back/forward (and Chrome's swipe gestures) move through the app.
function nav(state, replace) {
  const depth = (history.state?.depth ?? 0) + (replace ? 0 : 1);
  history[replace ? 'replaceState' : 'pushState']({ ...state, depth }, '', '#' + (state.v === 'home' ? '' : state.v));
}
function goBack() {
  if (history.state?.depth) return history.back();
  sheet.hidden = true; nav({ v: 'home' }, true); home();
}
const openSheet = () => { if (sheet.hidden) nav({ v: view, sheet: true }); sheet.hidden = false };
addEventListener('popstate', e => {
  const s = e.state || { v: 'home' };
  sheet.hidden = true;
  // A closed sheet or a finished round can't be resumed by going forward: step back off it.
  if (s.sheet || s.v === 'study' || s.v === 'summary') return history.back();
  if (s.v === 'library') library(); else if (s.v === 'stats') showStats(); else if (s.v === 'map') showMap(); else home();
});
function home() {
  round = null; view = 'home';
  const L = levelOf(st.xp), span = levelStart(L + 1) - levelStart(L), p = (st.xp - levelStart(L)) / span;
  const from = homeXp == null ? st.xp : Math.max(levelStart(L), homeXp), p0 = (from - levelStart(L)) / span;
  homeXp = st.xp;
  const all = ready(), C = 2 * Math.PI * 25;
  const rows = topicTree();
  app.innerHTML = `
    <div class="top">
      <div class="ring"><svg width="58" height="58"><circle cx="29" cy="29" r="25" fill="none" stroke="#ffffff14" stroke-width="4"/><circle cx="29" cy="29" r="25" fill="none" stroke="#c9a35a" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - p0)}" id="ring"/></svg><b>${L}</b></div>
      <div class="who"><div class="serif" style="font-size:20px">Level ${L}</div><small><span id="lvxp">${from - levelStart(L)}</span> / ${span} xp</small></div>
      ${st.streak ? `<div class="streak">${st.streak} day${st.streak > 1 ? 's' : ''}</div>` : ''}
    </div>
    ${all.total ? `<button class="hero" data-t=""><div class="label" style="margin:0 0 8px">Everything</div><h2 class="serif">${all.total} ready</h2><small class="label" style="text-transform:none;letter-spacing:0;font-size:14px">A round is ${Math.min(ROUND, all.total)} card${Math.min(ROUND, all.total) > 1 ? 's' : ''}. Stop whenever.</small><div><span class="go">Play a round</span></div></button>`
      : `<div class="hero"><h2 class="serif">All caught up</h2><small style="color:var(--muted)">${deck.length ? 'Nothing is due. Come back later, add something new, or get ahead on the cards you’re closest to forgetting.' : 'No cards yet — tap + to add your first.'}</small>${ahead('').length ? '<div><button class="go" id="ahead">Review ahead</button></div>' : ''}</div>`}
    ${rows ? `<div class="label">Focus on a topic</div>${rows}` : ''}
    ${deck.length ? `<div class="links"><button class="topic" id="lib">Manage cards</button><button class="topic" id="stats">Statistics</button><button class="topic" id="map">Knowledge map</button></div>` : ''}
    <button class="fab" aria-label="Add a card">+</button>`;
  document.getElementById('lib')?.addEventListener('click', () => { nav({ v: 'library' }); library() });
  document.getElementById('stats')?.addEventListener('click', () => { nav({ v: 'stats' }); showStats() });
  document.getElementById('map')?.addEventListener('click', () => { nav({ v: 'map' }); showMap() });
  requestAnimationFrame(() => requestAnimationFrame(() => { const ring = document.getElementById('ring'); if (ring) ring.style.strokeDashoffset = C * (1 - p) }));
  countUp(document.getElementById('lvxp'), from - levelStart(L), st.xp - levelStart(L), 800);
  app.querySelectorAll('[data-t]').forEach(b => b.onclick = () => start(b.dataset.t));
  document.getElementById('ahead')?.addEventListener('click', () => start('', false, true));
  app.querySelectorAll('[data-tog]').forEach(b => b.onclick = () => {
    const t = b.dataset.tog; open.has(t) ? open.delete(t) : open.add(t);
    try { localStorage.setItem('bloom-open', JSON.stringify([...open])) } catch {}
    home();
  });
  app.querySelector('.fab').onclick = () => openEditor();
}

/* ---------- Round ---------- */
let round = null;
// Review ahead: studied cards that aren't due yet, the ones FSRS thinks you're
// closest to forgetting first. FSRS discounts early reviews on its own, so this
// can't inflate intervals.
function ahead(topic) {
  const now = Date.now(), rec = c => { const s = st.reviews[c.id]; return retrievability((now - s.last) / 864e5, s.s) };
  return deck.filter(c => inTopic(c, topic) && st.reviews[c.id]?.due > now).sort((a, b) => rec(a) - rec(b));
}

// A round's cards. Picking a topic (or Review ahead) is a deliberate choice, so
// it always gets a full round: due cards, then that topic's new cards with no
// daily cap, then studied cards topped up weakest-first. The Everything round
// keeps to the schedule and the new-card cap.
function buildQueue(topic, chosen) {
  const r = ready(topic);
  const fresh = topic ? deck.filter(c => inTopic(c, topic) && !st.reviews[c.id]) : r.fresh;
  // Interleave new cards among reviews so a round never feels like a wall of unknowns.
  const q = r.due.slice(0, ROUND), f = fresh.slice(0, ROUND - Math.min(q.length, ROUND - Math.min(3, fresh.length)));
  q.length = Math.min(q.length, ROUND - f.length);
  f.forEach((c, i) => q.splice(Math.round((i + 1) * q.length / (f.length + 1)) + i, 0, c));
  if (chosen) q.push(...ahead(topic).slice(0, ROUND - q.length));
  return q;
}

function start(topic, replace, early) {
  const chosen = !!topic || !!early, q = buildQueue(topic, chosen);
  if (!q.length) return toast(topic ? 'No cards in this topic yet' : 'Nothing ready');
  nav({ v: 'study' }, replace);
  round = { shown: 0, pct: 0, topic, chosen, queue: q, size: q.length, done: 0, xp: 0, combo: 0, best: 0, right: 0, startLevel: levelOf(st.xp), again: new Set() };
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
    <div class="bar"><button class="x" aria-label="End round">×</button><div class="progress"><i style="width:${round.pct || 0}%"></i></div><button class="flag ${c.flagged ? 'on' : ''}" aria-label="Flag this card as poorly written" aria-pressed="${!!c.flagged}">⚑</button><div class="xp">${round.shown} xp</div></div>
    <div class="combo ${round.combo >= 3 ? 'on' : ''}">COMBO ×${mult().toFixed(1)}</div>
    <div class="card ${round.gilded ? 'gilded' : ''} ${round.flipped ? '' : 'enter'}">
      <div class="t">${round.gilded ? 'Gilded · ×5 xp' : esc(c.topic)}${!s ? ' · new' : s.due > Date.now() ? ` · ahead, due in ${fmt(s.due - Date.now())}` : ''}</div>
      <div class="q serif">${md(c.q)}</div>
      ${round.flipped ? `<div class="a serif">${md(c.a)}</div>${c.explanation ? `<div class="ex">${md(c.explanation)}</div>` : ''}` : '<div class="tap">tap to reveal</div>'}
    </div>
    ${round.flipped ? `<div class="dock"><div class="grades">${['Again', 'Hard', 'Good', 'Easy'].map((n, i) => `<button class="g${i + 1}" data-g="${i + 1}">${n}<small>${fmt(iv[i])}</small></button>`).join('')}</div></div>` : ''}`;
  const pct = 100 * round.done / round.size, bar = app.querySelector('.progress i');
  requestAnimationFrame(() => requestAnimationFrame(() => bar.style.width = pct + '%'));
  countUp(app.querySelector('.xp'), round.shown, round.xp, 450, n => n + ' xp');
  round.pct = pct; round.shown = round.xp;
  app.querySelector('.x').onclick = () => round.done ? summary() : goBack();
  app.querySelector('.flag').onclick = e => {
    editCard(c, { flagged: c.flagged ? 0 : 1 });
    e.currentTarget.classList.toggle('on', !!c.flagged); e.currentTarget.setAttribute('aria-pressed', !!c.flagged);
    toast(c.flagged ? 'Flagged for a rewrite' : 'Unflagged');
  };
  app.querySelector('.card').onclick = () => { if (!round.flipped) { round.flipped = true; draw() } };
  app.querySelectorAll('[data-g]').forEach(b => b.onclick = () => grade(+b.dataset.g));
}
const mult = () => 1 + Math.min(round.combo, 10) * 0.1;

function grade(g) {
  if (round.busy) return;
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
  save(); sync();
  round.busy = true;
  app.querySelector('.card').classList.add('leave');
  app.querySelector('.dock')?.classList.add('leave');
  later(() => { round.busy = false; next() }, 170);
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
  nav({ v: 'summary' }, true);
  const R = round, acc = R.done ? Math.round(100 * R.right / R.done) : 0;
  app.innerHTML = `<div class="summary">
    <div class="label" style="margin:0">Round complete</div>
    <h2 class="serif">${acc >= 90 ? 'Superb' : acc >= 70 ? 'Well played' : 'Good work'}</h2>
    <div class="stat"><div><b data-to="${R.xp}">0</b><small class="label">xp</small></div><div><b data-to="${acc}" data-pct>0%</b><small class="label">recalled</small></div><div><b data-to="${R.best}">0</b><small class="label">best combo</small></div></div>
    <button class="chest" id="chest">?</button><small id="cap" style="color:var(--muted)">Tap to draw your bonus</small>
    <div id="lvl"></div>
  </div>
  <div class="dock"><div><button class="btn" id="more" hidden>Another round</button><button class="btn ghost" id="done">Done</button></div></div>`;
  app.querySelectorAll('[data-to]').forEach((b, i) => later(() => countUp(b, 0, +b.dataset.to, 700, n => b.dataset.pct != null ? n + '%' : n), 150 + i * 120));
  const chest = document.getElementById('chest');
  chest.onclick = () => {
    if (chest.classList.contains('open')) return;
    const [n, label] = draw_bonus();
    st.xp += n; save(); sync();
    chest.classList.add('open'); countUp(chest, 0, n, n >= 100 ? 1200 : 700, v => '+' + v);
    document.getElementById('cap').textContent = label;
    const L = levelOf(st.xp);
    if (L > R.startLevel) later(() => { const el = document.getElementById('lvl'); if (el) el.innerHTML = `<p class="levelup">Level ${L} reached</p>` }, 800);
    if (buildQueue(R.topic, R.chosen).length) document.getElementById('more').hidden = false;
  };
  document.getElementById('more').onclick = () => start(R.topic, true, R.chosen);
  document.getElementById('done').onclick = goBack;
}

/* ---------- Add ---------- */
/* ---------- Library ---------- */
let lib = { q: '', topic: '', filter: 'all', sort: 'topic', selecting: false, sel: new Set() }, searchTimer;
const status = c => { const s = st.reviews[c.id]; return !s ? 'new' : s.due <= Date.now() ? 'ready' : 'in ' + fmt(s.due - Date.now()) };
const recallOf = c => { const s = st.reviews[c.id]; return s ? retrievability((Date.now() - s.last) / 864e5, s.s) : null };
const FILTERS = {
  all: ['All', () => true],
  due: ['Ready', c => st.reviews[c.id]?.due <= Date.now()],
  new: ['New', c => !st.reviews[c.id]],
  struggling: ['Struggling', c => (st.reviews[c.id]?.lapses || 0) >= 2],
  flagged: ['⚑ Flagged', c => c.flagged],
  explained: ['Has explanation', c => !!c.explanation],
};
const SORTS = {
  topic: ['Topic', (a, b) => a.topic.localeCompare(b.topic) || (a.created || 0) - (b.created || 0)],
  newest: ['Newest', (a, b) => (b.created || 0) - (a.created || 0)],
  weakest: ['Weakest recall', (a, b) => (recallOf(a) ?? 2) - (recallOf(b) ?? 2)],
  lapses: ['Most forgotten', (a, b) => (st.reviews[b.id]?.lapses || 0) - (st.reviews[a.id]?.lapses || 0)],
  due: ['Due soonest', (a, b) => (st.reviews[a.id]?.due ?? Infinity) - (st.reviews[b.id]?.due ?? Infinity)],
};

// Apply a change to many cards: locally at once, then one bulk request.
function bulk(ids, body) {
  for (const id of ids) {
    const c = st.cards[id]; if (!c) continue;
    if (body.delete) { delete st.cards[id]; delete st.reviews[id]; st.outbox = st.outbox.filter(o => o.id !== id) }
    if (body.topic) c.topic = body.topic;
    if ('flagged' in body) c.flagged = body.flagged ? 1 : 0;
    if (body.reset) { delete st.reviews[id]; st.outbox = st.outbox.filter(o => o.id !== id) }
  }
  // Cards still waiting to upload are simply changed (or dropped) in the queue.
  const queued = new Set(st.pending.map(p => p.id));
  if (body.delete) st.pending = st.pending.filter(p => !ids.includes(p.id));
  else st.pending.forEach(p => { if (ids.includes(p.id) && body.topic) p.topic = body.topic });
  const live = ids.filter(id => !queued.has(id) || !body.delete);
  if (live.length) st.ops.push({ kind: 'bulk', ids: live, body });
  save(); merge(); sync();
}

function library() {
  round = null; view = 'library';
  const q = lib.q.toLowerCase();
  if (lib.topic && !deck.some(c => inTopic(c, lib.topic))) lib.topic = '';
  const scoped = deck.filter(c => inTopic(c, lib.topic) && (!q || (c.q + '\n' + c.a + '\n' + (c.explanation || '')).toLowerCase().includes(q)));
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, [, f]]) => [k, scoped.filter(f).length]));
  if (lib.filter !== 'all' && !counts[lib.filter]) lib.filter = 'all';
  const cs = scoped.filter(FILTERS[lib.filter][1]).sort(SORTS[lib.sort][1]);
  // Only cards on screen can stay selected, so a bulk action never touches hidden cards.
  const shown = new Set(cs.map(c => c.id));
  for (const id of lib.sel) if (!shown.has(id)) lib.sel.delete(id);
  const grouped = lib.sort === 'topic';
  let html = '', last = null;
  for (const c of cs.slice(0, 400)) {
    if (grouped && c.topic !== last) { last = c.topic; html += `<div class="group"><span>${esc(c.topic)}</span>${lib.selecting ? '' : `<button class="chip" data-rename="${esc(c.topic)}">Rename</button>`}</div>` }
    const on = lib.sel.has(c.id), r = recallOf(c), lapses = st.reviews[c.id]?.lapses || 0;
    html += `<button class="row ${lib.selecting ? 'pick' : ''} ${on ? 'on' : ''}" data-id="${c.id}">
      ${lib.selecting ? `<i class="tick" aria-hidden="true">${on ? '✓' : ''}</i>` : ''}
      <div><div class="serif">${md(c.q.replace(/\s*\n\s*/g, ' '))}</div><small>${md(c.a.replace(/\s*\n\s*/g, ' '))}</small>${grouped ? '' : `<small class="tp">${esc(c.topic)}</small>`}</div>
      <span>${c.flagged ? '<b class="fl">⚑</b> ' : ''}${status(c)}${r != null ? `<br><em>${Math.round(r * 100)}%${lapses ? ` · ${lapses}×` : ''}</em>` : ''}</span></button>`;
  }
  const n = lib.sel.size;
  app.innerHTML = `
    <div class="bar"><button class="x" aria-label="Back">←</button><div class="serif" style="flex:1;font-size:22px">Library</div>
      <button class="chip ${lib.selecting ? 'on' : ''}" id="select">${lib.selecting ? 'Done' : 'Select'}</button>${lib.selecting ? '' : '<button class="chip" id="import">Paste</button>'}</div>
    <input id="search" type="search" placeholder="Search questions, answers, explanations" value="${esc(lib.q)}">
    <div class="chips" style="margin:12px 0 0"><button class="chip ${lib.topic ? '' : 'on'}" data-f="">All topics</button>${topics().map(t => `<button class="chip ${t === lib.topic ? 'on' : ''}" data-f="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <div class="chips" style="margin:8px 0 0">${Object.entries(FILTERS).filter(([k]) => k === 'all' || counts[k]).map(([k, [label]]) => `<button class="chip ${lib.filter === k ? 'on' : ''}" data-filter="${k}">${label} <b>${counts[k]}</b></button>`).join('')}</div>
    <div class="libmeta"><span>${cs.length} card${cs.length === 1 ? '' : 's'}${cs.length > 400 ? ' · showing 400' : ''}</span>
      <label>Sort <select id="sort">${Object.entries(SORTS).map(([k, [label]]) => `<option value="${k}" ${lib.sort === k ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
    ${lib.selecting ? `<div class="selrow"><button class="chip" id="selall">Select all ${cs.length}</button>${n ? '<button class="chip" id="selnone">Clear</button>' : ''}<span>${n} selected</span></div>` : ''}
    <div class="list">${html || '<p class="empty">No cards match.</p>'}</div>
    ${lib.selecting ? `<div class="dock bulkdock"><div><div class="bulk">
        <button data-act="move" ${n ? '' : 'disabled'}>Move</button>
        <button data-act="flag" ${n ? '' : 'disabled'}>⚑ Flag</button>
        <button data-act="unflag" ${n ? '' : 'disabled'}>Unflag</button>
        <button data-act="copy" ${n ? '' : 'disabled'}>Copy</button>
        <button data-act="rewrite" ${n ? '' : 'disabled'}>Copy for rewrite</button>
        <button data-act="reset" ${n ? '' : 'disabled'}>Reset progress</button>
        <button data-act="delete" class="danger" ${n ? '' : 'disabled'}>Delete</button>
      </div></div></div>` : '<button class="fab" aria-label="Add a card">+</button>'}`;
  app.querySelector('.x').onclick = goBack;
  const s = document.getElementById('search');
  s.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { lib.q = s.value; const pos = s.selectionStart; library(); const n = document.getElementById('search'); n.focus(); n.setSelectionRange(pos, pos) }, 150);
  };
  app.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { lib.topic = b.dataset.f; library() });
  app.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { lib.filter = b.dataset.filter; library() });
  document.getElementById('sort').onchange = e => { lib.sort = e.target.value; library() };
  document.getElementById('select').onclick = () => { lib.selecting = !lib.selecting; lib.sel.clear(); library() };
  document.getElementById('import')?.addEventListener('click', openImport);
  document.getElementById('selall')?.addEventListener('click', () => { cs.forEach(c => lib.sel.add(c.id)); library() });
  document.getElementById('selnone')?.addEventListener('click', () => { lib.sel.clear(); library() });
  app.querySelectorAll('[data-id]').forEach(b => b.onclick = () => {
    if (!lib.selecting) return openEditor(st.cards[b.dataset.id]);
    lib.sel.has(b.dataset.id) ? lib.sel.delete(b.dataset.id) : lib.sel.add(b.dataset.id);
    const keep = scrollY; library(); scrollTo(0, keep);
  });
  app.querySelectorAll('[data-rename]').forEach(b => b.onclick = () => renameTopic(b.dataset.rename));
  app.querySelector('.fab')?.addEventListener('click', () => openEditor());
  app.querySelectorAll('[data-act]').forEach(b => b.onclick = () => bulkAction(b.dataset.act, b));
}

async function bulkAction(act, btn) {
  const ids = [...lib.sel], cards = ids.map(id => st.cards[id]).filter(Boolean), n = ids.length, many = `${n} card${n === 1 ? '' : 's'}`;
  // Destructive actions need a second tap.
  if ((act === 'delete' || act === 'reset') && !btn.dataset.armed) {
    btn.dataset.armed = 1; btn.textContent = act === 'delete' ? `Delete ${many}?` : `Reset ${many}?`; btn.classList.add('danger'); return;
  }
  if (act === 'move') return moveSheet(ids);
  if (act === 'copy' || act === 'rewrite') {
    const text = act === 'copy' ? JSON.stringify({ cards: cards.map(c => ({ topic: c.topic, q: c.q, a: c.a, ...(c.explanation ? { explanation: c.explanation } : {}) })) }, null, 1) : rewritePrompt(cards);
    try { await navigator.clipboard.writeText(text); toast(`Copied ${many}`) } catch { toast('Couldn’t copy') }
    return;
  }
  bulk(ids, act === 'delete' ? { delete: true } : act === 'reset' ? { reset: true } : { flagged: act === 'flag' });
  toast({ delete: `Deleted ${many}`, reset: `Reset progress on ${many}`, flag: `Flagged ${many}`, unflag: `Unflagged ${many}` }[act]);
  if (act === 'delete') lib.sel.clear();
  library();
}

function moveSheet(ids) {
  let to = '';
  const paint = () => {
    sheet.innerHTML = `<form>
      <div style="display:flex;justify-content:space-between;align-items:center"><span class="serif" style="font-size:20px">Move ${ids.length} card${ids.length === 1 ? '' : 's'}</span><button type="button" class="chip" data-close>Cancel</button></div>
      <div class="chips" style="flex-wrap:wrap">${topics().map(t => `<button type="button" class="chip ${t === to ? 'on' : ''}" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <input name="to" placeholder="Or a new topic, e.g. Languages › Spanish" value="${esc(to)}">
      <button class="btn">Move</button></form>`;
    const f = sheet.querySelector('form');
    sheet.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { to = b.dataset.t; paint() });
    f.onsubmit = e => {
      e.preventDefault();
      const topic = normTopic(f.to.value || to);
      if (!topic) return toast('Pick or type a topic');
      bulk(ids, { topic }); lib.sel.clear(); toast(`Moved to ${topic}`); goBack();
    };
  };
  paint(); openSheet();
  sheet.onclick = e => { if (e.target === sheet || e.target.dataset.close != null) goBack() };
}
const refresh = () => view === 'library' ? library() : view === 'stats' ? showStats() : view === 'map' ? showMap() : home();
function addLink(topic, requires) { st.links.push({ topic, requires }); st.ops.push({ kind: 'link', topic, requires }) }
function showMap() {
  round = null; view = 'map';
  map({
    app, sheet, goBack, openSheet, inTopic, topics,
    cards: () => deck, states: () => st.reviews, links: () => st.links,
    link: (topic, requires) => { addLink(topic, requires); save(); sync() },
    unlink: (topic, requires) => { st.links = st.links.filter(l => !(l.topic === topic && l.requires === requires)); st.ops.push({ kind: 'unlink', topic, requires }); save(); sync() },
    study: topic => { sheet.hidden = true; start(topic) },
  });
}
function showStats() {
  round = null; view = 'stats';
  stats({ app, api, goBack, openEditor, inTopic, topics, view: () => view, cards: () => deck, states: () => st.reviews, outbox: () => st.outbox, cardById: id => st.cards[id] });
}

function renameTopic(from) {
  sheet.innerHTML = `<form>
    <div style="display:flex;justify-content:space-between;align-items:center"><span class="serif" style="font-size:20px">Rename topic</span><button type="button" class="chip" data-close>Cancel</button></div>
    <small style="color:var(--muted)">Subtopics move with it. Use › to nest, e.g. Languages › Spanish.</small>
    <input name="to" value="${esc(from)}" required>
    <button class="btn">Rename</button></form>`;
  const f = sheet.querySelector('form');
  openSheet(); f.to.focus(); f.to.select();
  sheet.onclick = e => { if (e.target === sheet || e.target.dataset.close != null) goBack() };
  f.onsubmit = e => {
    e.preventDefault();
    const to = normTopic(f.to.value);
    if (to && to !== from) {
      for (const c of deck) if (inTopic(c, from)) c.topic = to + c.topic.slice(from.length);
      st.pending.forEach(c => { if (inTopic(c, from)) c.topic = to + c.topic.slice(from.length) });
      st.ops.push({ kind: 'rename', from, to });
      const move = t => inTopic({ topic: t }, from) ? to + t.slice(from.length) : t;
      st.links = st.links.map(l => ({ topic: move(l.topic), requires: move(l.requires) }));
      if (lib.topic && inTopic({ topic: lib.topic }, from)) lib.topic = to + lib.topic.slice(from.length);
      save(); sync(); toast(`Renamed to ${to}`);
    }
    goBack();
  };
}

function editCard(card, fields) {
  Object.assign(card, fields);
  const queued = st.pending.find(p => p.id === card.id);
  // Queued cards upload first; fields the insert ignores (like flagged) follow as a patch.
  if (queued) Object.assign(queued, fields);
  if (!queued || 'flagged' in fields) st.ops.push({ kind: 'patch', id: card.id, body: fields });
  save(); merge(); sync();
}
function deleteCard(card) {
  delete st.cards[card.id]; delete st.reviews[card.id];
  st.outbox = st.outbox.filter(o => o.id !== card.id);
  const i = st.pending.findIndex(p => p.id === card.id);
  if (i >= 0) st.pending.splice(i, 1); else st.ops.push({ kind: 'delete', id: card.id });
  save(); merge(); sync();
}

// New cards show at once and upload in the background (see sync).
function queueCard({ topic, q, a, explanation, source }) {
  const card = { id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), topic, q, a, explanation: explanation || '', created: Date.now() };
  st.cards[card.id] = card; st.pending.push({ ...card, source });
}

/* ---------- Paste import ---------- */
const EXAMPLE = `{"cards":[{"topic":"Languages › Spanish","q":"Spanish → English: *quedarse*","a":"to stay, to remain"}]}

or Anki text, one card per line:
quedarse;to stay, to remain;Languages › Spanish`;

// Flagged cards plus the rules, for an agent to rewrite into pasteable JSON.
function rewritePrompt(cards) {
  return `These flashcards from my spaced-repetition app were flagged as poorly written. Rewrite them.

Rules (from Woźniak's "Twenty Rules of Formulating Knowledge"):
- One fact per card. Answers are a word, a phrase or one short sentence; split a card that tests several things.
- No lists or sets ("name the 5 …"): one card per item instead.
- Ask precisely so there is exactly one right answer; add context like "In Rust, …".
- Keep wording short. Keep each card's topic unless it's clearly wrong.
- Keep or add an optional "explanation", shown after the answer: why it's true, a mnemonic, or a common mix-up. Aim for one or two sentences (roughly 250 characters at most). Leave it out when the answer speaks for itself, and never just restate the answer.
- If a card is fine as it is, keep it unchanged; if it's not worth keeping, leave it out.
- **bold**, *italic* and \`code\` render; otherwise plain text.

Reply with only this JSON in a code block, nothing else:
{"cards":[{"topic":"…","q":"…","a":"…","explanation":"… or omit"}]}

The flagged cards:
${JSON.stringify(cards.map(c => ({ topic: c.topic, q: c.q, a: c.a, ...(c.explanation ? { explanation: c.explanation } : {}) })), null, 1)}`;
}

function agentPrompt() {
  const ts = topics();
  return `Write flashcards for me to paste into my spaced-repetition app.

Rules (from Woźniak's "Twenty Rules of Formulating Knowledge"):
- One fact per card. Answers are a word, a phrase or one short sentence; split anything with "and".
- No lists or sets ("name the 5 …"): one card per item instead.
- Ask precisely so there is exactly one right answer; add context like "In Rust, …".
- Make cards both ways when both directions matter (word → meaning and meaning → word).
- Keep wording short. Only cover what I've learned or asked about; don't pad.
- Optionally add an "explanation", shown after the answer: why it's true, a mnemonic, or a common mix-up. Aim for one or two sentences (roughly 250 characters at most). Leave it out when the answer speaks for itself, and never just restate the answer.
- **bold**, *italic* and \`code\` render; otherwise plain text.

Topics are paths, most general first, joined with " › ", in Title Case, 2–3 levels deep.
${ts.length ? `Reuse one of my existing topics where it fits:\n${ts.map(t => '- ' + t).join('\n')}` : 'I have no topics yet, so choose sensible ones.'}

Optionally, add prerequisite links between topics: "topic" builds on "requires". They're shown on my knowledge map and never affect scheduling. Only add direct, real dependencies, and don't link a topic to its own parent.
${st.links.length ? `Links I already have:\n${st.links.map(l => `- ${l.topic} requires ${l.requires}`).join('\n')}` : ''}

Reply with only this JSON in a code block, nothing else ("links" may be omitted):
{"cards":[{"topic":"Computing › Rust › Lifetimes","q":"In Rust, what does 'a denote in a function signature?","a":"A lifetime parameter","explanation":"It names how long a reference must stay valid, so the compiler can check borrows across the call.","source":"where it came from, or null"}],
 "links":[{"topic":"Computing › Rust › Lifetimes","requires":"Computing › Rust › Ownership"}]}`;
}

function openImport() {
  let def = lib.topic || localStorage.getItem('bloom-topic') || topics()[0] || 'Inbox', timer;
  sheet.innerHTML = `<form class="import">
    <div style="display:flex;justify-content:space-between;align-items:center"><span class="serif" style="font-size:20px">Paste cards</span><button type="button" class="chip" data-close>Cancel</button></div>
    <textarea name="t" rows="8" placeholder="${esc(EXAMPLE)}" spellcheck="false"></textarea>
    <small style="color:var(--muted)">JSON from an agent, or Anki text export: one card per line as question ; answer ; topic ; explanation (the last two optional; tabs work too). <button type="button" class="link" id="copy" style="color:var(--brass-hi)">Copy agent prompt</button></small>
    <div id="pv"></div>
    <button class="btn" id="go" disabled>Add cards</button>
  </form>`;
  const f = sheet.querySelector('form'), pv = sheet.querySelector('#pv'), go = sheet.querySelector('#go');
  const parse = () => {
    const r = parsePaste(f.t.value), seen = new Set(deck.map(c => c.topic + '\n' + normQ(c.q))), fresh = [], dups = [];
    for (const c of r.cards) {
      const card = { ...c, topic: c.topic || normTopic(def) || 'Inbox' }, k = card.topic + '\n' + normQ(card.q);
      (seen.has(k) ? dups : fresh).push(card); seen.add(k);
    }
    // Same rules as the API: no loops, no parent/child links; flag implied ones.
    const graph = [...st.links], links = [], linkIssues = [], implied = [];
    for (const l of r.links || []) {
      const c = checkLink(graph, l.topic, l.requires);
      if (c.error) linkIssues.push(`${l.topic.split(' › ').at(-1)} → ${l.requires.split(' › ').at(-1)}: ${c.error.replace(/(?:[^›→: ][^›→:]* › )+/g, '')}`);
      else if (c.warning !== 'already linked') { if (c.warning) implied.push(l); graph.push(l); links.push(l) }
    }
    return { fresh, dups, links, implied, errors: [...r.errors, ...linkIssues], needsTopic: r.cards.some(c => !c.topic) };
  };
  const preview = () => {
    const p = parse(), groups = new Map();
    for (const c of p.fresh) groups.set(c.topic, (groups.get(c.topic) || 0) + 1);
    pv.innerHTML = !f.t.value.trim() ? '' : `
      ${p.needsTopic ? `<div class="label0" style="margin:6px 0">Cards without a topic go to</div><div class="chips">${[...new Set([def, ...topics()])].map(t => `<button type="button" class="chip ${t === def ? 'on' : ''}" data-def="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
      <div class="pv">${[...groups].map(([t, n]) => `<div><span>${esc(t)}</span><b>${n}</b></div>`).join('')}
      ${p.links.length ? `<div><span>Prerequisite links</span><b>${p.links.length}</b></div>` : ''}
      ${p.implied.length ? `<div class="muted"><span>Of those, already implied by other links (added anyway)</span><b>${p.implied.length}</b></div>` : ''}
      ${p.dups.length ? `<div class="muted"><span>Already in your deck, skipped</span><b>${p.dups.length}</b></div>` : ''}
      ${p.errors.length ? `<div class="warn"><span>${p.errors.slice(0, 4).map(esc).join('<br>')}${p.errors.length > 4 ? `<br>and ${p.errors.length - 4} more` : ''}</span><b>${p.errors.length}</b></div>` : ''}</div>`;
    pv.querySelectorAll('[data-def]').forEach(b => b.onclick = () => { def = b.dataset.def; preview() });
    const parts = [p.fresh.length && `${p.fresh.length} card${p.fresh.length === 1 ? '' : 's'}`, p.links.length && `${p.links.length} link${p.links.length === 1 ? '' : 's'}`].filter(Boolean);
    go.disabled = !parts.length;
    go.textContent = parts.length ? 'Add ' + parts.join(' and ') : 'Add cards';
  };
  f.t.oninput = () => { clearTimeout(timer); timer = setTimeout(preview, 200) };
  sheet.querySelector('#copy').onclick = async () => { try { await navigator.clipboard.writeText(agentPrompt()); toast('Prompt copied') } catch { toast('Couldn’t copy') } };
  f.onsubmit = e => {
    e.preventDefault();
    const { fresh, links } = parse();
    if (!fresh.length && !links.length) return;
    fresh.forEach(c => queueCard({ ...c, source: c.source || 'paste' }));
    links.forEach(l => addLink(l.topic, l.requires));
    save(); merge(); sync();
    toast(go.textContent.replace('Add', 'Added'));
    goBack();
  };
  openSheet(); f.t.focus();
  sheet.onclick = e => { if (e.target === sheet || e.target.dataset.close != null) goBack() };
}

// One sheet for adding (no card) and editing (a card).
function openEditor(card) {
  let topic = card?.topic || localStorage.getItem('bloom-topic') || topics()[0] || '';
  const paint = () => {
    sheet.innerHTML = `<form>
      <div style="display:flex;justify-content:space-between;align-items:center"><span class="serif" style="font-size:20px">${card ? 'Edit card' : 'New card'}</span><span>${card ? '' : '<button type="button" class="chip" data-paste>Paste many</button> '}<button type="button" class="chip" data-close>${card ? 'Cancel' : 'Done'}</button></span></div>
      <div class="chips">${[...new Set([topic, ...topics()].filter(Boolean))].map(t => `<button type="button" class="chip ${t === topic ? 'on' : ''}" data-t="${esc(t)}">${esc(t)}</button>`).join('')}<button type="button" class="chip" data-new>+ topic</button></div>
      <input name="topic" placeholder="New topic" ${topic ? 'hidden' : ''} value="${esc(topic)}">
      <textarea name="q" placeholder="Question" required>${card ? esc(card.q) : ''}</textarea>
      <textarea name="a" placeholder="Answer" required>${card ? esc(card.a) : ''}</textarea>
      <textarea name="x" class="xbox" placeholder="Explanation (optional) — why it's true, a mnemonic, a common mix-up">${card ? esc(card.explanation || '') : ''}</textarea>
      <button class="btn">${card ? 'Save' : 'Add card'}</button>
      ${card ? `<small style="color:var(--muted);text-align:center">${status(card) === 'new' ? 'Not studied yet' : `Reviewed ${st.reviews[card.id].reps}× · next ${status(card)}`}</small><button type="button" class="btn ghost" data-flag>${card.flagged ? 'Unflag' : '⚑ Flag for rewrite'}</button><button type="button" class="btn ghost" data-del>Delete card</button>` : ''}
    </form>`;
    const f = sheet.querySelector('form');
    // Keep what's typed when switching topic chips.
    sheet.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { const q = f.q.value, a = f.a.value; topic = b.dataset.t; paint(); f2().q.value = q; f2().a.value = a });
    // The sheet is already open, so the import sheet replaces it in the same history entry.
    sheet.querySelector('[data-paste]')?.addEventListener('click', openImport);
    sheet.querySelector('[data-flag]')?.addEventListener('click', e => { editCard(card, { flagged: card.flagged ? 0 : 1 }); e.currentTarget.textContent = card.flagged ? 'Unflag' : '⚑ Flag for rewrite'; toast(card.flagged ? 'Flagged' : 'Unflagged') });
    const del = sheet.querySelector('[data-del]');
    if (del) del.onclick = () => {
      if (!del.dataset.armed) { del.dataset.armed = 1; del.textContent = 'Tap again to delete'; del.style.color = '#e4a08d'; return }
      deleteCard(card); toast('Card deleted'); goBack();
    };
    sheet.querySelector('[data-new]').onclick = () => { f.topic.hidden = false; f.topic.value = ''; f.topic.focus() };
    f.onsubmit = async e => {
      e.preventDefault();
      topic = normTopic(f.topic.value.trim() || topic || 'Inbox');
      if (card) {
        editCard(card, { topic, q: f.q.value.trim(), a: f.a.value.trim(), explanation: f.x.value.trim() });
        toast('Saved'); return goBack();
      }
      queueCard({ topic, q: f.q.value.trim(), a: f.a.value.trim(), explanation: f.x.value.trim(), source: 'app' });
      save(); merge(); localStorage.setItem('bloom-topic', topic);
      refresh(); toast(`Added to ${topic}`); paint(); sync();
    };
    if (!card) f.q.focus();
  };
  const f2 = () => sheet.querySelector('form');
  openSheet(); paint();
  sheet.onclick = e => { if (e.target === sheet || e.target.dataset.close != null) goBack() };
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
// Older caches lack creation dates; refetch everything once to fill them in.
if (Object.values(st.cards).some(c => c.created == null)) st.since = 0;
merge();
history.replaceState({ v: 'home', depth: 0 }, '', location.pathname);
if (!apiKey) gate();
else { home(); sync().then(ok => { if (ok && !round && sheet.hidden) refresh() }) }
addEventListener('online', () => apiKey && sync());
// The map and stats lay out to the screen width, so redraw them when it changes.
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if ((view === 'map' || view === 'stats') && sheet.hidden) refresh() }, 200) });
addEventListener('visibilitychange', () => { if (!document.hidden && apiKey) sync().then(() => { if (!round && sheet.hidden) refresh() }) });
