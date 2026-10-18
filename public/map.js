// Knowledge map: an overlay model. The domain is the topic tree plus optional
// prerequisite links (edited in each topic's sheet); the learner layer is FSRS
// recall averaged per topic.
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

let selected = null, mode = null;

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

export function map(ctx) {
  const { app } = ctx, { nodes, byPath } = build(ctx), links = ctx.links().filter(l => byPath.has(l.topic) && byPath.has(l.requires));
  const started = nodes.filter(n => n.studied).length;
  const view = mode || (links.length ? 'graph' : 'tree');
  const kids = p => nodes.filter(n => n.depth === (p ? p.split(' › ').length : 0) && (!p || n.path.startsWith(p + ' › ')));
  const leaves = nodes.filter(n => !kids(n.path).length);
  // Tree diagram: each row carries one guide column per ancestor (a line while
  // that ancestor has later siblings) and an elbow joining it to its parent.
  const rows = [];
  const walk = (parent, guides) => kids(parent).forEach((n, i, sib) => {
    const last = i === sib.length - 1, hasKids = kids(n.path).length > 0, isOpen = open.has(n.path);
    rows.push(`<div class="tnode ${n.path === selected ? 'sel' : ''}">
      ${guides.map(g => `<span class="g ${g ? 'line' : ''}"></span>`).join('')}${n.depth ? `<span class="g elbow ${last ? 'last' : ''}"></span>` : ''}
      ${hasKids ? `<button class="tw ${isOpen ? 'open' : ''}" data-tog="${esc(n.path)}" aria-label="${isOpen ? 'Collapse' : 'Expand'} ${esc(n.path)}" aria-expanded="${isOpen}">›</button>` : `<span class="tw leaf" style="background:${colorOf(n.recall)}"></span>`}
      <button class="tn ${n.depth ? '' : 'root'}" data-path="${esc(n.path)}">
        <span class="nm">${esc(name(n.path))}</span>
        <span class="bar2"><i style="width:${n.recall == null ? 0 : Math.round(n.recall * 100)}%;background:${colorOf(n.recall)}"></i></span>
        <span class="pc">${pctOf(n.recall)}</span>
      </button>
    </div>`);
    if (hasKids && isOpen) walk(n.path, n.depth ? [...guides, !last] : []);
  });
  walk('', []);
  app.innerHTML = `
    <div class="bar"><button class="x" aria-label="Back">←</button><div class="serif" style="flex:1;font-size:22px">Knowledge map</div></div>
    <div class="chips" style="margin:0 0 12px"><button class="chip ${view === 'graph' ? 'on' : ''}" data-mode="graph">Prerequisites</button><button class="chip ${view === 'tree' ? 'on' : ''}" data-mode="tree">Topics</button></div>
    <p class="sub" style="margin:0 4px 12px">${view === 'graph' ? 'Foundations at the top; arrows point to the topics that build on them. Tap a topic to trace its links.' : 'Your topics and subtopics.'} Shaded by how much you'd recall right now.</p>
    <div class="legend wide" style="margin:0 4px 16px">${RAMP.map((c, i) => `<span><i style="background:${c}"></i>${BANDS[i]}</span>`).join('')}<span><i style="background:${EMPTY}"></i>not started</span></div>
    ${!nodes.length ? '<p class="empty">No topics yet.</p>'
      : view === 'graph' ? graph(byPath, links)
      : `<div class="tree panel">${rows.join('')}</div>
      <p class="sub" style="margin:14px 4px">${started} of ${nodes.length} topics started · ${leaves.filter(n => n.recall >= .9).length} of ${leaves.length} at 90%+</p>`}`;
  app.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { mode = b.dataset.mode; map(ctx) });
  app.querySelectorAll('.gn').forEach(b => b.onclick = () => { selected = b.dataset.path; map(ctx); details(ctx, byPath, links) });
  app.querySelector('.gn.sel')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  app.querySelector('.x').onclick = ctx.goBack;
  app.querySelectorAll('.tn').forEach(b => b.onclick = () => { selected = b.dataset.path; map(ctx); details(ctx, byPath, links) });
  app.querySelectorAll('[data-tog]').forEach(b => b.onclick = () => {
    const t = b.dataset.tog; open.has(t) ? open.delete(t) : open.add(t);
    try { localStorage.setItem('bloom-map-open', JSON.stringify([...open])) } catch {}
    map(ctx);
  });
}

// Prerequisite graph. Each connected group of linked topics is laid out on its
// own, layered top to bottom: a topic sits one layer below its deepest
// prerequisite, and within a layer topics are ordered by the average position
// of their neighbours (a few up/down sweeps) to cut edge crossings.
const NW = 108, NH = 80, GX = 10, GY = 40, PAD = 8;
function graph(byPath, links) {
  if (!links.length) return `<div class="panel"><p class="sub" style="margin:0">No prerequisites yet. Open a topic in the Topics tab and add what it builds on, or have an agent add links. They'll be drawn here as a graph.</p></div>`;
  const ids = [...new Set(links.flatMap(l => [l.topic, l.requires]))];
  // Connected groups (union–find).
  const up = new Map(ids.map(id => [id, id])), find = x => up.get(x) === x ? x : (up.set(x, find(up.get(x))), up.get(x));
  links.forEach(l => up.set(find(l.topic), find(l.requires)));
  const groups = new Map();
  ids.forEach(id => { const g = find(id); groups.set(g, [...(groups.get(g) || []), id]) });
  const comps = [...groups.values()].sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  const others = [...byPath.keys()].filter(p => !ids.includes(p) && ![...byPath.keys()].some(q => q.startsWith(p + ' › '))).length;
  return comps.map(c => component(c, links.filter(l => c.includes(l.topic)), byPath)).join('')
    + `<p class="sub" style="margin:14px 4px">${ids.length} topics linked by ${links.length} prerequisite${links.length === 1 ? '' : 's'}${others ? ` · ${others} other topic${others === 1 ? '' : 's'} in the Topics tab` : ''}</p>`;
}

// The longest path prefix shared by every topic in a group, for its heading.
function common(ids) {
  const parts = ids.map(id => id.split(' › '));
  const out = [];
  for (let i = 0; parts.every(p => p.length > i + 1 && p[i] === parts[0][i]); i++) out.push(parts[0][i]);
  return out.join(' › ');
}

function component(ids, links, byPath) {
  const reqs = id => links.filter(l => l.topic === id).map(l => l.requires);
  const layer = new Map();
  const depth = (id, seen = new Set()) => {
    if (layer.has(id)) return layer.get(id);
    if (seen.has(id)) return 0; // tolerate a cycle created outside the app
    seen.add(id);
    const d = Math.max(-1, ...reqs(id).map(r => depth(r, seen))) + 1;
    layer.set(id, d); return d;
  };
  ids.forEach(id => depth(id));
  // Links that skip layers get a thin virtual node in each layer they cross,
  // so they're routed through the gaps instead of behind other topics.
  const segs = [], chains = new Map();
  links.forEach((l, li) => {
    const chain = [l.requires];
    for (let d = layer.get(l.requires) + 1; d < layer.get(l.topic); d++) { const v = `~${li}~${d}`; layer.set(v, d); chain.push(v) }
    chain.push(l.topic); chains.set(l, chain);
    for (let k = 1; k < chain.length; k++) segs.push([chain[k - 1], chain[k]]);
  });
  const virt = id => id.startsWith('~'), wOf = id => virt(id) ? 10 : NW;
  const layers = [];
  [...layer.keys()].sort((a, b) => a.localeCompare(b)).forEach(id => (layers[layer.get(id)] ||= []).push(id));
  const pos = id => { const L = layers[layer.get(id)]; return L.indexOf(id) / Math.max(1, L.length - 1) };
  const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  for (let sweep = 0; sweep < 6; sweep++) {
    const downward = sweep % 2 === 0, order = downward ? [...layers.keys()] : [...layers.keys()].reverse();
    for (const i of order) {
      const by = id => mean(segs.filter(([a, b]) => downward ? b === id : a === id).map(([a, b]) => pos(downward ? a : b)));
      layers[i] = layers[i].map((id, k) => ({ id, k: by(id) ?? k / Math.max(1, layers[i].length - 1) })).sort((a, b) => a.k - b.k).map(x => x.id);
    }
  }
  const lw = L => L.reduce((w, id) => w + wOf(id), 0) + (L.length - 1) * GX;
  const width = Math.max(...layers.map(lw)) + PAD * 2, height = layers.length * (NH + GY) - GY + PAD * 2;
  const at = new Map();
  layers.forEach((L, i) => {
    let x = (width - lw(L)) / 2;
    L.forEach(id => { at.set(id, { x, y: PAD + i * (NH + GY) }); x += wOf(id) + GX });
  });
  const cx = id => at.get(id).x + wOf(id) / 2;
  const near = selected && ids.includes(selected) ? new Set([selected, ...reqs(selected), ...links.filter(l => l.requires === selected).map(l => l.topic)]) : null;
  let edges = '';
  for (const l of links) {
    const chain = chains.get(l), on = near && (l.topic === selected || l.requires === selected);
    // Curve between layers; run straight down through each virtual node.
    let x = cx(chain[0]), y = at.get(chain[0]).y + NH, d = `M${x},${y}`;
    for (let k = 1; k < chain.length; k++) {
      const id = chain[k], x2 = cx(id), y2 = at.get(id).y - (virt(id) ? 0 : 6), my = (y2 - y) / 2;
      d += ` C${x},${y + my} ${x2},${y2 - my} ${x2},${y2}`;
      if (virt(id)) d += ` L${x2},${y2 + NH}`;
      x = x2; y = y2 + NH;
    }
    edges += `<path d="${d}" class="${on ? 'on' : near ? 'dim' : ''}" marker-end="url(#gh-${on ? 'on' : 'off'})"/>`;
  }
  const base = common(ids);
  const nodesHtml = ids.map(id => {
    const n = byPath.get(id), p = at.get(id);
    // The group heading names what's shared; each node adds only its own parent.
    const rest = (base ? id.slice(base.length + 3) : id).split(' › '), parent = rest.length > 1 ? rest.at(-2) : '';
    return `<button class="gn ${id === selected ? 'sel' : ''} ${near && !near.has(id) ? 'dim' : ''}" data-path="${esc(id)}" style="left:${p.x}px;top:${p.y}px;width:${NW}px;height:${NH}px">
      ${parent ? `<small>${esc(parent)}</small>` : ''}<span class="gname">${esc(name(id))}</span>
      <span class="gfoot"><span class="bar2"><i style="width:${n.recall == null ? 0 : Math.round(n.recall * 100)}%;background:${colorOf(n.recall)}"></i></span><b>${pctOf(n.recall)}</b></span>
    </button>`;
  }).join('');
  return `<section class="gwrap panel"><h3>${esc(base || 'Across topics')}</h3><div class="gscroll"><div class="gcanvas" style="width:${width}px;height:${height}px">
      <svg width="${width}" height="${height}" class="gedges"><defs>${['on', 'off'].map(k => `<marker id="gh-${k}" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 Z" class="${k}"/></marker>`).join('')}</defs>${edges}</svg>
      ${nodesHtml}</div></div></section>`;
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
