import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { getEnforcedPlayer } from "../enforcedPlayer.js";
import {
  buildSubmissionFromRoute,
  calculateCoaxium,
  fetchStarDeliveryGameState,
  submitChallengeSolution,
  type SubmissionResult,
} from "../starDeliveryApi.js";
import type { ChallengeOut, PlanetOut, RouteOut, SolverResult } from "../types.js";
import { solveGraph } from "../workflow.js";
import {
  challengeLabel,
  fmtNumber,
  formatRouteNames,
  levelLabel,
  printSubmitDetail,
} from "./challengeCliShared.js";
import { logQuietRunTotal, out } from "./cliOutput.js";
import type { SolveDryWorkerOutput } from "./solveDryWorker.js";

function printSolvedLine(challenge: ChallengeOut, result: SolverResult, ms: number, quiet: boolean): void {
  if (quiet) return;
  const kPart = `K=${fmtNumber(result.effectiveKUsed)}`;
  if (!result.success || result.route === null) {
    console.log(
      `"${challengeLabel(challenge)}" -> failed (${ms}ms; ${kPart}): ${result.errorMessage ?? "Unknown error"}`,
    );
    return;
  }
  console.log(
    `"${challengeLabel(challenge)}" -> effectiveFuel=${fmtNumber(result.effectiveFuel)} (${ms}ms; ${kPart})`,
  );
}

function printSolvedLineWithSubmit(
  challenge: ChallengeOut,
  result: SolverResult,
  submitResult: SubmissionResult | null,
  restError: string | null,
  solveMs: number,
  quiet: boolean,
): void {
  if (quiet) return;
  const kPart = `K=${fmtNumber(result.effectiveKUsed)}`;
  if (!result.success || result.route === null) {
    console.log(
      `"${challengeLabel(challenge)}" -> failed (${solveMs}ms; ${kPart}): ${result.errorMessage ?? "Unknown error"}`,
    );
    return;
  }
  if (restError) {
    console.log(
      `"${challengeLabel(challenge)}" -> effectiveFuel=${fmtNumber(result.effectiveFuel)} (${solveMs}ms; ${kPart}), submit=error`,
    );
    return;
  }
  const submitOk = submitResult?.isSuccess === true;
  console.log(
    `"${challengeLabel(challenge)}" -> effectiveFuel=${fmtNumber(result.effectiveFuel)} (${solveMs}ms; ${kPart}), submit=${submitOk ? "ok" : "failed"}`,
  );
}

function printDryRunDetail(
  challenge: ChallengeOut,
  result: SolverResult,
  planetsById: Map<number, PlanetOut>,
  quiet: boolean,
): void {
  if (quiet) return;
  console.log(`[${levelLabel(challenge)}] ${challengeLabel(challenge)}`);
  if (!result.success || result.route === null) {
    console.log(`  Solver failed: ${result.errorMessage ?? "Unknown error"}`);
    console.log(`  Effective K (last ladder attempt): ${fmtNumber(result.effectiveKUsed)}`);
    console.log("");
    return;
  }

  console.log(`  Effective K used : ${fmtNumber(result.effectiveKUsed)}`);
  console.log(`  Effective fuel : ${fmtNumber(result.effectiveFuel)}`);
  console.log(`  Gross fuel     : ${fmtNumber(result.grossFuel)}`);
  console.log(`  Bonus collected: ${fmtNumber(result.bonusCollected)}`);
  console.log(`  Route (${result.route.length} planets): ${formatRouteNames(result.route, planetsById)}`);
  console.log("");
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
  if (process.env.npm_config_progress === "true") fallback.push("--progress");
  if (process.env.npm_config_includefinished === "true") fallback.push("--includeFinished");
  if (process.env.npm_config_challengeid) fallback.push(`--challengeId=${process.env.npm_config_challengeid}`);
  if (process.env.npm_config_warnafterms) fallback.push(`--warnAfterMs=${process.env.npm_config_warnafterms}`);
  if (process.env.npm_config_parallel) fallback.push(`--parallel=${process.env.npm_config_parallel}`);
  if (process.env.npm_config_submit === "true") fallback.push("--submit");
  if (process.env.npm_config_quiet === "true") fallback.push("--quiet");
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

function solveOneInWorker(
  workerFilename: string,
  planets: PlanetOut[],
  routes: RouteOut[],
  challenge: ChallengeOut,
): Promise<SolveDryWorkerOutput> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerFilename, {
      workerData: { planets, routes, challenge },
    });
    worker.once("message", (msg: SolveDryWorkerOutput) => {
      settled = true;
      void worker.terminate();
      resolve(msg);
    });
    worker.once("error", (err) => {
      settled = true;
      void worker.terminate();
      reject(err);
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        reject(new Error(`solveDryWorker exited with code ${code}`));
      }
    });
  });
}

type SolvedRow = { challenge: ChallengeOut; result: SolverResult; elapsedMs: number };

/** Resolves one promise per challenge when that challenge's solve finishes (any order). */
function createSolveCompletionBridge(pendingOrdered: readonly ChallengeOut[]) {
  const resolvers = new Map<number, (row: SolvedRow) => void>();
  const promises = new Map<number, Promise<SolvedRow>>();
  for (const ch of pendingOrdered) {
    promises.set(
      ch.challengeId,
      new Promise<SolvedRow>((resolve) => {
        resolvers.set(ch.challengeId, resolve);
      }),
    );
  }
  return {
    complete(row: SolvedRow): void {
      const id = row.challenge.challengeId;
      const resolve = resolvers.get(id);
      if (!resolve) {
        throw new Error(`solveDry: completion for unknown challengeId=${id}`);
      }
      resolve(row);
    },
    wait(challengeId: number): Promise<SolvedRow> {
      const p = promises.get(challengeId);
      if (!p) {
        throw new Error(`solveDry: wait for unknown challengeId=${challengeId}`);
      }
      return p;
    },
  };
}

async function solveAllParallel(
  pending: ChallengeOut[],
  planets: PlanetOut[],
  routes: RouteOut[],
  parallel: number,
  onComplete?: (row: SolvedRow) => void,
): Promise<SolvedRow[]> {
  const workerFilename = fileURLToPath(new URL("./solveDryWorker.js", import.meta.url));
  const results: SolvedRow[] = new Array(pending.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, parallel), pending.length);

  async function workerLoop(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= pending.length) return;
      const challenge = pending[i]!;
      const { result, elapsedMs } = await solveOneInWorker(workerFilename, planets, routes, challenge);
      const row: SolvedRow = { challenge, result, elapsedMs };
      results[i] = row;
      onComplete?.(row);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
  return results;
}

async function solveSequentialWithNotify(
  pendingOrdered: readonly ChallengeOut[],
  planets: PlanetOut[],
  routes: RouteOut[],
  showProgress: boolean,
  onComplete: (row: SolvedRow) => void,
): Promise<SolvedRow[]> {
  const solved: SolvedRow[] = [];
  for (const challenge of pendingOrdered) {
    const oneStart = Date.now();
    let attempts = 0;
    const result = solveGraph(challenge, planets, routes, {
      onBeforeSolveAttempt: ({ k, phase }) => {
        attempts++;
        if (!showProgress) return;
        const elapsed = Date.now() - oneStart;
        console.log(
          `  [progress] ${challengeLabel(challenge)} phase=${phase} k=${k} attempt=${attempts} elapsedMs=${elapsed}`,
        );
      },
    });
    const elapsedMs = Date.now() - oneStart;
    const row: SolvedRow = { challenge, result, elapsedMs };
    solved.push(row);
    onComplete(row);
  }
  return solved;
}

function compareChallengeIdAsc(a: ChallengeOut, b: ChallengeOut): number {
  return a.challengeId - b.challengeId;
}

async function main(): Promise<void> {
  const args = cliArgs();
  const quiet = args.includes("--quiet");
  const includeFinished = args.includes("--includeFinished");
  const doSubmit = args.includes("--submit");
  let showProgress = !quiet && args.includes("--progress");
  const parallelRaw = numberArg("--parallel", args) ?? 1;
  if (!Number.isFinite(parallelRaw) || parallelRaw < 1 || !Number.isInteger(parallelRaw)) {
    throw new Error("Invalid --parallel value. Use a positive integer, e.g. --parallel=3");
  }
  const parallel = parallelRaw;

  if (parallel > 1 && showProgress) {
    out(
      quiet,
      "[solve:dry] --progress is ignored when --parallel > 1 (workers do not stream ladder attempts).",
    );
    showProgress = false;
  }

  const warnAfterMs = numberArg("--warnAfterMs", args) ?? 10000;
  if (!Number.isFinite(warnAfterMs) || warnAfterMs <= 0) {
    throw new Error("Invalid --warnAfterMs value. Use a positive number, e.g. --warnAfterMs=15000");
  }

  const selectedChallengeId = numberArg("--challengeId", args);
  if (selectedChallengeId !== undefined && !Number.isFinite(selectedChallengeId)) {
    throw new Error("Invalid --challengeId value. Use a numeric challenge id, e.g. --challengeId=1234");
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

  const pendingOrdered = [...pending].sort(compareChallengeIdAsc);

  out(quiet, `Source: ${source}`);
  out(quiet, `Include finished: ${includeFinished ? "yes" : "no"}`);
  out(quiet, `Parallel solve slots: ${parallel}`);
  out(
    quiet,
    `Submit after solve: ${
      doSubmit
        ? "yes (challengeId ascending; each submit after prior id completes — overlaps with remaining solves)"
        : "no"
    }`,
  );
  out(quiet, `Pending: ${pendingNames || "(none)"}`);
  out(quiet, selectedChallengeId !== undefined ? "Solving selected challenge..." : "Solving all challenges...");

  const startedAt = Date.now();
  const planetsById = new Map(planets.map((planet) => [planet.id, planet] as const));

  type SubmitAccum = {
    challenge: ChallengeOut;
    result: SolverResult;
    solveElapsedMs: number;
    calculateResult: SubmissionResult | null;
    submitResult: SubmissionResult | null;
    restError: string | null;
    skippedReason: string | null;
  };

  let solved: SolvedRow[] = [];
  let submitRows: SubmitAccum[] = [];

  if (doSubmit && pendingOrdered.length > 0) {
    const bridge = createSolveCompletionBridge(pendingOrdered);
    const { playerGuid, playerEmail } = getEnforcedPlayer();
    const clientOpts = { playerGuid, playerEmail };

    const solvePromise =
      parallel === 1
        ? solveSequentialWithNotify(pendingOrdered, planets, routes, showProgress, (row) => bridge.complete(row))
        : solveAllParallel(pendingOrdered, planets, routes, parallel, (row) => bridge.complete(row));

    let stopped = false;
    let stopReason = "";

    const consumerPromise = (async (): Promise<SolvedRow[]> => {
      const out: SolvedRow[] = [];
      for (const ch of pendingOrdered) {
        const row = await bridge.wait(ch.challengeId);
        out.push(row);
        printSolvedLine(row.challenge, row.result, row.elapsedMs, quiet);
        if (!quiet && row.elapsedMs >= warnAfterMs) {
          console.log(
            `  [warning] ${challengeLabel(row.challenge)} took ${row.elapsedMs}ms (finalK=${row.result.effectiveKUsed}).`,
          );
        }

        if (!row.result.success || row.result.route === null) {
          continue;
        }

        if (stopped) {
          submitRows.push({
            challenge: row.challenge,
            result: row.result,
            solveElapsedMs: row.elapsedMs,
            calculateResult: null,
            submitResult: null,
            restError: null,
            skippedReason: stopReason,
          });
          continue;
        }

        let calculateResult: SubmissionResult | null = null;
        let submitResult: SubmissionResult | null = null;
        let restError: string | null = null;
        const submission = buildSubmissionFromRoute(row.result.route, planetsById);
        try {
          calculateResult = await calculateCoaxium(row.challenge.challengeId, submission, clientOpts);
          submitResult = await submitChallengeSolution(row.challenge.challengeId, submission, clientOpts);
        } catch (error) {
          restError = String((error as Error).message ?? error);
        }

        const submitOk = restError === null && submitResult?.isSuccess === true;
        submitRows.push({
          challenge: row.challenge,
          result: row.result,
          solveElapsedMs: row.elapsedMs,
          calculateResult,
          submitResult,
          restError,
          skippedReason: null,
        });
        printSolvedLineWithSubmit(row.challenge, row.result, submitResult, restError, row.elapsedMs, quiet);

        if (!submitOk) {
          stopped = true;
          stopReason =
            restError ?? `submit isSuccess=${submitResult?.isSuccess ?? false}; ${submitResult?.feedbackMessage ?? ""}`;
          console.error(
            `Stopping sequential submit after challengeId=${row.challenge.challengeId}: ${stopReason.trim() || "failure"}`,
          );
        }
      }

      for (const row of out) {
        if (row.result.success && row.result.route !== null) continue;
        submitRows.push({
          challenge: row.challenge,
          result: row.result,
          solveElapsedMs: row.elapsedMs,
          calculateResult: null,
          submitResult: null,
          restError: null,
          skippedReason: "Solver did not produce a route",
        });
      }

      return out;
    })();

    const [, solvedFromConsumer] = await Promise.all([solvePromise, consumerPromise]);
    solved = solvedFromConsumer;
  } else if (parallel === 1) {
    solved = [];
    for (const challenge of pendingOrdered) {
      const oneStart = Date.now();
      let attempts = 0;
      const result = solveGraph(challenge, planets, routes, {
        onBeforeSolveAttempt: ({ k, phase }) => {
          attempts++;
          if (!showProgress) return;
          const elapsed = Date.now() - oneStart;
          console.log(
            `  [progress] ${challengeLabel(challenge)} phase=${phase} k=${k} attempt=${attempts} elapsedMs=${elapsed}`,
          );
        },
      });
      const elapsedMs = Date.now() - oneStart;
      solved.push({ challenge, result, elapsedMs });
      printSolvedLine(challenge, result, elapsedMs, quiet);
      if (!quiet && elapsedMs >= warnAfterMs) {
        console.log(
          `  [warning] ${challengeLabel(challenge)} took ${elapsedMs}ms (${attempts} ladder attempts, finalK=${result.effectiveKUsed}).`,
        );
      }
    }
  } else {
    solved = await solveAllParallel(pendingOrdered, planets, routes, parallel);
    for (const row of solved) {
      printSolvedLine(row.challenge, row.result, row.elapsedMs, quiet);
      if (!quiet && row.elapsedMs >= warnAfterMs) {
        console.log(
          `  [warning] ${challengeLabel(row.challenge)} took ${row.elapsedMs}ms (finalK=${row.result.effectiveKUsed}).`,
        );
      }
    }
  }

  const totalWallMs = Date.now() - startedAt;
  out(
    quiet,
    doSubmit
      ? `Run finished in ${totalWallMs}ms total (includes parallel solve and pipelined submit, in challengeId order).`
      : `All challenges solved in ${totalWallMs}ms total`,
  );
  out(quiet, "");
  out(quiet, "---- DRY RUN: routes that would be submitted ----");
  out(quiet, "");

  const solvedSortedAsc = solved;
  for (const row of solvedSortedAsc) {
    printDryRunDetail(row.challenge, row.result, planetsById, quiet);
  }

  if (!doSubmit) {
    out(quiet, "Dry run complete - nothing was submitted.");
    logQuietRunTotal(quiet, runStartedAt, "fetch + solve (dry run)");
    return;
  }

  if (pendingOrdered.length === 0) {
    out(quiet, "No challenges to submit.");
    logQuietRunTotal(quiet, runStartedAt, "fetch + solve (dry run); no pending to submit");
    return;
  }

  out(quiet, "---- SUBMIT RUN: detail ----");
  out(quiet, "");

  for (const acc of submitRows.sort((a, b) => compareChallengeIdAsc(a.challenge, b.challenge))) {
    if (acc.skippedReason && acc.calculateResult === null && acc.submitResult === null && !acc.restError) {
      if (!quiet) {
        console.log(`[${levelLabel(acc.challenge)}] ${challengeLabel(acc.challenge)}`);
        console.log(`  Skipped: ${acc.skippedReason}`);
        console.log(`  Effective K (last ladder attempt): ${fmtNumber(acc.result.effectiveKUsed)}`);
        console.log("");
      }
      continue;
    }
    printSubmitDetail(
      acc.challenge,
      acc.result,
      acc.calculateResult,
      acc.submitResult,
      acc.restError,
      planetsById,
      { quiet },
    );
  }

  out(quiet, "solve:dry --submit finished.");
  logQuietRunTotal(quiet, runStartedAt, "fetch + solve + submit");
}

main().catch((error) => {
  console.error(String((error as Error).message ?? error));
  process.exit(1);
});
