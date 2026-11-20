# RWKV-Instant in Bloom

Bloom's `rwkv.js`, `rwkv-scheduler.js` and `rwkv-id-seed.js` adapt the inference
math, feature layout and ID RNG from [JSchoreels/anki](https://github.com/JSchoreels/anki),
commit `4ae68fa860f989bd30a67faec4f98cdd455ad9d4`. Upstream notices:
Copyright Ankitects Pty Ltd and contributors; GNU AGPL version 3 or later.
Bloom modifications are provided under AGPL-3.0-or-later. The licence applies
as required to the covered combined work; this is not a permissively licensed
standalone scheduler. See `LICENSE-AGPL-3.0.txt` for the full licence and
`LICENSE-RWKV` for the original upstream notice. The public source link in
Review settings offers the corresponding modified source to network users.

## Bundled checkpoint and reference tests

- Model: upstream SM98, show-time, instant-only small model (331,511 parameters).
- Original files: `qt/aqt/rwkv_inference/sm98/{architecture.json,manifest.json,weights.f32.bin}`.
- Weight SHA-256: `a006dcc039d19142dc95d257d9c238fb93c7efa12b78e18ec6ae881ac9009a24`.
- Weights are bundled unmodified; no inference endpoint or third-party AI API.
- `tests/rwkv-sm98-vectors.json` contains the `features`, `ids`, `skip`, `fp32`
  fields of the first 12 rows of each of the two upstream reference sequences
  in `rslib/src/rwkv/testdata/sm98-vectors.json.gz` at that same commit.
- Tests compare all four rating probabilities with upstream FP32 outputs to
  absolute tolerance `0.0001`. Only the instant head is used: **not** the
  checkpoint's untrained curve head.

## App-specific adaptations and limitations

- A Bloom card is also its note; a topic is its deck; the owner and preset each
  use one shared stream. This is not a bit-identical Anki collection import.
- The worker replays the active cards' review history, retaining only the last
  `reps` answers of each card to respect existing progress resets. Deleted cards'
  old contributions to global state are not retained, since their topic history
  is unavailable. Topic changes rebuild state under the current topic.
- Legacy review logs have answer timestamps and ratings but no display timestamp
  or duration. For those entries the answer timestamp stands in for display
  time and duration uses upstream's missing-duration feature value (zero after
  normalization). New answers store actual display time and duration. Predictions
  using legacy logs therefore have less context than a full Anki revlog.
- Feature dates use the device's local calendar. Changing time zone can alter
  replay features, daily counts and review order.
- Settings are device-local. Review history syncs through D1; daily limits apply
  to the history known to that device, including pending offline answers.
- Every answer counts against the maximum: new, repeated or previously studied.
  New cards retain Bloom's existing 15/day allowance. Minimum reviews do not
  override the daily maximum or the repeat cooldown. Rounds end at 10 answers
  (or earlier when no eligible cards remain); there are no hardcoded relearning
  steps or forced Again repeats in RWKV mode.
- Ranking is recalculated after answers and before rounds. While on the home
  screen, scores refresh every 30 seconds. Queries never commit recurrent state.
- FSRS state continues updating for reversibility. If the model/worker fails,
  the UI explicitly reports FSRS fallback. Statistics' current recall and the
  knowledge map use RWKV when active; stability, difficulty and maturity retain
  the FSRS baseline. The FSRS due-date forecast is hidden in RWKV mode.

## Cloudflare free-tier design

The model is a static asset and inference runs in a browser Web Worker, not a
Cloudflare Worker and not Workers AI. The API remains Workers + D1; inference
adds no server-side model CPU or paid AI requests. Static asset requests are
free/unlimited. The free API allowance is 100,000 Worker requests/day with
10 ms CPU/invocation; D1 includes 5 million rows read/day, 100,000 written/day
and 5 GB total storage. Other apps on the account share relevant allowances.
This design is intended for personal use within those limits, not a guarantee
that every account or workload costs nothing.

References:
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://gist.github.com/bee-san/65ec80b328a5d15b0559880340111344

## Deploy in order

1. Back up/export the remote D1 database.
2. Apply **only the new** `migrations/0005_rwkv.sql` to the existing production
   schema: `npx wrangler d1 execute cards --remote --file migrations/0005_rwkv.sql`.
   If the deployment tracks all earlier migrations in `d1_migrations`, use
   `npm run db:migrate` instead. Do not reapply old ALTER TABLE migrations.
3. `npm run deploy` (or merge to the branch connected to Workers Builds).
4. Verify `/api/history` returns five-column rows, the model asset is accessible,
   and Review settings reports RWKV-Instant. Review a card and read back its
   timing/history before calling the production deployment verified.

Local checks: `npm ci`, `npx wrangler d1 migrations apply cards --local`,
`npm test`, `npx wrangler deploy --dry-run`, `npm run dev`.
