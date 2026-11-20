# Bloom

Spaced repetition that's a pleasure to use. RWKV-Instant, short rounds,
a variable bonus after each round. Lives at https://cards.reason.place.

RWKV-Instant now ranks reviews by lowest estimated recall, with browser-only
inference and configurable retention, daily limits and repeat spacing. FSRS
continues as a reversible fallback. See [RWKV-NOTICE.md](RWKV-NOTICE.md) for
model provenance, AGPL notices, limitations and the required D1 migration before
deploying. The design uses Cloudflare's free Workers/D1 allowances, not paid AI.

- Cards and progress are stored in Cloudflare D1, so they sync across devices.
- Agents add cards over the API. See [AGENTS.md](AGENTS.md) for the API and
  the card-writing rules.
- First visit: choose a key. That key unlocks other devices and is the
  `BLOOM_KEY` you give agents.

## MCP

The authenticated Streamable HTTP endpoint is **`https://cards.reason.place/mcp`**.
It runs in the same Cloudflare Worker/D1 deployment: no Durable Objects,
Dynamic Workers, Code Mode, paid inference, or extra service.

Connect using an `Authorization: Bearer <key>` header. Your existing Bloom key
works; a separate MCP-only key can instead be provisioned by storing its SHA-256
under `meta.mcp_key_hash`. The separate key cannot authenticate to `/api`.
Keep the actual key in your client's secret storage, never in the repository.

The MCP provides card search/add/edit/flag/delete, bulk moves/flagging, topic
renaming, prerequisite management, and a non-writing `validate_cards` tool.
Read `bloom://guidelines` (or call `get_guidelines`) and `list_topics` before
writing. The `write-cards` prompt includes the same authoring guidelines.
`AGENTS.md` is the source of those rules; `scripts/build-mcp-rules.js` refreshes
the bundled resource automatically before `npm run dev`, `npm test`, and
`npm run deploy` (run it yourself before invoking Wrangler directly).

New topics require `allow_new_topics: true`. Deletion, topic renaming and bulk
changes require `confirmed: true` **after explicit user approval**. This is an
intent marker, not an independent human-approval screen; the connected agent
must honour the user's intent. No MCP tool resets progress or submits reviews.
Edits preserve card IDs/history. Additions and links use the same API validation
and duplicate/DAG checks as the app. Wording-quality checks are guidance, not a
claim that a schema can verify facts or understand a card.

Develop: `npm i`, `npx wrangler d1 execute cards --local --file migrations/0001_init.sql`, `npm run dev`.
Deploy: `npm run deploy`, or push to `main` if Workers Builds is connected.
