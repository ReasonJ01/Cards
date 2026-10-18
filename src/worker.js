// Bloom API. Every /api route except /api/status and /api/claim needs
// `Authorization: Bearer <key>`. The key is chosen by whoever claims the
// instance first; only its SHA-256 is stored.
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const STATE = ['s', 'd', 'last', 'due', 'reps', 'lapses'];
const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const getMeta = async (db, k) => (await db.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first())?.v;

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ''), db = env.DB, M = req.method;
    if (!path.startsWith('/api')) return env.ASSETS.fetch(req);
    const body = M === 'GET' || M === 'DELETE' ? null : await req.json().catch(() => null);
    const keyHash = await getMeta(db, 'key_hash');

    if (path === '/api/status') return json({ claimed: !!keyHash });
    if (path === '/api/claim' && M === 'POST') {
      if (keyHash) return json({ error: 'already claimed' }, 409);
      if (!body?.key || body.key.length < 12) return json({ error: 'key must be at least 12 characters' }, 400);
      await db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').bind('key_hash', await sha(body.key)).run();
      return json({ ok: true });
    }
    const auth = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!keyHash || !auth || await sha(auth) !== keyHash) return json({ error: 'unauthorized' }, 401);

    // App sync: everything changed since `since` (ms), including deletions.
    if (path === '/api/sync' && M === 'GET') {
      const since = +url.searchParams.get('since') || 0;
      const { results } = await db.prepare('SELECT * FROM cards WHERE updated > ? ORDER BY updated').bind(since).all();
      const stats = JSON.parse(await getMeta(db, 'stats') || '{}');
      return json({ cards: results, stats, now: Date.now() });
    }

    if (path === '/api/stats' && M === 'PUT') {
      const cur = JSON.parse(await getMeta(db, 'stats') || '{}');
      const next = { ...cur, ...body, xp: Math.max(cur.xp || 0, body.xp || 0) };
      await db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('stats', JSON.stringify(next)).run();
      return json(next);
    }

    if (path === '/api/reviews' && M === 'POST') {
      const list = Array.isArray(body) ? body : [];
      const now = Date.now();
      await db.batch(list.flatMap(r => [
        db.prepare(`UPDATE cards SET ${STATE.map(k => `${k} = ?`).join(', ')}, updated = ? WHERE id = ?`).bind(...STATE.map(k => r.state?.[k] ?? null), now, r.id),
        db.prepare('INSERT INTO reviews (card_id, ts, grade) VALUES (?, ?, ?)').bind(r.id, r.ts, r.grade),
      ]));
      return json({ ok: true, count: list.length });
    }

    // Full review log for the stats page, compact: [card_id, ts, grade].
    if (path === '/api/history' && M === 'GET') {
      return json(await db.prepare('SELECT card_id, ts, grade FROM reviews ORDER BY ts').raw());
    }

    if (path === '/api/topics' && M === 'GET') {
      const { results } = await db.prepare('SELECT topic, COUNT(*) AS count FROM cards WHERE deleted = 0 GROUP BY topic ORDER BY topic').all();
      return json(results);
    }

    // Moves a topic and its subtopics: "Spanish" → "Languages › Spanish".
    if (path === '/api/topics/rename' && M === 'POST') {
      const from = body?.from?.trim(), to = body?.to?.trim().split(/\s*(?:›|>|::|\/)\s*/).filter(Boolean).join(' › ');
      if (!from || !to) return json({ error: 'send {from, to}' }, 400);
      const r = await db.prepare("UPDATE cards SET topic = ? || substr(topic, ?), updated = ? WHERE deleted = 0 AND (topic = ? OR topic LIKE ?)")
        .bind(to, from.length + 1, Date.now(), from, from + ' › %').run();
      return json({ ok: true, moved: r.meta.changes });
    }

    if (path === '/api/cards' && M === 'GET') {
      const topic = url.searchParams.get('topic'), q = url.searchParams.get('q');
      let sql = 'SELECT id, topic, q, a, source, reps, due FROM cards WHERE deleted = 0', args = [];
      if (topic) { sql += ' AND (topic = ? OR topic LIKE ?)'; args.push(topic, topic + ' › %') }
      if (q) { sql += ' AND (q LIKE ? OR a LIKE ?)'; args.push(`%${q}%`, `%${q}%`) }
      const { results } = await db.prepare(sql + ' ORDER BY topic, created LIMIT 1000').bind(...args).all();
      return json(results);
    }

    if (path === '/api/cards' && M === 'POST') {
      const list = Array.isArray(body) ? body : body?.cards;
      if (!Array.isArray(list) || !list.length) return json({ error: 'send {cards: [{topic, q, a, source?}]}' }, 400);
      const { results: existing } = await db.prepare('SELECT id, topic, q, deleted FROM cards').all();
      const seen = new Set(existing.filter(c => !c.deleted).map(c => c.topic + '\n' + norm(c.q)));
      const ids = new Set(existing.map(c => c.id));
      const now = Date.now(), added = [], skipped = [];
      for (const c of list) {
        const topic = c.topic?.trim().split(/\s*(?:›|>|::|\/)\s*/).filter(Boolean).join(' › ');
        if (!topic || !c.q?.trim() || !c.a?.trim()) { skipped.push({ ...c, reason: 'needs topic, q and a' }); continue }
        // Clients may supply their own id so retries are idempotent.
        if (c.id != null && !/^[\w-]{6,40}$/.test(c.id)) { skipped.push({ id: c.id, q: c.q, reason: 'bad id' }); continue }
        if (ids.has(c.id)) { skipped.push({ id: c.id, q: c.q, reason: 'already added' }); continue }
        const k = topic + '\n' + norm(c.q);
        if (seen.has(k)) { skipped.push({ id: c.id, q: c.q, reason: 'duplicate question in this topic' }); continue }
        seen.add(k); added.push({ id: c.id || id(), topic, q: c.q.trim(), a: c.a.trim(), source: c.source || null });
      }
      if (added.length) await db.batch(added.map(c => db.prepare('INSERT INTO cards (id, topic, q, a, source, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(c.id, c.topic, c.q, c.a, c.source, now, now)));
      return json({ added, skipped }, added.length ? 201 : 200);
    }

    const m = path.match(/^\/api\/cards\/([\w-]+)$/);
    if (m && M === 'PATCH') {
      const fields = ['topic', 'q', 'a', 'source'].filter(k => typeof body?.[k] === 'string');
      if (!fields.length) return json({ error: 'nothing to update' }, 400);
      const r = await db.prepare(`UPDATE cards SET ${fields.map(k => `${k} = ?`).join(', ')}, updated = ? WHERE id = ? AND deleted = 0`).bind(...fields.map(k => body[k].trim()), Date.now(), m[1]).run();
      return r.meta.changes ? json({ ok: true }) : json({ error: 'not found' }, 404);
    }
    if (m && M === 'DELETE') {
      const r = await db.prepare('UPDATE cards SET deleted = 1, updated = ? WHERE id = ?').bind(Date.now(), m[1]).run();
      return r.meta.changes ? json({ ok: true }) : json({ error: 'not found' }, 404);
    }
    return json({ error: 'not found' }, 404);
  },
};
