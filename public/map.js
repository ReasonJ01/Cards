// Knowledge map: an overlay model. The domain is the topic tree plus optional
// prerequisite links; the learner layer is FSRS recall averaged per topic.
// Purely visual — nothing here affects scheduling or which cards are shown.
import { retrievability } from './fsrs.js';

const DAY = 864e5;
const RAMP = ['#6b5a35', '#9a7f45', '#c9a35a', '#ecd39b'], EMPTY = '#1c4a3a', MUTED = '#a9b8ad', ACCENT = '#c9a35a';
const BANDS = ['under 50%', '50–75%', '75–90%', '90%+'];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const band = r => r == null ? null : r < .5 ? 0 : r < .75 ? 1 : r < .9 ? 2 : 3;
const colorOf = r => r == null ? EMPTY : RAMP[band(r)];
const pctOf = r => r == null ? '—' : Math.round(r * 100) + '%';
const name = p => p.split(' › ').at(-1);

let selected = null;

// Every topic and its ancestors, depth-first, with mastery over the subtree.
function build(ctx) {
  const now = Date.now(), cards = ctx.cards(), states = ctx.states(), paths = new Set();
  for (const t of ctx.topics()) t.split(' › ').forEach((_, i, a) => paths.add(a.slice(0, i + 1).join(' › ')));
  const nodes = [...paths].sort((a, b) => a.localeCompare(b)).map(path => {
    const cs = cards.filter(c => ctx.inTopic(c, path)), studied = cs.filter(c => states[c.id]);
    const rs = studied.map(c => retrievability((now - states[c.id].last) / DAY, states[c.id].s));
    return {
      path, depth: path.split(' › ').length - 1, total: cs.length, studied: studied.length,
      mature: studied.filter(c => states[c.id].s >= 21).length,
      recall: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      weakest: studied.map((c, i) => ({ c, r: rs[i] })).sort((a, b) => a.r - b.r).slice(0, 3),
    };
  });
  return { nodes, byPath: new Map(nodes.map(n => [n.path, n])) };
}

export function map(ctx) {
  const { app } = ctx, { nodes, byPath } = build(ctx), links = ctx.links().filter(l => byPath.has(l.topic) && byPath.has(l.requires));
  const started = nodes.filter(n => n.studied).length;
  const leaves = nodes.filter(n => !nodes.some(m => m.path.startsWith(n.path + ' › ')));
  app.innerHTML = `
    <div class="bar"><button class="x" aria-label="Back">←</button><div class="serif" style="flex:1;font-size:22px">Knowledge map</div></div>
    <p class="sub" style="margin:0 4px 12px">Your topics, shaded by how much you'd recall right now.${links.length ? ' Arrows run from a prerequisite to the topic that builds on it.' : ' Tap a topic to add prerequisites and draw the links between them.'}</p>
    <div class="legend wide" style="margin:0 4px 14px">${RAMP.map((c, i) => `<span><i style="background:${c}"></i>${BANDS[i]}</span>`).join('')}<span><i style="background:${EMPTY}"></i>not started</span></div>
    ${nodes.length ? `<div class="mapwrap"><div class="maplist">${nodes.map((n, i) => `
      <button class="mrow ${n.path === selected ? 'sel' : ''}" data-i="${i}" style="--d:${n.depth}">
        <span class="nm">${esc(name(n.path))}<small>${n.studied}/${n.total} studied</small></span>
        <span class="meter"><i style="width:${n.recall == null ? 0 : Math.round(n.recall * 100)}%;background:${colorOf(n.recall)}"></i></span>
        <span class="pc">${pctOf(n.recall)}</span>
      </button>`).join('')}</div><svg class="arcs" aria-hidden="true"></svg></div>
      <p class="sub" style="margin:14px 4px">${started} of ${nodes.length} topics started · ${leaves.filter(n => n.recall >= .9).length} of ${leaves.length} at 90%+</p>`
      : '<p class="empty">No topics yet.</p>'}`;
  app.querySelector('.x').onclick = ctx.goBack;
  app.querySelectorAll('.mrow').forEach(b => b.onclick = () => { selected = nodes[+b.dataset.i].path; map(ctx); details(ctx, byPath, links) });
  drawArcs(app, nodes, links);
}

// Arcs live in a right-hand gutter: one curve per link, from the prerequisite's
// row to the dependent's, wider the further apart the rows are.
function drawArcs(app, nodes, links) {
  const svg = app.querySelector('.arcs'); if (!svg || !links.length) return;
  const rows = [...app.querySelectorAll('.mrow')], top = app.querySelector('.maplist').getBoundingClientRect().top;
  const y = i => { const r = rows[i].getBoundingClientRect(); return r.top - top + r.height / 2 };
  const idx = new Map(nodes.map((n, i) => [n.path, i]));
  const h = app.querySelector('.maplist').offsetHeight;
  svg.setAttribute('height', h); svg.setAttribute('viewBox', `0 0 56 ${h}`);
  let out = `<defs>${['m', 'on'].map(k => `<marker id="ah-${k}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${k === 'on' ? ACCENT : MUTED}"/></marker>`).join('')}</defs>`;
  const sorted = links.map(l => ({ ...l, a: idx.get(l.requires), b: idx.get(l.topic) })).sort((p, q) => Math.abs(q.a - q.b) - Math.abs(p.a - p.b));
  for (const l of sorted) {
    const on = selected && (l.topic === selected || l.requires === selected), y1 = y(l.a), y2 = y(l.b);
    const w = Math.min(50, 10 + 7 * Math.abs(l.a - l.b));
    out += `<path d="M2,${y1} C${w},${y1} ${w},${y2} 4,${y2}" fill="none" stroke="${on ? ACCENT : MUTED}" stroke-opacity="${on ? 1 : .45}" stroke-width="${on ? 2 : 1.5}" marker-end="url(#ah-${on ? 'on' : 'm'})"/>`;
  }
  svg.innerHTML = out;
}

function details(ctx, byPath, links) {
  const n = byPath.get(selected), sheet = ctx.sheet;
  const reqs = links.filter(l => l.topic === n.path).map(l => l.requires), deps = links.filter(l => l.requires === n.path).map(l => l.topic);
  // Offer topics that wouldn't create a cycle.
  const dependsOn = (a, b, seen = new Set()) => a === b || (!seen.has(a) && (seen.add(a), links.some(l => l.topic === a && dependsOn(l.requires, b, seen))));
  const options = [...byPath.keys()].filter(p => p !== n.path && !reqs.includes(p) && !dependsOn(p, n.path));
  const chip = (p, removable) => { const m = byPath.get(p); return `<span class="chip dep"><i style="background:${colorOf(m?.recall)}"></i>${esc(p)} <small>${pctOf(m?.recall)}</small>${removable ? `<button type="button" data-rm="${esc(p)}" aria-label="Remove">×</button>` : ''}</span>` };
  sheet.innerHTML = `<form>
    <div style="display:flex;justify-content:space-between;align-items:center"><span class="serif" style="font-size:20px">${esc(name(n.path))}</span><button type="button" class="chip" data-close>Done</button></div>
    <small style="color:var(--muted);margin-top:-8px">${esc(n.path)}</small>
    <div class="tiles" style="margin:0">
      <div class="tile"><div class="label0">Recall now</div><div class="tile-num">${pctOf(n.recall)}</div></div>
      <div class="tile"><div class="label0">Studied</div><div class="tile-num">${n.studied}<small>/${n.total}</small></div></div>
      <div class="tile"><div class="label0">Mature</div><div class="tile-num">${n.mature}</div></div>
    </div>
    <div><div class="label0" style="margin-bottom:6px">Requires</div>
      <div class="deps">${reqs.map(p => chip(p, true)).join('') || '<small style="color:var(--muted)">Nothing yet.</small>'}</div>
      ${options.length ? `<select id="addreq"><option value="">+ Add a prerequisite…</option>${options.map(p => `<option>${esc(p)}</option>`).join('')}</select>` : ''}
    </div>
    ${deps.length ? `<div><div class="label0" style="margin-bottom:6px">Needed for</div><div class="deps">${deps.map(p => chip(p, false)).join('')}</div></div>` : ''}
    ${n.weakest.length ? `<div><div class="label0" style="margin-bottom:6px">Shakiest cards</div>${n.weakest.map(({ c, r }) => `<div class="pv"><div><span>${esc(c.q)}</span><b>${pctOf(r)}</b></div></div>`).join('')}</div>` : ''}
    ${n.total ? '<button type="button" class="btn" id="study">Study this topic</button>' : ''}
  </form>`;
  ctx.openSheet();
  sheet.onclick = e => { if (e.target === sheet || e.target.dataset.close != null) ctx.goBack() };
  sheet.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { ctx.unlink(n.path, b.dataset.rm); refreshSheet(ctx) });
  sheet.querySelector('#addreq')?.addEventListener('change', e => { if (e.target.value) { ctx.link(n.path, e.target.value); refreshSheet(ctx) } });
  sheet.querySelector('#study')?.addEventListener('click', () => ctx.study(n.path));
}

function refreshSheet(ctx) {
  map(ctx);
  const { byPath } = build(ctx);
  details(ctx, byPath, ctx.links().filter(l => byPath.has(l.topic) && byPath.has(l.requires)));
}
