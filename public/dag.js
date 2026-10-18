// Rules for prerequisite links, shared by the API and the app. Links form a
// DAG over topics: "topic requires requires". A new link is rejected if it
// would close a cycle or joins a topic to its own ancestor/descendant (the
// hierarchy already says that), and flagged if other links already imply it.
const under = (a, b) => b.startsWith(a + ' › ');

// Topics `from` reaches by following "requires" links, as a path, or null.
function path(links, from, to, seen = new Set()) {
  if (from === to) return [from];
  if (seen.has(from)) return null;
  seen.add(from);
  for (const l of links) if (l.topic === from) { const p = path(links, l.requires, to, seen); if (p) return [from, ...p] }
  return null;
}

// Returns { error } to reject, { warning } to allow with a note, or {}.
export function checkLink(links, topic, requires) {
  if (!topic || !requires || topic === requires) return { error: 'needs two different topics' };
  if (under(topic, requires) || under(requires, topic)) return { error: 'one topic contains the other; the topic tree already shows that' };
  if (links.some(l => l.topic === topic && l.requires === requires)) return { warning: 'already linked' };
  const loop = path(links, requires, topic);
  if (loop) return { error: `would create a loop: ${[topic, ...loop].join(' → ')}` };
  const via = path(links, topic, requires);
  if (via) return { warning: `already implied by ${via.join(' → ')}` };
  return {};
}
