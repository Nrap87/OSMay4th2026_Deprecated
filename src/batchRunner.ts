import { solveGraph, type SolveGraphOptions } from "./workflow.js";
import type {
  BatchChallengeResultRow,
  BatchRunReport,
  BatchRunSummary,
  ChallengeOut,
  PlanetOut,
  RouteOut,
} from "./types.js";

export interface BatchRunnerDeps {
  playerGuid: string;
  playerEmail: string;
  planets: PlanetOut[];
  routes: RouteOut[];
  submit: boolean;
  /** When set, used as the challenge list for this batch run. */
  challenges?: ChallengeOut[];
  /** Factory for per-challenge solver options (fresh virtual clock each challenge). */
  createSolveOptions?: (challengeId: number) => SolveGraphOptions;
  getKCheckpoint?: (challengeId: number) => Promise<number | undefined>;
  saveKCheckpoint?: (challengeId: number, k: number) => Promise<void>;
  clearKCheckpoint?: (challengeId: number) => Promise<void>;
  log?: (line: string) => void;
}

let customChallenges: ChallengeOut[] | null = null;

/** Override the challenge list for tests / experiments. */
export function setSimulatedChallenges(list: ChallengeOut[]): void {
  customChallenges = list;
}

function getChallenges(): ChallengeOut[] {
  return customChallenges ?? [];
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max) + "…";
}

/** Mirrors `ChallengeBatchRunner.RunAllOpenChallengesAsync` control flow (without HTTP). */
export async function runBatch(deps: BatchRunnerDeps): Promise<BatchRunReport> {
  const L = deps.log ?? (() => {});
  const summary: BatchRunSummary = {
    planetCount: deps.planets.length,
    routeCount: deps.routes.length,
    challengeCount: 0,
    skippedFinished: 0,
    solverSuccess: 0,
    solverFailure: 0,
  };
  const rows: BatchChallengeResultRow[] = [];

  const challenges = deps.challenges ?? getChallenges();
  summary.challengeCount = challenges.length;

  L(`Loaded map: ${deps.planets.length} planets, ${deps.routes.length} routes`);
  L(`Loaded daily challenges: ${challenges.length}`);

  for (const challenge of challenges) {
    const challengeId = challenge.challengeId;
    const challengeName = challenge.challengeName ?? "";

    if (challenge.isFinished && deps.submit) {
      summary.skippedFinished++;
      L(`\n[${challengeId}] ${challengeName} already finished — skipping (submit batch).`);
      rows.push({
        challengeId,
        challengeName,
        status: "Skipped (finished)",
        detail: "Submit batch skips finished challenges.",
        totalDurationMs: null,
      });
      continue;
    }

    L(`\n[${challengeId}] ${challengeName}`);

    let resumeK: number | undefined;
    if (deps.getKCheckpoint) {
      resumeK = await deps.getKCheckpoint(challengeId);
      if (resumeK !== undefined) {
        L(`  K ladder resume from stored checkpoint: K=${resumeK}`);
      }
    }

    const baseOpts = deps.createSolveOptions?.(challengeId) ?? {};
    const solved = solveGraph(challenge, deps.planets, deps.routes, {
      ...baseOpts,
      resumeLadderFromK: resumeK ?? baseOpts.resumeLadderFromK ?? null,
    });

    const wallMs = Math.round(solved.durationSeconds * 1000);

    if (!solved.success || solved.route === null) {
      summary.solverFailure++;
      const err = solved.errorMessage ?? "Unknown error";
      L(`  Solver failed: ${err}`);
      if (deps.saveKCheckpoint && solved.stoppedByTimeBudgetWithoutSuccess) {
        await deps.saveKCheckpoint(challengeId, solved.effectiveKUsed);
        L(`  Stored K checkpoint ${solved.effectiveKUsed} for challenge ${challengeId}`);
      }
      rows.push({
        challengeId,
        challengeName,
        status: "Solver failed",
        detail: truncate(err, 600),
        totalDurationMs: wallMs,
      });
      continue;
    }

    if (deps.clearKCheckpoint) {
      await deps.clearKCheckpoint(challengeId);
    }

    summary.solverSuccess++;
    L(`  Route found: effective=${solved.effectiveFuel}; REST API not called (simulator)`);
    rows.push({
      challengeId,
      challengeName,
      status: deps.submit ? "Solved + submit (sim)" : "Solved (dry run, sim)",
      detail: `effective fuel=${solved.effectiveFuel}; K used=${solved.effectiveKUsed}`,
      totalDurationMs: wallMs,
    });
  }

  return { summary, rows };
}
