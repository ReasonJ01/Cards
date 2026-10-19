// Parses pasted cards. Two formats, detected automatically:
//   1. JSON — the API's {"cards":[{topic,q,a,explanation,source}]} or a bare array, plus an
//      optional "links":[{topic,requires}] list of prerequisites.
//   2. Anki's text export: one card per line as question;answer[;topic[;explanation]],
//      tab-separated or with ";".
// Returns { cards: [{topic, q, a, explanation, source}], links: [{topic, requires}], errors: [string] }. Cards without a
// topic get topic '' so the caller can apply a default.
export const normTopic = t => (t || '').trim().split(/\s*(?:›|>|::|\/)\s*/).filter(Boolean).join(' › ');
export const normQ = s => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function parsePaste(text) {
  const src = text.replace(/\r\n?/g, '\n').trim();
  if (!src) return { cards: [], errors: [] };
  if (/^[[{]/.test(src)) return fromJSON(src);
  return fromLines(src);
}

function clean(list, errors) {
  const cards = [];
  list.forEach((c, i) => {
    const q = String(c.q ?? c.question ?? c.front ?? '').trim(), a = String(c.a ?? c.answer ?? c.back ?? '').trim();
    if (!q || !a) return errors.push(`${c.where || 'Card ' + (i + 1)}: missing ${q ? 'answer' : 'question'}`);
    const explanation = String(c.explanation ?? c.explain ?? '').trim() || null;
    cards.push({ topic: normTopic(c.topic), q, a, explanation, source: c.source ? String(c.source) : null });
  });
  return { cards, errors };
}

function fromJSON(src) {
  try {
    const data = JSON.parse(src), list = Array.isArray(data) ? data : data.cards || [];
    const rawLinks = Array.isArray(data.links) ? data.links : [];
    if (!Array.isArray(list) || (!list.length && !rawLinks.length)) return { cards: [], errors: ['JSON needs a "cards" or "links" list'] };
    const r = clean(list.map(c => c && typeof c === 'object' ? c : {}), []), links = [];
    rawLinks.forEach((l, i) => {
      const topic = normTopic(l?.topic), requires = normTopic(l?.requires);
      if (!topic || !requires || topic === requires) r.errors.push(`Link ${i + 1}: needs two different topics`);
      else links.push({ topic, requires });
    });
    return { ...r, links };
  } catch (e) { return { cards: [], errors: ['Not valid JSON: ' + e.message] } }
}

function fromLines(src) {
  const lines = src.split('\n'), sep = lines.some(l => l.includes('\t')) ? '\t' : ';';
  const rows = [];
  lines.forEach((l, i) => {
    if (!l.trim() || l.startsWith('#')) return; // Anki exports start with #separator: lines
    const [q, a, topic, explanation] = l.split(sep);
    rows.push({ q, a, topic, explanation, where: 'Line ' + (i + 1) });
  });
  return clean(rows, []);
}
