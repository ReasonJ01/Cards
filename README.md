# 🌷 Bloom Cards

Anki-style spaced repetition, scheduled by **FSRS**, designed to spark joy.

- FSRS-5 scheduler with default weights (`fsrs.js`), adjustable retention target
- Keyboard-first: `space` flip · `1–4` grade (space again = Good)
- A garden that grows with every review, streaks, combos, confetti
- Bulk import `front;back` / tab-separated lines (Anki text export works)
- JSON backup/restore; everything stays in your browser

Run locally: `python3 -m http.server -d public`, then open http://localhost:8000 (ES modules need a server).

Deploy: `npx wrangler deploy` (static assets on Cloudflare Workers).
