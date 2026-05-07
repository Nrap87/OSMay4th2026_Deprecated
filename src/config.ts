/** K ladder + solver caps (tuned for fewer expensive solve passes). */

/** Absolute ceiling for Yen K inside `solver.solve` when callers pass large values. */
export const MaxRequestedK = 150;

/** Ceiling K for Yen segment candidates (also last escalation step target). */
export const KLadderTopK = 50;

/**
 * First K tried per challenge (single shortest path per segment when adaptive cap allows K=1).
 * Escalation increases K by {@link KLadderStep} until success or {@link KLadderTopK}.
 */
export const KLadderMinK = 1;

/** Increase K by this much after each retryable failure during escalation (and during ascent). */
export const KLadderStep = 1;

/** @deprecated Use {@link KLadderMinK}. Kept for external callers that still import the old name. */
export const KLadderFloorK = KLadderMinK;

/** Wall-clock budget (seconds) for the entire K ladder per challenge. */
export const KLadderTimeBudgetSeconds = 300;

/**
 * During ascent (K increasing after first success), stop after this many consecutive
 * successful solves that did not strictly improve the best (effective fuel, then gross).
 */
export const KLadderAscentStopAfterStaleSuccesses = 2;

/**
 * When true, stop after the first successful escalation (no ascent phase).
 * Faster runs; may miss a better route at higher K. CLI `--no-ascent` overrides per run.
 */
export const KLadderSkipAscent = false;
