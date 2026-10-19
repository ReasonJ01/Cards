# Bloom — instructions for agents

Bloom is a spaced-repetition app (FSRS scheduling) at https://cards.reason.place.
Cards live in a Cloudflare D1 database behind a small API. When asked to make
flashcards, write them to the API. Don't edit code or files to add cards.

## API

Base URL `https://cards.reason.place/api`. Send `Authorization: Bearer $BLOOM_KEY`
on every request. The key is the one the owner set in the app. Never print it
or commit it.

| Method | Path | Purpose |
|---|---|---|
| GET | `/topics` | Existing topics with card counts. **Call this first.** |
| GET | `/cards?topic=T&q=text` | List or search cards (topic includes subtopics) |
| GET | `/cards?flagged=1` | Cards the owner flagged as poorly written |
| POST | `/cards` | Add cards: `{"cards":[{"topic","q","a","explanation","source"}]}` |
| PATCH | `/cards/:id` | Fix `topic`, `q`, `a`, `explanation`, `source`, or set `flagged` |
| DELETE | `/cards/:id` | Remove a card |
| POST | `/cards/bulk` | Change many cards at once: `{"ids":[…], "topic"?, "flagged"?, "reset"?, "delete"?}` |
| POST | `/topics/rename` | Move a topic and its subtopics: `{"from","to"}` |
| GET | `/links` | Prerequisite links between topics |
| POST / DELETE | `/links` | Add or remove: `{"links":[{"topic","requires"}]}` |

`POST /cards` returns `{added, skipped}`. A card is skipped when its question
already exists in that topic (ignoring case and spacing) or a field is missing.
Report skips to the user; don't retry them blindly.

```sh
curl -s https://cards.reason.place/api/cards \
  -H "Authorization: Bearer $BLOOM_KEY" -H 'content-type: application/json' \
  -d '{"cards":[{"topic":"Languages › Spanish › Verbs","q":"Spanish → English: *quedarse*","a":"to stay, to remain","source":"Duolingo unit 4"}]}'
```

### No API access? Output JSON to paste

If you can't make HTTP requests or don't have `BLOOM_KEY`, reply with the
same JSON you would have POSTed, in a code block, and nothing else. The owner
pastes it into the app (Library → Paste), which previews it and skips
duplicates:

```json
{"cards":[{"topic":"Languages › Spanish › Verbs","q":"Spanish → English: *quedarse*","a":"to stay, to remain","source":"Duolingo unit 4"}]}
```

Prerequisite links can ride along in the same JSON as
`"links":[{"topic","requires"}]`. The paste box also accepts Anki's text
export: one card per line as `question;answer;topic;explanation` (or
tab-separated; topic and explanation optional).

### Flagged cards

The owner flags cards that are badly written while reviewing. When asked to
fix them, fetch `/cards?flagged=1`, rewrite each one by the rules below, and
`PATCH` it with the new text and `"flagged": false`. Patching keeps the card's
review history. If one card should become several, patch the first and `POST`
the rest. Delete cards that aren't worth keeping.

## Where cards go (topics)

- A topic is a path, most general first, joined with ` › `. For example
  `Languages › Spanish › Verbs`, `Science › Chemistry › Bonding`,
  `Computing › Rust › Ownership`. `/`, `>` and `::` are accepted and converted.
- **Reuse existing topics.** Read `/topics` first, and put cards under the
  closest existing path before inventing a new one. Match its spelling and
  capitalisation (Title Case).
- Use 2–3 levels. Go deeper only when a branch passes about 50 cards.
- The owner studies by topic, so a topic should be something they would want
  to drill on its own.

## Prerequisites (optional)

Topics can name other topics they build on, e.g. `Computing › Rust › Lifetimes`
requires `Computing › Rust › Ownership`. These links are only shown on the
app's knowledge map; they never change scheduling. When you add cards for a
new topic that clearly depends on an existing one, add the link too. Keep it
to direct, real dependencies.

Links must form a DAG. `POST /links` returns `{added, skipped, warnings}`:
- **Skipped** (not saved): a link that would create a loop (the reason names
  the chain), a link between a topic and its own parent or child (the tree
  already shows that), or one that already exists.
- **Warnings** (saved): a link already implied by others, e.g. adding
  A → C when A → B → C exists. Prefer removing it unless it's deliberate.

Report skips and warnings to the user.

## Writing good cards

Follow Piotr Woźniak's *Twenty Rules of Formulating Knowledge* (and Andy
Matuschak's notes on prompts). In practice:

1. **Understand before memorising.** Only make cards for material the user has
   learned or asked about. Don't pad.
2. **Minimum information.** One fact per card. The answer should be a word, a
   phrase or one short sentence. If you're writing "and", split the card.
3. **No sets or enumerations.** Don't ask for "the 5 causes of X". Make one card
   per item ("Which cause of X involves …?"), or use overlapping clozes.
4. **Ask precisely.** There should be exactly one right answer. Add context to
   the question so it can't be read another way: "In Rust, …", "In Spanish, …".
5. **Use cloze-style phrasing for definitions**, e.g. "____ is the probability
   you can recall a card right now" → "Retrievability".
6. **Make cards both ways when both directions matter** (word → meaning,
   meaning → word) as two cards.
7. **Avoid interference.** Make similar facts clearly distinct in the question.
8. **Keep wording short.** Cut every word that doesn't help recall.
9. **Link to what the user already knows.** Examples and personal context help.
10. **Give a source** in `source` (book, URL, lesson) when there is one.

**Explanations (optional).** `explanation` is shown after the answer is
revealed. Use it for what helps the answer stick: why it's true, a mnemonic,
or a common mix-up. Aim for one or two sentences, roughly 250 characters at
most (not enforced). Leave it out when the answer speaks for itself, and never
just restate the answer. Keep the answer itself short; the explanation is not
a place to hide a second fact to memorise.

Formatting: `**bold**`, `*italic*`, `` `code` `` and line breaks render. Keep
it plain otherwise.

**Good**: `Q: In FSRS, what does a card's stability measure?`
`A: Days until recall probability falls to 90%`

**Bad**: `Q: Explain FSRS.` (too broad) · `Q: List the four FSRS grades.` (a set)

## Code layout

- `public/`: the app (static, mobile-first). `fsrs.js` is the scheduler,
  `app.js` the UI, `stats.js` the statistics page,
  `map.js` the knowledge map, `paste.js` the paste-import parser.
- `src/worker.js`: the API and asset serving (a Cloudflare Worker).
- `migrations/`: the D1 schema. Deployed with `npx wrangler deploy`.
