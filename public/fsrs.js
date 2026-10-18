/* RadDeck scheduler — FSRS-5 with short learning steps.
 *
 * A card's schedule lives in card.srs:
 *   state   "new" | "learning" | "review" | "relearning"
 *   step    index into the learning steps (learning/relearning only)
 *   due     ms timestamp when the card is next due
 *   s       stability (days)      d  difficulty (1..10)
 *   reps    successful reviews    lapses  times forgotten
 *   last    ms timestamp of the last review
 *
 * Grades: 1 Again, 2 Hard, 3 Good, 4 Easy.
 */
(function (root) {
  "use strict";

  const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
    1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
  const DECAY = -0.5;
  const FACTOR = 19 / 81;
  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;
  const LEARN_STEPS = [1 * MIN, 10 * MIN];
  const RELEARN_STEPS = [10 * MIN];

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function retrievability(elapsedDays, s) {
    if (s <= 0) return 0;
    return Math.pow(1 + (FACTOR * elapsedDays) / s, DECAY);
  }
  function intervalDays(s, retention) {
    return (s / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  }
  function initStability(g) {
    return Math.max(W[g - 1], 0.1);
  }
  function initDifficulty(g) {
    return clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10);
  }
  function nextDifficulty(d, g) {
    const delta = -W[6] * (g - 3);
    const dp = d + (delta * (10 - d)) / 9;
    return clamp(W[7] * initDifficulty(4) + (1 - W[7]) * dp, 1, 10);
  }
  function stabilityAfterRecall(d, s, r, g) {
    const hard = g === 2 ? W[15] : 1;
    const easy = g === 4 ? W[16] : 1;
    return s * (Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy + 1);
  }
  function stabilityAfterLapse(d, s, r) {
    const ns = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
    return Math.min(ns, s);
  }
  function stabilityShortTerm(s, g) {
    return s * Math.exp(W[17] * (g - 3 + W[18]));
  }

  function fresh() {
    return { state: "new", step: 0, due: 0, s: 0, d: 0, reps: 0, lapses: 0, last: 0 };
  }

  function reviewInterval(s, retention) {
    const days = Math.max(1, Math.round(intervalDays(s, retention)));
    return Math.min(days, 365 * 2) * DAY;
  }

  /** Returns the srs object that grading `g` at time `now` would produce. Pure. */
  function next(srs, g, now, opts) {
    const retention = (opts && opts.retention) || 0.9;
    const c = Object.assign(fresh(), srs || {});
    const out = Object.assign({}, c, { last: now });
    const elapsed = c.last ? (now - c.last) / DAY : 0;

    if (c.state === "new") {
      out.d = initDifficulty(g);
      out.s = initStability(g);
      if (g === 1) { out.state = "learning"; out.step = 0; out.due = now + LEARN_STEPS[0]; }
      else if (g === 2) { out.state = "learning"; out.step = 0; out.due = now + Math.round(LEARN_STEPS[0] * 1.5); }
      else if (g === 3) {
        if (LEARN_STEPS.length > 1) { out.state = "learning"; out.step = 1; out.due = now + LEARN_STEPS[1]; }
        else { out.state = "review"; out.reps = 1; out.due = now + reviewInterval(out.s, retention); }
      } else { out.state = "review"; out.reps = 1; out.due = now + reviewInterval(out.s, retention); }
      return out;
    }

    if (c.state === "learning" || c.state === "relearning") {
      const steps = c.state === "learning" ? LEARN_STEPS : RELEARN_STEPS;
      out.d = nextDifficulty(c.d || initDifficulty(3), g);
      out.s = stabilityShortTerm(c.s || initStability(3), g);
      if (g === 1) { out.step = 0; out.due = now + steps[0]; }
      else if (g === 2) { out.step = c.step; out.due = now + Math.round(steps[Math.min(c.step, steps.length - 1)] * 1.5); }
      else if (g === 3) {
        if (c.step + 1 < steps.length) { out.step = c.step + 1; out.due = now + steps[out.step]; }
        else { out.state = "review"; out.step = 0; out.reps = c.reps + 1; out.due = now + reviewInterval(out.s, retention); }
      } else {
        out.state = "review"; out.step = 0; out.reps = c.reps + 1;
        out.due = now + reviewInterval(Math.max(out.s, initStability(4)), retention);
      }
      return out;
    }

    /* review */
    const r = retrievability(elapsed, c.s);
    out.d = nextDifficulty(c.d, g);
    if (g === 1) {
      out.s = stabilityAfterLapse(c.d, c.s, r);
      out.lapses = c.lapses + 1;
      out.state = "relearning"; out.step = 0;
      out.due = now + RELEARN_STEPS[0];
    } else {
      out.s = stabilityAfterRecall(c.d, c.s, r, g);
      out.reps = c.reps + 1;
      out.due = now + reviewInterval(out.s, retention);
    }
    return out;
  }

  function previews(srs, now, opts) {
    const o = {};
    for (const g of [1, 2, 3, 4]) o[g] = next(srs, g, now, opts).due - now;
    return o;
  }

  function fmtSpan(ms) {
    const m = Math.round(ms / MIN);
    if (m < 60) return `${Math.max(1, m)}m`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d}d`;
    const mo = d / 30.4;
    if (mo < 12) return `${mo.toFixed(mo < 10 ? 1 : 0).replace(/\.0$/, "")}mo`;
    return `${(d / 365).toFixed(1).replace(/\.0$/, "")}y`;
  }

  function currentRetention(srs, now) {
    if (!srs || srs.state !== "review" || !srs.s) return null;
    return retrievability((now - srs.last) / DAY, srs.s);
  }

  root.FSRS = { next, previews, fresh, fmtSpan, currentRetention, DAY, MIN };
})(typeof window !== "undefined" ? window : globalThis);
