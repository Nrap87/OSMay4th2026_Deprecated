/** K ladder + solver caps (tuned for fewer expensive solve passes). */

/** Absolute ceiling for Yen K inside `solver.solve` when callers pass large values. */
export const MaxRequestedK = 150;

/** Ceiling K for Yen segment candidates (also last escalation step target). */
export const KLadderTopK = 80;

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
export const KLadderTimeBudgetSeconds = 1000;

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

/**
 * Maximum bonus planets processed by the exact TSP enumerator (`2^n` subsets).
 * Raises a clear solver error beyond this; increase only if you accept runtime risk.
 */
export const SolverMaxBonusPlanets = 22;

/**
 * Max DFS expanded nodes for a single inner solve (`solveChallengeTsp` at one ladder K).
 * `0` means unlimited. Prevents runaway CPU on pathological instances.
 */
export const TspInnerExpandedNodeBudget = 0;

/**
 * Before expensive DFS, try stitching the tour using only the shortest path per leg (KSP index 0).
 * Tightens `bestEffective` early so DFS prunes much more aggressively.
 */
export const TspCheapStitchBeforeDfs = true;

/**
 * If shortest-path-only stitching produces a valid tour for a visit order, skip DFS for that order.
 * Much faster when feasible; can miss lower fuel for that same visit order when better disjoint legs need a higher KSP index.
 * When {@link TspAggressiveSearch} is true, this behavior is enabled regardless of this flag.
 */
export const TspSkipDfsWhenCheapStitchSucceeds = false;

/**
 * When true (or when {@link TspAggressiveSearch} is true), try nearest-neighbor visit orders (+ reverse)
 * before other permutations for each bonus subset.
 */
export const TspHeuristicOrdersFirst = true;

/**
 * Master switch for fast search: caps permutations after Euclidean LB sort (see defaults below),
 * enables heuristic visit orders first, and skips DFS when a cheap disjoint stitch already works.
 * Set false for slower, more exhaustive enumeration within each ladder K.
 */
export const TspAggressiveSearch = true;

/**
 * Max visit orders per bonus subset after Euclidean LB sort (best LB first).
 * `0` means unlimited when {@link TspAggressiveSearch} is false; when aggressive and 0, uses {@link TspAggressiveDefaultMaxPermutations}.
 */
export const TspMaxPermutationsPerSubset = 0;

/** Default permutation cap when {@link TspAggressiveSearch} is true and {@link TspMaxPermutationsPerSubset} is 0. */
export const TspAggressiveDefaultMaxPermutations = 448;
