import { getEnforcedPlayer } from "../enforcedPlayer.js";
import {
  buildSubmissionFromRoute,
  calculateCoaxium,
  fetchStarDeliveryGameState,
  submitChallengeSolution,
  type SubmissionResult,
} from "../starDeliveryApi.js";
import type { ChallengeOut, PlanetOut, RouteOut, SolverResult } from "../types.js";
import { solveGraph, type SolveGraphOptions } from "../workflow.js";
import { challengeLabel, fmtNumber, printSubmitDetail } from "./challengeCliShared.js";
import { logQuietRunTotal, out } from "./cliOutput.js";

function printSolvedLine(
  challenge: ChallengeOut,
  result: SolverResult,
  submitResult: SubmissionResult | null,
  restError: string | null,
  ms: number,
  quiet: boolean,
): void {
  if (quiet) return;
  const kPart = `K=${fmtNumber(result.effectiveKUsed)}`;
  if (!result.success || result.route === null) {
    console.log(
      `"${challengeLabel(challenge)}" -> failed (${ms}ms; ${kPart}): ${result.errorMessage ?? "Unknown error"}`,
    );
    return;
  }
  if (restError) {
    console.log(
      `"${challengeLabel(challenge)}" -> effectiveFuel=${fmtNumber(result.effectiveFuel)} (${ms}ms; ${kPart}), submit=error`,
    );
    return;
  }
  const submitOk = submitResult?.isSuccess === true;
  console.log(
    `"${challengeLabel(challenge)}" -> effectiveFuel=${fmtNumber(result.effectiveFuel)} (${ms}ms; ${kPart}), submit=${submitOk ? "ok" : "failed"}`,
  );
}

function cliArgs(): string[] {
  const direct = process.argv.slice(2);
  if (direct.length > 0) return direct;

  const npmArgv = process.env.npm_config_argv;
  if (npmArgv) {
    try {
      const parsed = JSON.parse(npmArgv) as { original?: string[] };
      const original = parsed.original?.filter((arg) => arg.startsWith("--")) ?? [];
      if (original.length > 0) return original;
    } catch {
      // Ignore malformed npm_config_argv and try fallback keys below.
    }
  }

  const fallback: string[] = [];
  if (process.env.npm_config_all === "true") fallback.push("--all");
  if (process.env.npm_config_progress === "true") fallback.push("--progress");
  if (process.env.npm_config_includefinished === "true") fallback.push("--includeFinished");
  if (process.env.npm_config_challengeid) fallback.push(`--challengeId=${process.env.npm_config_challengeid}`);
  if (process.env.npm_config_warnafterms) fallback.push(`--warnAfterMs=${process.env.npm_config_warnafterms}`);
  if (process.env.npm_config_quiet === "true") fallback.push("--quiet");
  if (process.env.npm_config_no_ascent === "true") fallback.push("--no-ascent");
  return fallback;
}

function numberArg(name: string, args: readonly string[]): number | undefined {
  const raw = args.find((arg) => arg.startsWith(`${name}=`));
  if (!raw) return undefined;
  const parsed = Number(raw.split("=")[1]);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

async function loadContext(): Promise<{
  planets: PlanetOut[];
  routes: RouteOut[];
  challenges: ChallengeOut[];
  source: "api";
}> {
  const { playerGuid, playerEmail } = getEnforcedPlayer();
  const state = await fetchStarDeliveryGameState({ playerGuid, playerEmail });
  return {
    planets: state.planets,
    routes: state.routes,
    challenges: state.challenges,
    source: "api",
  };
}

async function main(): Promise<void> {
  const args = cliArgs();
  const quiet = args.includes("--quiet");
  const includeFinished = args.includes("--includeFinished");
  const skipAscent = args.includes("--no-ascent");
  const graphOpts: SolveGraphOptions | undefined = skipAscent ? { skipAscent: true } : undefined;
  const showProgress = !quiet && args.includes("--progress");
  const warnAfterMs = numberArg("--warnAfterMs", args) ?? 10000;
  if (!Number.isFinite(warnAfterMs) || warnAfterMs <= 0) {
    throw new Error("Invalid --warnAfterMs value. Use a positive number, e.g. --warnAfterMs=15000");
  }

  const selectedChallengeId = numberArg("--challengeId", args);
  const allowAll = args.includes("--all");
  if (selectedChallengeId !== undefined && !Number.isFinite(selectedChallengeId)) {
    throw new Error("Invalid --challengeId value. Use a numeric challenge id, e.g. --challengeId=1234");
  }
  if (selectedChallengeId === undefined && !allowAll) {
    throw new Error("For safety, provide --challengeId=<id> to submit one challenge, or --all to submit all pending.");
  }

  const runStartedAt = Date.now();

  out(quiet, "Fetching challenges and map data...");
  const { planets, routes, challenges, source } = await loadContext();
  const pendingAll = challenges.filter((challenge) => !challenge.isFinished);
  const filteredByFinished = includeFinished ? challenges : pendingAll;
  const pending =
    selectedChallengeId !== undefined
      ? filteredByFinished.filter((challenge) => challenge.challengeId === selectedChallengeId)
      : filteredByFinished;
  if (selectedChallengeId !== undefined && pending.length === 0) {
    const existsAsFinished = challenges.some(
      (challenge) => challenge.challengeId === selectedChallengeId && challenge.isFinished,
    );
    if (existsAsFinished && !includeFinished) {
      throw new Error(
        `Challenge ${selectedChallengeId} is finished and filtered out. Re-run with --includeFinished.`,
      );
    }
    throw new Error(`Challenge ${selectedChallengeId} not found in current challenge list.`);
  }
  const pendingNames = pending.map(challengeLabel).join(", ");

  out(quiet, `Source: ${source}`);
  out(quiet, `Include finished: ${includeFinished ? "yes" : "no"}`);
  out(quiet, `Pending: ${pendingNames || "(none)"}`);
  out(quiet, `K ladder ascent after first success: ${skipAscent ? "no (--no-ascent)" : "yes"}`);
  out(quiet, selectedChallengeId !== undefined ? "Submitting selected challenge..." : "Submitting all challenges...");

  const { playerGuid, playerEmail } = getEnforcedPlayer();
  const clientOpts = { playerGuid, playerEmail };
  const solved: Array<{
    challenge: ChallengeOut;
    result: SolverResult;
    elapsedMs: number;
    calculateResult: SubmissionResult | null;
    submitResult: SubmissionResult | null;
    restError: string | null;
  }> = [];
  const startedAt = Date.now();

  for (const challenge of pending) {
    const oneStart = Date.now();
    let attempts = 0;
    const result = solveGraph(challenge, planets, routes, {
      ...graphOpts,
      onBeforeSolveAttempt: ({ k, phase }) => {
        attempts++;
        if (!showProgress) return;
        const elapsed = Date.now() - oneStart;
        console.log(
          `  [progress] ${challengeLabel(challenge)} phase=${phase} k=${k} attempt=${attempts} elapsedMs=${elapsed}`,
        );
      },
    });

    let calculateResult: SubmissionResult | null = null;
    let submitResult: SubmissionResult | null = null;
    let restError: string | null = null;
    if (result.success && result.route !== null) {
      try {
        const planetsById = new Map(planets.map((planet) => [planet.id, planet] as const));
        const submission = buildSubmissionFromRoute(result.route, planetsById);
        calculateResult = await calculateCoaxium(challenge.challengeId, submission, clientOpts);
        submitResult = await submitChallengeSolution(challenge.challengeId, submission, clientOpts);
      } catch (error) {
        restError = String((error as Error).message ?? error);
      }
    }

    const elapsedMs = Date.now() - oneStart;
    solved.push({ challenge, result, elapsedMs, calculateResult, submitResult, restError });
    printSolvedLine(challenge, result, submitResult, restError, elapsedMs, quiet);
    if (!quiet && elapsedMs >= warnAfterMs) {
      console.log(
        `  [warning] ${challengeLabel(challenge)} took ${elapsedMs}ms (${attempts} ladder attempts, finalK=${result.effectiveKUsed}).`,
      );
    }
  }

  const totalMs = Date.now() - startedAt;
  out(quiet, `All challenges submitted in ${totalMs}ms total`);
  out(quiet, "");
  out(quiet, "---- SUBMIT RUN: routes that were submitted ----");
  out(quiet, "");

  const planetsById = new Map(planets.map((planet) => [planet.id, planet] as const));
  for (const row of solved) {
    printSubmitDetail(
      row.challenge,
      row.result,
      row.calculateResult,
      row.submitResult,
      row.restError,
      planetsById,
      { quiet },
    );
  }

  logQuietRunTotal(quiet, runStartedAt, "fetch + solve + submit");
}

main().catch((error) => {
  console.error(String((error as Error).message ?? error));
  process.exit(1);
});
