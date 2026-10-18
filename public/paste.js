// Parses pasted cards. Three formats, detected automatically:
//   1. JSON — the API's {"cards":[{topic,q,a,source}]} or a bare array.
//   2. Q:/A: blocks, optionally under "# Topic" headings. Lines after Q: or A:
//      continue that field until the next blank line, Q: or heading.
//   3. One card per line: question<TAB>answer[<TAB>topic], or the same with ";".
// Returns { cards: [{topic, q, a, source}], errors: [string] }. Cards without a
// topic get topic '' so the caller can apply a default.
export const normTopic = t => (t || '').trim().split(/\s*(?:›|>|::|\/)\s*/).filter(Boolean).join(' › ');
export const normQ = s => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function parsePaste(text) {
  const src = text.replace(/\r\n?/g, '\n').trim();
  if (!src) return { cards: [], errors: [] };
  if (/^[[{]/.test(src)) return fromJSON(src);
  if (/^\s*Q\s*:/mi.test(src)) return fromBlocks(src);
  return fromLines(src);
}

function clean(list, errors) {
  const cards = [];
  list.forEach((c, i) => {
    const q = String(c.q ?? c.question ?? c.front ?? '').trim(), a = String(c.a ?? c.answer ?? c.back ?? '').trim();
    if (!q || !a) return errors.push(`${c.where || 'Card ' + (i + 1)}: missing ${q ? 'answer' : 'question'}`);
    cards.push({ topic: normTopic(c.topic), q, a, source: c.source ? String(c.source) : null });
  });
  return { cards, errors };
}

function fromJSON(src) {
  try {
    const data = JSON.parse(src), list = Array.isArray(data) ? data : data.cards;
    if (!Array.isArray(list)) return { cards: [], errors: ['JSON needs a "cards" list'] };
    return clean(list.map(c => c && typeof c === 'object' ? c : {}), []);
  } catch (e) { return { cards: [], errors: ['Not valid JSON: ' + e.message] } }
}

function fromBlocks(src) {
  const out = [], errors = [];
  let topic = '', cur = null, field = null;
  const flush = () => { if (cur) out.push(cur); cur = null; field = null };
  src.split('\n').forEach((line, i) => {
    const h = line.match(/^#+\s*(.+)$/), q = line.match(/^\s*Q\s*:\s?(.*)$/i), a = line.match(/^\s*A\s*:\s?(.*)$/i);
    if (h) { flush(); topic = h[1] }
    else if (q) { flush(); cur = { topic, q: q[1], a: '', where: 'Line ' + (i + 1) }; field = 'q' }
    else if (a && cur) { cur.a = a[1]; field = 'a' }
    else if (!line.trim()) field = null;
    else if (cur && field) cur[field] += '\n' + line;
    else if (line.trim()) errors.push(`Line ${i + 1}: not part of a card`);
  });
  flush();
  const r = clean(out, []);
  return { cards: r.cards, errors: [...errors, ...r.errors] };
}

function fromLines(src) {
  const lines = src.split('\n'), sep = lines.some(l => l.includes('\t')) ? '\t' : ';';
  const rows = [];
  lines.forEach((l, i) => {
    if (!l.trim() || l.startsWith('#')) return; // Anki exports start with #separator: lines
    const [q, a, topic] = l.split(sep);
    rows.push({ q, a, topic, where: 'Line ' + (i + 1) });
  });
  return clean(rows, []);
}
