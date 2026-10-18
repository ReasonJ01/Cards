// Knowledge map: an overlay model. The domain is the topic tree plus optional
// prerequisite links (listed as "builds on"); the learner layer is FSRS recall
// averaged per topic.
// Purely visual — nothing here affects scheduling or which cards are shown.
import { retrievability } from './fsrs.js';

const DAY = 864e5;
const RAMP = ['#6b5a35', '#9a7f45', '#c9a35a', '#ecd39b'], EMPTY = '#1c4a3a';
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

// Which topics are expanded on the map (per device). Top level shows by default.
let open;
try { open = new Set(JSON.parse(localStorage.getItem('bloom-map-open')) || []) } catch { open = new Set() }
const visible = (path, nodes) => path.split(' › ').every((_, i, a) => i === a.length - 1 || open.has(a.slice(0, i + 1).join(' › ')));

export function map(ctx) {
  const { app } = ctx, { nodes, byPath } = build(ctx), links = ctx.links().filter(l => byPath.has(l.topic) && byPath.has(l.requires));
  const started = nodes.filter(n => n.studied).length;
  const leaves = nodes.filter(n => !nodes.some(m => m.path.startsWith(n.path + ' › ')));
  const dot = p => `<span class="pre"><i style="background:${colorOf(byPath.get(p).recall)}"></i>${esc(name(p))}</span>`;
  const rows = nodes.map((n, i) => {
    if (!visible(n.path, nodes)) return '';
    const kids = nodes.some(m => m.path.startsWith(n.path + ' › ')), reqs = links.filter(l => l.topic === n.path).map(l => l.requires);
    return `<div class="trow" style="--d:${n.depth}">
      ${kids ? `<button class="tog ${open.has(n.path) ? 'open' : ''}" data-tog="${esc(n.path)}" aria-label="${open.has(n.path) ? 'Collapse' : 'Expand'} ${esc(n.path)}" aria-expanded="${open.has(n.path)}">›</button>` : '<span class="tog"></span>'}
      <button class="mrow ${n.path === selected ? 'sel' : ''} ${n.depth ? '' : 'top'}" data-i="${i}">
        <span class="mtop"><span class="nm">${esc(name(n.path))}</span><span class="pc">${pctOf(n.recall)}</span></span>
        <span class="meter"><i style="width:${n.recall == null ? 0 : Math.round(n.recall * 100)}%;background:${colorOf(n.recall)}"></i></span>
        <span class="msub">${n.studied} of ${n.total} studied${reqs.length ? `<span class="reqs">builds on ${reqs.map(dot).join('')}</span>` : ''}</span>
      </button>
    </div>`;
  }).join('');
  app.innerHTML = `
    <div class="bar"><button class="x" aria-label="Back">←</button><div class="serif" style="flex:1;font-size:22px">Knowledge map</div></div>
    <p class="sub" style="margin:0 4px 12px">Each topic is shaded by how much you'd recall right now. ${links.length ? '“Builds on” lists a topic’s prerequisites, each dot showing how well you know it.' : 'Tap a topic to say what it builds on.'}</p>
    <div class="legend wide" style="margin:0 4px 14px">${RAMP.map((c, i) => `<span><i style="background:${c}"></i>${BANDS[i]}</span>`).join('')}<span><i style="background:${EMPTY}"></i>not started</span></div>
    ${nodes.length ? `<div class="maplist">${rows}</div>
      <p class="sub" style="margin:14px 4px">${started} of ${nodes.length} topics started · ${leaves.filter(n => n.recall >= .9).length} of ${leaves.length} at 90%+</p>`
      : '<p class="empty">No topics yet.</p>'}`;
  app.querySelector('.x').onclick = ctx.goBack;
  app.querySelectorAll('.mrow').forEach(b => b.onclick = () => { selected = nodes[+b.dataset.i].path; map(ctx); details(ctx, byPath, links) });
  app.querySelectorAll('[data-tog]').forEach(b => b.onclick = () => {
    const t = b.dataset.tog; open.has(t) ? open.delete(t) : open.add(t);
    try { localStorage.setItem('bloom-map-open', JSON.stringify([...open])) } catch {}
    map(ctx);
  });
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
