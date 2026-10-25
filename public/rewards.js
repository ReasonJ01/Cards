// The reward engine: every number that decides XP, luck and streaks lives here.
//
// One rule above all: rewards never depend on which grade you press. Every
// review pays the same base, and momentum counts reviews in a row, not correct
// answers — so nothing nudges you to grade yourself generously, which would
// corrupt FSRS's data and your memory.

export const BASE_XP = 10;
export const DAILY_GOAL = 20;          // reviews to close the daily ring (separate from the streak)
export const GOAL_BONUS = 50;
export const POT_START = 500, POT_GROWTH = 3, POT_ODDS = 1 / 500;
export const FREEZE_EVERY = 7, FREEZE_MAX = 2;
export const WAGER = { stake: 100, days: 7, payout: 300 };
export const MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365, 500, 1000];

// Momentum: grows with every review in a round, wrong answers included.
export const momentum = n => 1 + Math.min(n, 20) * 0.05; // ×1.0 → ×2.0 at 20 in a row

// Per-review variable reward. Rare, escalating, and unrelated to the grade.
export function crit() {
  const r = Math.random();
  if (r < 1 / 250) return { x: 25, label: 'ULTRA' };
  if (r < 1 / 250 + 1 / 40) return { x: 5, label: 'MEGA' };
  if (r < 1 / 250 + 1 / 40 + 1 / 8) return { x: 2, label: 'CRIT' };
  return null;
}

// Happy hour: one random hour a day (between 09:00 and 21:59), the same on every
// device because it's derived from the date.
export function happyHour(dayKey) {
  let h = 2166136261;
  for (const ch of dayKey) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return 9 + ((h >>> 0) % 13);
}
export const isHappy = (dayKey, now = new Date()) => now.getHours() === happyHour(dayKey);

// Slot machine. Every spin pays something (a loss is still a small win), two
// of a kind is common, three of a kind is rare, three stars wins the pot.
export const SYMBOLS = ['◆', '●', '▲', '✦', '★'];
const PAY3 = { '◆': 120, '●': 160, '▲': 220, '✦': 400 };
export function spin(pot) {
  const r = Math.random(), pick = () => SYMBOLS[Math.random() * 4 | 0];
  let reels, xp, label, jackpot = false, nearMiss = false;
  if (r < 1 / 200) { reels = ['★', '★', '★']; xp = pot; label = 'JACKPOT'; jackpot = true }
  else if (r < 0.06) { const s = pick(); reels = [s, s, s]; xp = PAY3[s]; label = 'Three of a kind' }
  else if (r < 0.40) { const s = pick(); let o; do o = pick(); while (o === s); reels = [s, s, o]; xp = 30 + (Math.random() * 30 | 0); label = 'Pair' }
  else {
    // A near miss a third of the time: two stars on the line, the third just past it.
    if (Math.random() < 0.35) { reels = ['★', '★', pick()]; nearMiss = true; label = 'So close' }
    else { const a = pick(); let b, c; do b = pick(); while (b === a); do c = pick(); while (c === a || c === b); reels = [a, b, c]; label = 'Bonus' }
    xp = 10 + (Math.random() * 15 | 0);
  }
  return { reels, xp, label, jackpot, nearMiss };
}

// Streak bookkeeping on the first review of a day. Mutates and returns events.
export function extendStreak(st, today, daysBetween) {
  const ev = [];
  if (st.lastDay === today) return ev;
  const gap = st.lastDay ? daysBetween(st.lastDay, today) : Infinity; // 1 = consecutive
  if (gap === 1) st.streak++;
  else if (gap - 1 <= (st.freezes || 0)) { st.freezes -= gap - 1; st.streak++; ev.push({ type: 'freeze', used: gap - 1 }) }
  else {
    if (st.streak > 1) ev.push({ type: 'reset', was: st.streak });
    if (st.wager) { ev.push({ type: 'wager-lost', stake: st.wager.stake }); st.wager = null }
    st.streak = 1;
  }
  st.lastDay = today;
  if (st.streak % FREEZE_EVERY === 0 && (st.freezes || 0) < FREEZE_MAX) { st.freezes = (st.freezes || 0) + 1; ev.push({ type: 'freeze-earned' }) }
  if (MILESTONES.includes(st.streak)) ev.push({ type: 'milestone', days: st.streak });
  if (st.wager && st.streak - st.wager.startStreak >= WAGER.days) { ev.push({ type: 'wager-won', payout: st.wager.payout }); st.xp += st.wager.payout; st.wager = null }
  ev.push({ type: 'daily', bonus: 20 * Math.min(st.streak, 10) });
  return ev;
}
