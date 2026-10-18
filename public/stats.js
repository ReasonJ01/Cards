// Statistics page. Everything is computed client-side from the review log
// (GET /api/history) plus each card's current FSRS state, so the topic and
// range filters scope every number on the page.
import { retrievability } from './fsrs.js';

const DAY = 864e5, MATURE = 21;
// Ordinal brass ramp, dim → bright (validated against the chart surface).
const RAMP = ['#6b5a35', '#9a7f45', '#c9a35a', '#ecd39b'];
const ACCENT = '#c9a35a', GRID = '#ffffff14', MUTED = '#a9b8ad', SURFACE = '#12352a', EMPTY = '#1c4a3a';
const RANGES = [[30, '30 days'], [90, '90 days'], [365, 'Year'], [0, 'All time']];

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (n, d) => d ? Math.round(100 * n / d) : null;
const fmtPct = v => v == null ? '—' : v + '%';
const compact = n => n >= 1e4 ? (n / 1e3).toFixed(0) + 'K' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
const dayKey = t => { const d = new Date(t); return d.getFullYear() * 1e4 + (d.getMonth() + 1) * 100 + d.getDate() };
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return +d };
const dateLabel = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const niceMax = v => { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)), m = v / p; return (m <= 2 ? 2 : m <= 5 ? 5 : 10) * p };

let filter = { days: 30, topic: '' }, history = null, tips = [], hideTip = () => {};
// Registered once: any tap outside a mark, any scroll, or leaving the page hides the tooltip.
addEventListener('pointerdown', e => { if (!e.target.closest?.('[data-tip]')) hideTip() }, true);
addEventListener('scroll', () => hideTip(), { passive: true, capture: true });
addEventListener('blur', () => hideTip());

export async function stats(ctx) {
  const { app, api } = ctx;
  if (!history) {
    app.innerHTML = `<div class="bar"><button class="x" aria-label="Back">←</button><div class="serif" style="flex:1;font-size:22px">Statistics</div></div><p class="empty">Loading…</p>`;
    app.querySelector('.x').onclick = ctx.goBack;
  }
  try { history = await api('/history') } catch { history = history || [] }
  if (ctx.view() !== 'stats') return;
  render(ctx);
}

// Per-review facts: elapsed days since that card's previous review, and
// whether it counts toward retention (a scheduled review ≥ 1 day later).
function analyse(ctx) {
  const now = Date.now(), cards = ctx.cards(), states = ctx.states();
  const log = [...history, ...ctx.outbox().map(o => [o.id, o.ts, o.grade])].sort((a, b) => a[1] - b[1]);
  const byId = new Map(cards.map(c => [c.id, c]));
  const inScope = id => !filter.topic || (byId.has(id) && ctx.inTopic(byId.get(id), filter.topic));
  const last = new Map(), rows = [];
  for (const [id, ts, grade] of log) {
    const prev = last.get(id); last.set(id, ts);
    if (!inScope(id)) continue;
    const elapsed = prev == null ? null : (ts - prev) / DAY;
    rows.push({ id, ts, grade, first: prev == null, elapsed, counts: elapsed != null && elapsed >= 1 });
  }
  const from = filter.days ? startOfDay(now) - (filter.days - 1) * DAY : (rows[0]?.ts ?? now);
  const range = rows.filter(r => r.ts >= from);
  const scoped = cards.filter(c => ctx.inTopic(c, filter.topic));
  return { now, from, rows, range, scoped, states, byId };
}

function render(ctx) {
  const { app, topics } = ctx, A = analyse(ctx), { now, from, rows, range, scoped, states } = A;
  tips = [];
  const W = Math.min(app.clientWidth, 520) - 32 - 36;

  // Headline numbers
  const graded = range.filter(r => r.counts), ok = graded.filter(r => r.grade > 1);
  const young = graded.filter(r => r.elapsed < MATURE), mature = graded.filter(r => r.elapsed >= MATURE);
  const days = new Set(range.map(r => dayKey(r.ts)));
  const spanDays = Math.max(1, Math.round((startOfDay(now) - startOfDay(from)) / DAY) + 1);
  const allDays = [...new Set(rows.map(r => startOfDay(r.ts)))].sort((a, b) => a - b);
  let longest = 0, run = 0;
  allDays.forEach((d, i) => { run = i && Math.round((d - allDays[i - 1]) / DAY) === 1 ? run + 1 : 1; longest = Math.max(longest, run) });
  // Current streak counts back from today, or from yesterday if today has no reviews yet.
  const daySet = new Set(allDays);
  let current = 0, d = startOfDay(now);
  if (!daySet.has(d)) d -= DAY;
  while (daySet.has(d)) { current++; d -= DAY }
  const studied = scoped.filter(c => states[c.id]);
  const recallNow = studied.length ? Math.round(100 * studied.reduce((s, c) => s + retrievability((now - states[c.id].last) / DAY, states[c.id].s), 0) / studied.length) : null;
  const added = scoped.filter(c => (c.created ?? 0) >= from).length;
  const newSeen = range.filter(r => r.first).length;

  // Card maturity
  const groups = [0, 0, 0, 0]; // new, learning, young, mature
  for (const c of scoped) { const s = states[c.id]; groups[!s ? 0 : s.due - s.last < DAY ? 1 : s.s < MATURE ? 2 : 3]++ }

  app.innerHTML = `
    <div class="bar"><button class="x" aria-label="Back">←</button><div class="serif" style="flex:1;font-size:22px">Statistics</div></div>
    <div class="filters">
      <div class="chips">${RANGES.map(([d, l]) => `<button class="chip ${filter.days === d ? 'on' : ''}" data-days="${d}">${l}</button>`).join('')}</div>
      <div class="chips"><button class="chip ${filter.topic ? '' : 'on'}" data-topic="">All topics</button>${topics().map(t => `<button class="chip ${t === filter.topic ? 'on' : ''}" data-topic="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    </div>

    <section class="panel hero-stat">
      <div class="label0">True retention</div>
      <div class="hero-num">${fmtPct(pct(ok.length, graded.length))}</div>
      <div class="sub">${graded.length ? `of ${compact(graded.length)} scheduled reviews recalled · target 90%` : 'No scheduled reviews in this range yet. Retention counts reviews at least a day after the last one.'}</div>
      <div class="tiles">
        ${tile('Young cards', fmtPct(pct(young.filter(r => r.grade > 1).length, young.length)), `interval under ${MATURE}d · ${young.length} reviews`)}
        ${tile('Mature cards', fmtPct(pct(mature.filter(r => r.grade > 1).length, mature.length)), `interval ${MATURE}d+ · ${mature.length} reviews`)}
        ${tile('Recall right now', fmtPct(recallNow), `predicted average over ${studied.length} studied cards`)}
      </div>
    </section>

    <div class="tiles four">
      ${tile('Reviews', compact(range.length), `${(range.length / spanDays).toFixed(1)} a day on average`)}
      ${tile('Days studied', `${days.size}<small>/${spanDays}</small>`, `${pct(days.size, spanDays) ?? 0}% of days`)}
      ${tile('Streak', `${current}<small>d</small>`, `longest ${longest} days`)}
      ${tile('New cards', compact(newSeen), `seen · ${added} added`)}
    </div>

    ${panel('Activity', 'Reviews per day', heatmap(range, from, now, W))}
    ${panel('Reviews', spanDays > 120 ? 'Per week' : 'Per day', reviewsChart(range, from, now, spanDays, W))}
    ${panel('Retention over time', 'Weekly share of scheduled reviews recalled', retentionChart(graded, W))}
    ${panel('Forecast', 'Cards coming due over the next 30 days', forecast(scoped, states, now, W))}
    ${panel('Card maturity', `${scoped.length} cards`, maturity(groups, W))}
    ${panel('Answer buttons', 'Share of each grade in this range', buttons(range, W))}
    ${panel('Memory strength', 'Cards by stability: days until recall falls to 90%', stability(studied, states, W))}
    ${panel('Difficulty', 'FSRS difficulty, 1 (easy) to 10 (hard)', difficulty(studied, states, W))}
    ${panel('Time of day', 'Reviews by hour; tooltip shows recall rate', hours(range, W))}
    ${filter.topic ? '' : panel('Topics', 'Retention uses this range', topicTable(A, ctx))}
    ${panel('Hardest cards', 'Most forgotten, all time', leeches(scoped, states, rows))}
    <div id="tip" class="tip" hidden></div>`;

  app.querySelector('.x').onclick = ctx.goBack;
  app.querySelectorAll('[data-days]').forEach(b => b.onclick = () => { filter.days = +b.dataset.days; render(ctx) });
  app.querySelectorAll('[data-topic]').forEach(b => b.onclick = () => { filter.topic = b.dataset.topic; render(ctx) });
  app.querySelectorAll('[data-card]').forEach(b => b.onclick = () => ctx.openEditor(ctx.cardById(b.dataset.card)));
  wireTips(app);
}

/* ---------- Pieces ---------- */
const tile = (label, value, note) => `<div class="tile"><div class="label0">${label}</div><div class="tile-num">${value}</div><div class="sub">${note}</div></div>`;
const panel = (title, sub, body) => `<section class="panel"><h3>${title}</h3><div class="sub">${sub}</div>${body}</section>`;
const table = (head, rows) => `<details><summary>Show as table</summary><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
const tip = text => (tips.push(text), tips.length - 1);
const empty = msg => `<p class="sub" style="margin:14px 0 4px">${msg}</p>`;

// Column chart: [{label, value, tip, color?}] with hairline grid and 3 ticks.
function columns(data, W, { H = 120, xLabels = [], showMax = true } = {}) {
  const max = niceMax(Math.max(1, ...data.map(d => d.value))), left = 28, plotW = W - left, band = plotW / data.length;
  const bw = Math.max(2, Math.min(24, band - 2)), y = v => H - (v / max) * H;
  let svg = '';
  for (const t of [0, max / 2, max]) svg += `<line x1="${left}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="${GRID}"/><text x="${left - 6}" y="${y(t) + 4}" text-anchor="end" class="tick">${compact(t)}</text>`;
  data.forEach((d, i) => {
    const x = left + i * band + (band - bw) / 2, h = (d.value / max) * H, r = Math.min(4, bw / 2, h);
    if (h > 0) svg += `<path d="M${x},${H} V${H - h + r} Q${x},${H - h} ${x + r},${H - h} H${x + bw - r} Q${x + bw},${H - h} ${x + bw},${H - h + r} V${H} Z" fill="${d.color || ACCENT}"/>`;
    svg += `<rect class="hit" x="${left + i * band}" y="0" width="${band}" height="${H}" data-tip="${tip(d.tip)}" tabindex="0"/>`;
  });
  for (const [i, l] of xLabels) svg += `<text x="${left + (i + .5) * band}" y="${H + 16}" text-anchor="${i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}" class="tick">${esc(l)}</text>`;
  return `<svg width="${W}" height="${H + 22}" class="chart">${svg}</svg>`;
}

function heatmap(range, from, now, W) {
  const counts = new Map();
  for (const r of range) counts.set(startOfDay(r.ts), (counts.get(startOfDay(r.ts)) || 0) + 1);
  const end = startOfDay(now), start0 = startOfDay(from), first = start0 - ((new Date(start0).getDay() + 6) % 7) * DAY;
  const weeks = Math.ceil((end - first) / DAY / 7 + 1 / 7), shown = Math.min(weeks, 53);
  const firstShown = first + (weeks - shown) * 7 * DAY;
  const cell = Math.max(5, Math.min(24, Math.floor((W - 20) / shown) - 2)), gap = 2, top = 14;
  const vals = [...counts.values()].sort((a, b) => a - b), q = p => vals[Math.floor(p * (vals.length - 1))] || 1;
  const bins = [q(.25), q(.5), q(.75)], color = v => !v ? EMPTY : RAMP[v <= bins[0] ? 0 : v <= bins[1] ? 1 : v <= bins[2] ? 2 : 3];
  let svg = '', lastMonth = -1;
  for (let w = 0; w < shown; w++) for (let d = 0; d < 7; d++) {
    const t = firstShown + (w * 7 + d) * DAY; if (t > end) continue;
    const v = counts.get(t) || 0, x = 20 + w * (cell + gap), yy = top + d * (cell + gap);
    if (d === 0 && new Date(t).getMonth() !== lastMonth && w < shown - 1) { lastMonth = new Date(t).getMonth(); svg += `<text x="${x}" y="10" class="tick">${new Date(t).toLocaleDateString(undefined, { month: 'short' })}</text>` }
    svg += `<rect x="${x}" y="${yy}" width="${cell}" height="${cell}" rx="2" fill="${t < start0 ? 'transparent' : color(v)}" ${t < start0 ? '' : `class="cell" tabindex="0" data-tip="${tip(`${v} review${v === 1 ? '' : 's'} · ${new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`)}"`}/>`;
  }
  ['M', 'W', 'F'].forEach((l, i) => svg += `<text x="0" y="${top + (i * 2) * (cell + gap) + cell - 2}" class="tick">${l}</text>`);
  const h = top + 7 * (cell + gap);
  const legend = `<div class="legend"><span>Less</span>${[EMPTY, ...RAMP].map(c => `<i style="background:${c}"></i>`).join('')}<span>More</span></div>`;
  const rows = [...counts.entries()].sort((a, b) => b[0] - a[0]).map(([t, v]) => [dateLabel(t), v]);
  return `<div class="scroll"><svg width="${20 + shown * (cell + gap)}" height="${h}" class="chart">${svg}</svg></div>${legend}${table(['Day', 'Reviews'], rows)}`;
}

function reviewsChart(range, from, now, spanDays, W) {
  const weekly = spanDays > 120, step = weekly ? 7 * DAY : DAY, start = startOfDay(from), n = Math.ceil((startOfDay(now) - start) / step) + 1;
  const buckets = Array.from({ length: n }, (_, i) => ({ t: start + i * step, all: 0, fresh: 0 }));
  for (const r of range) { const b = buckets[Math.min(n - 1, Math.floor((r.ts - start) / step))]; b.all++; if (r.first) b.fresh++ }
  if (!range.length) return empty('No reviews in this range.');
  const data = buckets.map(b => ({ value: b.all, tip: `${b.all} reviews (${b.fresh} new) · ${weekly ? 'week of ' : ''}${dateLabel(b.t)}` }));
  return columns(data, W, { xLabels: [[0, dateLabel(buckets[0].t)], [n - 1, weekly ? dateLabel(buckets[n - 1].t) : 'Today']] })
    + table([weekly ? 'Week of' : 'Day', 'Reviews', 'New'], buckets.filter(b => b.all).reverse().map(b => [dateLabel(b.t), b.all, b.fresh]));
}

function retentionChart(graded, W) {
  const weeks = new Map();
  for (const r of graded) { const k = startOfDay(r.ts) - ((new Date(r.ts).getDay() + 6) % 7) * DAY; const w = weeks.get(k) || { n: 0, ok: 0 }; w.n++; if (r.grade > 1) w.ok++; weeks.set(k, w) }
  const pts = [...weeks.entries()].sort((a, b) => a[0] - b[0]).filter(([, w]) => w.n >= 5);
  if (pts.length < 2) return empty('Needs at least two weeks with five or more scheduled reviews.');
  const H = 120, left = 28, lo = Math.min(50, ...pts.map(([, w]) => Math.floor(100 * w.ok / w.n / 10) * 10)), plotW = W - left - 8;
  const x = i => left + 4 + (i / (pts.length - 1)) * plotW, y = v => H - ((v - lo) / (100 - lo)) * H;
  let svg = '';
  for (const t of [lo, (lo + 100) / 2, 100]) svg += `<line x1="${left}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="${GRID}"/><text x="${left - 6}" y="${y(t) + 4}" text-anchor="end" class="tick">${t}%</text>`;
  svg += `<line x1="${left}" x2="${W}" y1="${y(90)}" y2="${y(90)}" stroke="${MUTED}" stroke-opacity=".5"/><text x="${W}" y="${y(90) - 5}" text-anchor="end" class="tick">target 90%</text>`;
  const vals = pts.map(([, w]) => 100 * w.ok / w.n);
  svg += `<polyline points="${vals.map((v, i) => `${x(i)},${y(v)}`).join(' ')}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const li = vals.length - 1;
  svg += `<circle cx="${x(li)}" cy="${y(vals[li])}" r="4" fill="${ACCENT}" stroke="${SURFACE}" stroke-width="2"/>`;
  svg += `<line class="cross" x1="0" x2="0" y1="0" y2="${H}" stroke="${MUTED}" stroke-opacity=".6" visibility="hidden"/>`;
  pts.forEach(([t, w], i) => {
    const x0 = i ? (x(i - 1) + x(i)) / 2 : left, x1 = i < li ? (x(i) + x(i + 1)) / 2 : W;
    svg += `<rect class="hit" data-x="${x(i)}" x="${x0}" y="0" width="${x1 - x0}" height="${H}" tabindex="0" data-tip="${tip(`${Math.round(vals[i])}% recalled · ${w.ok}/${w.n} · week of ${dateLabel(t)}`)}"/>`;
  });
  svg += `<text x="${left + 4}" y="${H + 16}" class="tick">${dateLabel(pts[0][0])}</text><text x="${W}" y="${H + 16}" text-anchor="end" class="tick">${dateLabel(pts[li][0])}</text>`;
  return `<svg width="${W}" height="${H + 22}" class="chart">${svg}</svg>` + table(['Week of', 'Recalled', 'Reviews'], pts.slice().reverse().map(([t, w]) => [dateLabel(t), Math.round(100 * w.ok / w.n) + '%', w.n]));
}

function forecast(scoped, states, now, W) {
  const today = startOfDay(now), n = 30, buckets = Array(n).fill(0);
  let overdue = 0;
  for (const c of scoped) { const s = states[c.id]; if (!s) continue; const i = Math.floor((startOfDay(s.due) - today) / DAY); if (i <= 0) overdue++; else if (i < n) buckets[i]++ }
  buckets[0] = overdue;
  const data = buckets.map((v, i) => ({ value: v, tip: `${v} card${v === 1 ? '' : 's'} · ${i === 0 ? 'ready now' : i === 1 ? 'tomorrow' : dateLabel(today + i * DAY)}` }));
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return empty('Nothing scheduled yet. Study some cards first.');
  return `<div class="sub" style="margin-top:-2px">${overdue} ready now · ${buckets.slice(1, 8).reduce((a, b) => a + b, 0)} more this week</div>`
    + columns(data, W, { xLabels: [[0, 'Now'], [n - 1, dateLabel(today + (n - 1) * DAY)]] })
    + table(['Day', 'Due'], buckets.map((v, i) => [i ? dateLabel(today + i * DAY) : 'Now', v]).filter(r => r[1]));
}

function maturity(groups, W) {
  const names = ['New', 'Learning', 'Young', 'Mature'], total = groups.reduce((a, b) => a + b, 0);
  if (!total) return empty('No cards yet.');
  let x = 0, svg = '';
  groups.forEach((v, i) => {
    if (!v) return;
    const w = (v / total) * W, gap = x + w < W - .5 ? 2 : 0;
    svg += `<rect x="${x}" y="0" width="${Math.max(1, w - gap)}" height="20" rx="4" fill="${RAMP[i]}" class="cell" tabindex="0" data-tip="${tip(`${names[i]} · ${v} cards (${pct(v, total)}%)`)}"/>`;
    x += w;
  });
  const legend = `<div class="legend wide">${names.map((n, i) => `<span><i style="background:${RAMP[i]}"></i>${n} <b>${groups[i]}</b></span>`).join('')}</div>`;
  return `<svg width="${W}" height="20" class="chart" style="margin-top:12px">${svg}</svg>${legend}<p class="sub">Learning: due again within a day. Mature: stability of ${MATURE}+ days.</p>`
    + table(['Stage', 'Cards', 'Share'], names.map((n, i) => [n, groups[i], pct(groups[i], total) + '%']));
}

function buttons(range, W) {
  if (!range.length) return empty('No reviews in this range.');
  const names = ['Again', 'Hard', 'Good', 'Easy'], counts = [0, 0, 0, 0];
  for (const r of range) counts[r.grade - 1]++;
  const total = range.length, labelW = 52, valW = 44, barW = W - labelW - valW;
  let svg = '';
  counts.forEach((v, i) => {
    const y = i * 30, w = (v / total) * barW;
    svg += `<text x="0" y="${y + 15}" class="tick strong">${names[i]}</text>`;
    if (w > 0) svg += `<path d="M${labelW},${y + 4} H${labelW + w - Math.min(4, w)} Q${labelW + w},${y + 4} ${labelW + w},${y + 4 + Math.min(4, w)} V${y + 16 - Math.min(4, w)} Q${labelW + w},${y + 20} ${labelW + w - Math.min(4, w)},${y + 20} H${labelW} Z" fill="${ACCENT}"/>`;
    svg += `<text x="${labelW + w + 6}" y="${y + 16}" class="tick">${pct(v, total)}%</text>`;
    svg += `<rect class="hit" x="0" y="${y}" width="${W}" height="28" tabindex="0" data-tip="${tip(`${v} × ${names[i]} (${pct(v, total)}%)`)}"/>`;
  });
  return `<svg width="${W}" height="${4 * 30}" class="chart" style="margin-top:12px">${svg}</svg>` + table(['Button', 'Presses', 'Share'], names.map((n, i) => [n, counts[i], pct(counts[i], total) + '%']));
}

function stability(studied, states, W) {
  if (!studied.length) return empty('No studied cards yet.');
  const edges = [[0, 1, '<1d'], [1, 3, '1–3d'], [3, 7, '3–7d'], [7, 14, '1–2w'], [14, 30, '2–4w'], [30, 90, '1–3mo'], [90, 180, '3–6mo'], [180, 365, '6–12mo'], [365, 1e9, '1y+']];
  const counts = edges.map(() => 0);
  for (const c of studied) { const s = states[c.id].s; counts[edges.findIndex(([a, b]) => s >= a && s < b)]++ }
  const med = studied.map(c => states[c.id].s).sort((a, b) => a - b)[Math.floor(studied.length / 2)];
  return `<div class="sub" style="margin-top:-2px">Median ${med < 1 ? '<1' : Math.round(med)} days</div>`
    + columns(edges.map(([, , l], i) => ({ value: counts[i], tip: `${counts[i]} cards · ${l}` })), W, { xLabels: [[0, edges[0][2]], [4, edges[4][2]], [edges.length - 1, edges.at(-1)[2]]] })
    + table(['Stability', 'Cards'], edges.map(([, , l], i) => [l, counts[i]]));
}

function difficulty(studied, states, W) {
  if (!studied.length) return empty('No studied cards yet.');
  const counts = Array(10).fill(0);
  for (const c of studied) counts[Math.min(9, Math.max(0, Math.floor(states[c.id].d) - 1))]++;
  const avg = studied.reduce((s, c) => s + states[c.id].d, 0) / studied.length;
  return `<div class="sub" style="margin-top:-2px">Average ${avg.toFixed(1)}</div>`
    + columns(counts.map((v, i) => ({ value: v, tip: `${v} cards · difficulty ${i + 1}–${i + 2}` })), W, { xLabels: [[0, '1'], [4, '5'], [9, '10']] })
    + table(['Difficulty', 'Cards'], counts.map((v, i) => [`${i + 1}–${i + 2}`, v]));
}

function hours(range, W) {
  if (!range.length) return empty('No reviews in this range.');
  const h = Array.from({ length: 24 }, () => ({ n: 0, g: 0, ok: 0 }));
  for (const r of range) { const b = h[new Date(r.ts).getHours()]; b.n++; if (r.counts) { b.g++; if (r.grade > 1) b.ok++ } }
  const hh = i => `${String(i).padStart(2, '0')}:00`;
  return columns(h.map((b, i) => ({ value: b.n, tip: `${b.n} reviews · ${hh(i)}–${hh((i + 1) % 24)}${b.g ? ` · ${pct(b.ok, b.g)}% recalled` : ''}` })), W, { xLabels: [[0, '00'], [6, '06'], [12, '12'], [18, '18'], [23, '23']] })
    + table(['Hour', 'Reviews', 'Recalled'], h.map((b, i) => [hh(i), b.n, b.g ? pct(b.ok, b.g) + '%' : '—']).filter(r => r[1]));
}

function topicTable(A, ctx) {
  const by = new Map();
  for (const c of A.scoped) { const t = by.get(c.topic) || { cards: 0, mature: 0, due: 0, n: 0, ok: 0 }; t.cards++; const s = A.states[c.id]; if (s?.s >= MATURE) t.mature++; if (!s || s.due <= A.now) t.due++; by.set(c.topic, t) }
  for (const r of A.range) { if (!r.counts) continue; const c = A.byId.get(r.id); const t = c && by.get(c.topic); if (t) { t.n++; if (r.grade > 1) t.ok++ } }
  if (!by.size) return empty('No topics yet.');
  const rows = [...by.entries()].sort((a, b) => b[1].cards - a[1].cards);
  return `<div class="tablewrap"><table class="always"><thead><tr><th>Topic</th><th>Cards</th><th>Mature</th><th>Recall</th><th>Ready</th></tr></thead><tbody>${rows.map(([t, v]) =>
    `<tr><td><button class="link" data-topic="${esc(t)}">${esc(t)}</button></td><td>${v.cards}</td><td>${pct(v.mature, v.cards)}%</td><td>${fmtPct(pct(v.ok, v.n))}</td><td>${v.due}</td></tr>`).join('')}</tbody></table></div>`;
}

function leeches(scoped, states, rows) {
  const misses = new Map();
  for (const r of rows) if (r.grade === 1 && !r.first) misses.set(r.id, (misses.get(r.id) || 0) + 1);
  const list = scoped.map(c => ({ c, n: Math.max(misses.get(c.id) || 0, states[c.id]?.lapses || 0) })).filter(x => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 8);
  if (!list.length) return empty('No card has been forgotten twice yet.');
  return `<div class="list">${list.map(({ c, n }) => `<button class="row" data-card="${c.id}"><div><div class="serif">${esc(c.q)}</div><small>${esc(c.topic)}</small></div><span>${n}× forgotten</span></button>`).join('')}</div>
    <p class="sub">Tap a card to reword it. Cards forgotten again and again usually need splitting or a clearer question.</p>`;
}

/* ---------- Tooltip ---------- */
function wireTips(root) {
  const el = root.querySelector('#tip');
  const show = (target, x, y) => {
    el.textContent = tips[+target.dataset.tip]; el.hidden = false;
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, x - r.width / 2)) + 'px';
    el.style.top = Math.max(8, y - r.height - 12) + 'px';
    root.querySelectorAll('.on-mark').forEach(m => m.classList.remove('on-mark')); target.classList.add('on-mark');
    const svg = target.closest('svg'), cross = svg.querySelector('.cross');
    if (cross && target.dataset.x) { cross.setAttribute('x1', target.dataset.x); cross.setAttribute('x2', target.dataset.x); cross.setAttribute('visibility', 'visible') }
  };
  const hide = () => { el.hidden = true; root.querySelectorAll('.on-mark').forEach(m => m.classList.remove('on-mark')); root.querySelectorAll('.cross').forEach(c => c.setAttribute('visibility', 'hidden')) };
  hideTip = hide;
  root.querySelectorAll('[data-tip]').forEach(m => {
    // Mouse: follow the pointer, hide on leave. Touch: show on tap (not on the
    // touch that starts a scroll), hide on the next tap elsewhere or a scroll.
    m.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') show(m, e.clientX, e.clientY) });
    m.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide() });
    m.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') show(m, e.clientX, e.clientY) });
    // Keyboard only: a tap or click also focuses the mark, which mustn't pin the tooltip.
    m.addEventListener('focus', () => { if (m.matches(':focus-visible')) { const r = m.getBoundingClientRect(); show(m, r.left + r.width / 2, r.top) } });
    m.addEventListener('blur', hide);
  });
}
