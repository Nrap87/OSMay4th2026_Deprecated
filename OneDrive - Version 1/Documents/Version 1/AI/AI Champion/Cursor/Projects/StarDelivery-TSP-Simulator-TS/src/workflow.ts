import {
  KLadderAscentStopAfterStaleSuccesses,
  KLadderMinK,
  KLadderStep,
  KLadderTimeBudgetSeconds,
  KLadderTopK,
} from "./config.js";
import { solveChallengeTsp } from "./tspChallenge/index.js";
import type { ChallengeOut, PlanetOut, RouteOut, SolverResult } from "./types.js";

export type SolveGraphPhase = "escalate" | "ascent";

export interface SolveGraphOptions {
  resumeLadderFromK?: number | null;
  /** Millisecond clock (defaults to Date.now). */
  nowMs?: () => number;
  /** Called after each solver attempt — use to advance a fake clock for fast simulation. */
  afterEachAttempt?: () => void;
  /** Called immediately before each inner `solve` at ladder K (UI / streaming progress). */
  onBeforeSolveAttempt?: (info: { k: number; phase: SolveGraphPhase }) => void;
}

function isKladderTimeBudgetExceeded(startedMs: number, nowMs: () => number): boolean {
  return (nowMs() - startedMs) / 1000 >= KLadderTimeBudgetSeconds;
}

function isBetterSolution(candidate: SolverResult, currentBest: SolverResult): boolean {
  const epsilon = 1e-9;
  const delta = candidate.effectiveFuel - currentBest.effectiveFuel;
  if (delta < -epsilon) return true;
  if (delta > epsilon) return false;
  return candidate.grossFuel < currentBest.grossFuel - epsilon;
}

function isRetryableFailure(errorMessage: string | null): boolean {
  if (!errorMessage?.trim()) return true;
  const e = errorMessage;
  return (
    !e.startsWith("Start planet is not present") &&
    !e.startsWith("Start planet is forbidden") &&
    !e.startsWith("Mandatory planet ") &&
    !e.startsWith("Mandatory planets ") &&
    !e.startsWith("No route between required planets ")
  );
}

function solverResultFromTsp(
  challenge: ChallengeOut,
  planets: readonly PlanetOut[],
  routes: readonly RouteOut[],
  k: number,
): SolverResult {
  const startId = Number.parseInt(challenge.startPlanetId, 10) || 0;
  const solved = solveChallengeTsp({
    planets: planets.map((p) => ({
      id: p.id,
      name: p.name,
      x: p.coordinateX,
      y: p.coordinateY,
    })),
    routes: routes.map((r) => ({
      from: r.fromPlanet,
      to: r.toPlanetId,
      routeType: r.routeType ?? "",
    })),
    challenge: {
      startPlanetId: startId,
      mandatoryPlanetIds: challenge.mandatoryPlanets.map((p) => p.planetId),
      forbiddenPlanetIds: challenge.forbiddenPlanets.map((p) => p.planetId),
      bonusStops: challenge.bonusPlanets.map((p) => ({
        planetId: p.planetId,
        value: p.bonus,
      })),
    },
    requestedK: k,
  });

  return {
    success: solved.success,
    errorMessage: solved.errorMessage,
    route: solved.route,
    grossFuel: solved.grossFuel,
    bonusCollected: solved.bonusCollected,
    effectiveFuel: solved.effectiveFuel,
    effectiveKUsed: solved.effectiveKUsed,
    ladderMinKApplied: 0,
    ladderMaxKApplied: 0,
    executionStartUtc: "",
    executionEndUtc: "",
    durationSeconds: 0,
    stoppedByTimeBudgetWithoutSuccess: false,
  };
}

function stampExecutionMetadata(
  result: SolverResult,
  effectiveKUsed: number,
  startedAtMs: number,
  ladderMinK: number,
  ladderTop: number,
  nowMs: () => number,
): void {
  const endedMs = nowMs();
  result.effectiveKUsed = effectiveKUsed;
  result.executionStartUtc = new Date(startedAtMs).toISOString();
  result.executionEndUtc = new Date(endedMs).toISOString();
  result.durationSeconds = Math.max(0, (endedMs - startedAtMs) / 1000);
  result.ladderMinKApplied = ladderMinK;
  result.ladderMaxKApplied = ladderTop;
}

/** Strictly increasing K from minK through top (always ends at top when top > minK). */
function ladderKsEscalation(minK: number, maxK: number, step: number): number[] {
  if (maxK < minK) return [];
  const ks: number[] = [];
  for (let k = minK; k <= maxK; k += step) {
    ks.push(k);
  }
  const last = ks[ks.length - 1];
  if (last !== undefined && last < maxK && !ks.includes(maxK)) {
    ks.push(maxK);
  }
  return ks;
}

/** K values strictly above bestK through top; ensures maxK when a step would overshoot. */
function ladderKsAscent(bestK: number, maxK: number, step: number): number[] {
  const ks: number[] = [];
  for (let k = bestK + step; k <= maxK; k += step) {
    ks.push(k);
  }
  const last = ks[ks.length - 1];
  if (last !== undefined && last < maxK && !ks.includes(maxK)) {
    ks.push(maxK);
  }
  return ks;
}

function escalationSchedule(minK: number, maxK: number, step: number, resumeFromK: number | null): number[] {
  let ks = ladderKsEscalation(minK, maxK, step);
  if (resumeFromK === null) return ks;

  const resumeClamped = Math.min(Math.max(Math.floor(resumeFromK), minK), maxK);
  ks = ks.filter((k) => k >= resumeClamped);
  if (ks.length === 0) {
    return [resumeClamped];
  }
  if (ks[0]! > resumeClamped && !ks.includes(resumeClamped)) {
    ks = [resumeClamped, ...ks];
  }
  return ks;
}

/**
 * K ladder: escalate K from {@link KLadderMinK} to {@link KLadderTopK} until first success
 * (cheap few-shortest-path tries first; more segment alternatives on retryable failure),
 * then ascend seeking strictly better routes until stale successes or time budget.
 */
export function solveGraph(
  challenge: ChallengeOut,
  planets: readonly PlanetOut[],
  routes: readonly RouteOut[],
  options: SolveGraphOptions = {},
): SolverResult {
  const nowMs = options.nowMs ?? (() => Date.now());
  const startedMs = nowMs();
  const top = KLadderTopK;
  const minK = KLadderMinK;
  const step = KLadderStep;

  const escalationKs = escalationSchedule(minK, top, step, options.resumeLadderFromK ?? null);
  const startK = escalationKs[0] ?? minK;

  let lastFailure: SolverResult | null = null;
  let lastTriedK = startK;
  let attempts = 0;
  let best: SolverResult | null = null;
  let bestK: number | null = null;

  for (const k of escalationKs) {
    if (isKladderTimeBudgetExceeded(startedMs, nowMs)) break;

    attempts++;
    lastTriedK = k;
    options.onBeforeSolveAttempt?.({ k, phase: "escalate" });
    const solved = solverResultFromTsp(challenge, planets, routes, k);
    options.afterEachAttempt?.();

    if (!isRetryableFailure(solved.errorMessage) && !solved.success) {
      stampExecutionMetadata(solved, k, startedMs, minK, top, nowMs);
      return solved;
    }

    if (solved.success) {
      best = solved;
      bestK = k;
      break;
    }

    lastFailure = solved;
  }

  if (best === null || bestK === null) {
    if (lastFailure === null) {
      const failed: SolverResult = {
        success: false,
        errorMessage: "Solver failed to evaluate K ladder.",
        route: null,
        grossFuel: 0,
        bonusCollected: 0,
        effectiveFuel: 0,
        effectiveKUsed: lastTriedK,
        ladderMinKApplied: minK,
        ladderMaxKApplied: top,
        executionStartUtc: new Date(startedMs).toISOString(),
        executionEndUtc: new Date(nowMs()).toISOString(),
        durationSeconds: 0,
        stoppedByTimeBudgetWithoutSuccess:
          isKladderTimeBudgetExceeded(startedMs, nowMs) && best === null,
      };
      stampExecutionMetadata(failed, lastTriedK, startedMs, minK, top, nowMs);
      return failed;
    }

    const timedOut = isKladderTimeBudgetExceeded(startedMs, nowMs);
    let suffix = `(Escalation: ${attempts} attempts from start K=${startK}, step ${step}, range [${minK},${top}]; no successful route.)`;
    if (timedOut) suffix += ` Stopped: ${KLadderTimeBudgetSeconds}s time budget reached.`;

    lastFailure.errorMessage = `${lastFailure.errorMessage ?? "No valid route found."} ${suffix}`;
    stampExecutionMetadata(lastFailure, lastTriedK, startedMs, minK, top, nowMs);
    lastFailure.stoppedByTimeBudgetWithoutSuccess = timedOut;
    return lastFailure;
  }

  let staleSuccesses = 0;
  const ascentKs = ladderKsAscent(bestK, top, step);
  for (const k of ascentKs) {
    if (isKladderTimeBudgetExceeded(startedMs, nowMs)) break;

    attempts++;
    lastTriedK = k;
    options.onBeforeSolveAttempt?.({ k, phase: "ascent" });
    const solved = solverResultFromTsp(challenge, planets, routes, k);
    options.afterEachAttempt?.();

    if (!solved.success) continue;

    if (isBetterSolution(solved, best)) {
      best = solved;
      bestK = k;
      staleSuccesses = 0;
    } else {
      staleSuccesses++;
      if (staleSuccesses >= KLadderAscentStopAfterStaleSuccesses) break;
    }
  }

  stampExecutionMetadata(best, bestK, startedMs, minK, top, nowMs);
  return best;
}
