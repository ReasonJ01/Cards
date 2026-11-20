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

Develop: `npm i`, `npx wrangler d1 execute cards --local --file migrations/0001_init.sql`, `npm run dev`.
Deploy: `npm run deploy`, or push to `main` if Workers Builds is connected.
