// FSRS (Free Spaced Repetition Scheduler) — FSRS-5 formulas with default weights.
// Grades: 1 Again, 2 Hard, 3 Good, 4 Easy.
const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY = -0.5, FACTOR = 19 / 81, DAY = 864e5;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export const retrievability = (days, s) => Math.pow(1 + FACTOR * days / s, DECAY);
const initD = g => W[4] - Math.exp(W[5] * (g - 1)) + 1;
const initS = g => Math.max(W[g - 1], 0.1);

function nextD(d, g) {
  const delta = -W[6] * (g - 3);
  const damped = d + delta * (10 - d) / 9;
  return clamp(W[7] * initD(4) + (1 - W[7]) * damped, 1, 10);
}
function recallS(d, s, r, g) {
  const hard = g === 2 ? W[15] : 1, easy = g === 4 ? W[16] : 1;
  return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy);
}
function forgetS(d, s, r) {
  const f = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
  return Math.min(f, s / Math.exp(W[17] * W[18]));
}
const shortTermS = (s, g) => s * Math.exp(W[17] * (g - 3 + W[18]));

export function intervalDays(s, retention = 0.9) {
  return Math.max(1, Math.round(s / FACTOR * (Math.pow(retention, 1 / DECAY) - 1)));
}

// card: { s, d, last, due, reps, lapses } — s/d undefined for new cards.
export function review(card, g, now = Date.now(), retention = 0.9) {
  let { s, d } = card;
  const lapses = (card.lapses || 0) + (g === 1 && s ? 1 : 0);
  if (s == null) { s = initS(g); d = clamp(initD(g), 1, 10); }
  else {
    const elapsed = (now - card.last) / DAY;
    if (elapsed < 1) s = shortTermS(s, g);
    else { const r = retrievability(elapsed, s); s = g === 1 ? forgetS(d, s, r) : recallS(d, s, r, g); }
    d = nextD(d, g);
  }
  const due = g === 1 ? now + 10 * 60e3 : now + intervalDays(s, retention) * DAY;
  return { ...card, s, d, last: now, due, reps: (card.reps || 0) + 1, lapses };
}

export function preview(card, now = Date.now(), retention) {
  return [1, 2, 3, 4].map(g => review(card, g, now, retention).due - now);
}
