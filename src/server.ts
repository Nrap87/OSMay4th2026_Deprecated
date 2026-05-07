/**
 * Serves Vite-built React UI from `public/` + JSON API (solver stays in Node TS).
 */
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runBatch } from "./batchRunner.js";
import { FileCheckpointStore } from "./checkpointStore.js";
import {
  buildSubmissionFromRoute,
  calculateCoaxium,
  fetchStarDeliveryGameState,
  submitChallengeSolution,
} from "./starDeliveryApi.js";
import type { SubmissionResult } from "./starDeliveryApi.js";
import type { ChallengeOut, PlanetOut, RouteOut } from "./types.js";
import { solveGraph, type SolveGraphOptions } from "./workflow.js";
import { WebBatchLog } from "./webBatchLog.js";
import { getEnforcedPlayer } from "./enforcedPlayer.js";
import { runCliCommand, type CliCommandKind } from "./cliRunnerServer.js";
import { getGithubDispatchConfigPublic, postRepositoryDispatch } from "./githubRepositoryDispatch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, ".data");

const checkpointStore = new FileCheckpointStore(path.join(dataDir, "checkpoints.json"));
const batchLog = new WebBatchLog(path.join(dataDir, "web-batches.json"));

const port = Number(process.env.PORT ?? "5175");

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function safePublicPath(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  if (decoded.includes("..")) return null;
  const clean = decoded === "/" ? "/index.html" : decoded;
  return path.normalize(path.join(publicDir, clean));
}

async function tryServeStatic(urlPath: string, res: http.ServerResponse): Promise<boolean> {
  const filePath = safePublicPath(urlPath);
  if (!filePath || !filePath.startsWith(publicDir)) {
    res.writeHead(403).end();
    return true;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const ct =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".js"
            ? "application/javascript; charset=utf-8"
            : "application/octet-stream";
    res.writeHead(200, { "Content-Type": ct, "Content-Length": data.length });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function createPerChallengeClock(virtualSecondsPerAttempt: number): (challengeId: number) => SolveGraphOptions {
  return () => {
    let virtualMs = Date.now();
    return {
      nowMs: () => virtualMs,
      afterEachAttempt: () => {
        virtualMs += virtualSecondsPerAttempt * 1000;
      },
    };
  };
}

function createBatchSolveOptions(
  fastSim: boolean,
  virtualSecondsPerAttempt: number,
  skipAscent: boolean,
): ((challengeId: number) => SolveGraphOptions) | undefined {
  if (fastSim) {
    const inner = createPerChallengeClock(virtualSecondsPerAttempt);
    if (!skipAscent) return inner;
    return (cid) => ({ ...inner(cid), skipAscent: true });
  }
  if (skipAscent) {
    return () => ({ skipAscent: true });
  }
  return undefined;
}

async function loadGameContext(): Promise<{
  planets: PlanetOut[];
  routes: RouteOut[];
  challenges: ChallengeOut[];
}> {
  const { playerGuid, playerEmail } = getEnforcedPlayer();
  const state = await fetchStarDeliveryGameState({ playerGuid, playerEmail });
  return { planets: state.planets, routes: state.routes, challenges: state.challenges };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/sim-state") {
      const { playerGuid, playerEmail } = getEnforcedPlayer();
      try {
        const state = await fetchStarDeliveryGameState({ playerGuid, playerEmail });
        json(res, 200, {
          source: "api",
          planets: state.planets,
          routes: state.routes,
          challenges: state.challenges,
          planetCount: state.planets.length,
          routeCount: state.routes.length,
          challengeCount: state.challenges.length,
        });
      } catch (e) {
        json(res, 502, {
          source: "api",
          error: String((e as Error).message ?? e),
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/checkpoints") {
      const map = await checkpointStore.loadAll();
      const rows = [...map.values()].sort(
        (a, b) => new Date(b.updatedAtUtc).getTime() - new Date(a.updatedAtUtc).getTime(),
      );
      json(res, 200, { rows });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/batches") {
      const items = await batchLog.readAll();
      json(res, 200, { items });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/batches/")) {
      const id = Number(url.pathname.replace("/api/batches/", ""));
      if (!Number.isFinite(id)) {
        json(res, 400, { error: "Invalid id" });
        return;
      }
      const item = await batchLog.getById(id);
      if (!item) {
        json(res, 404, { error: "Not found" });
        return;
      }
      json(res, 200, item);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run-batch") {
      const raw = await readBody(req);
      let body: {
        submit?: boolean;
        fastSim?: boolean;
        virtualSecondsPerAttempt?: number;
        useFixture?: boolean;
        skipAscent?: boolean;
      } = {};
      try {
        body = raw ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        json(res, 400, { error: "Invalid JSON" });
        return;
      }

      const submit = Boolean(body.submit);
      const { playerGuid, playerEmail } = getEnforcedPlayer();
      const fastSim = body.fastSim !== false;
      const skipAscent = body.skipAscent === true;
      const virtualSecondsPerAttempt =
        typeof body.virtualSecondsPerAttempt === "number" && body.virtualSecondsPerAttempt > 0
          ? body.virtualSecondsPerAttempt
          : 95;
      if (Boolean(body.useFixture)) {
        json(res, 400, { error: "Fixture mode has been removed; use live API only." });
        return;
      }

      const { planets, routes, challenges } = await loadGameContext();

      const logLines: string[] = [];
      const log = (line: string) => logLines.push(line);

      const report = await runBatch({
        playerGuid,
        playerEmail,
        planets,
        routes,
        challenges,
        submit,
        createSolveOptions: createBatchSolveOptions(fastSim, virtualSecondsPerAttempt, skipAscent),
        getKCheckpoint: (cid) => checkpointStore.getResumeK(playerGuid, playerEmail, cid),
        saveKCheckpoint: (cid, k) => checkpointStore.save(playerGuid, playerEmail, cid, k),
        clearKCheckpoint: (cid) => checkpointStore.clear(playerGuid, playerEmail, cid),
        log,
      });

      const stored = await batchLog.append({
        submit,
        playerGuid,
        playerEmail,
        report,
        logLines,
      });

      json(res, 200, { batchId: stored.id, report, logLines });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/solve-challenge-dry") {
      const raw = await readBody(req);
      let body: {
        challengeId?: number;
        fastSim?: boolean;
        virtualSecondsPerAttempt?: number;
        useFixture?: boolean;
        skipAscent?: boolean;
      } = {};
      try {
        body = raw ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        json(res, 400, { error: "Invalid JSON" });
        return;
      }

      const challengeId = Number(body.challengeId);
      if (!Number.isFinite(challengeId)) {
        json(res, 400, { error: "challengeId must be a finite number" });
        return;
      }

      const fastSim = body.fastSim !== false;
      const skipAscent = body.skipAscent === true;
      const virtualSecondsPerAttempt =
        typeof body.virtualSecondsPerAttempt === "number" && body.virtualSecondsPerAttempt > 0
          ? body.virtualSecondsPerAttempt
          : 95;
      if (Boolean(body.useFixture)) {
        json(res, 400, { error: "Fixture mode has been removed; use live API only." });
        return;
      }

      const { playerGuid, playerEmail } = getEnforcedPlayer();
      const { planets, routes, challenges } = await loadGameContext();
      const allChallenges = challenges;
      const challenge = allChallenges.find((c) => c.challengeId === challengeId);
      if (!challenge) {
        json(res, 404, { error: `Challenge ${challengeId} not found in current puzzle list` });
        return;
      }

      const logLines: string[] = [];
      const L = (line: string) => logLines.push(line);
      L(`Dry run: [${challenge.challengeId}] ${challenge.challengeName ?? ""}`);
      if (challenge.isFinished) {
        L("  Note: challenge is marked finished on API — still running local solver (no submit).");
      }

      let resumeK: number | undefined = await checkpointStore.getResumeK(
        playerGuid,
        playerEmail,
        challenge.challengeId,
      );
      if (resumeK !== undefined) {
        L(`  K ladder resume from checkpoint: K=${resumeK}`);
      }

      const baseOpts = fastSim ? createPerChallengeClock(virtualSecondsPerAttempt)(challenge.challengeId) : {};
      const solved = solveGraph(challenge, planets, routes, {
        ...baseOpts,
        ...(skipAscent ? { skipAscent: true } : {}),
        resumeLadderFromK: resumeK ?? baseOpts.resumeLadderFromK ?? null,
      });

      if (!solved.success || solved.route === null) {
        L(`  Solver failed: ${solved.errorMessage ?? "Unknown error"}`);
        if (solved.stoppedByTimeBudgetWithoutSuccess) {
          await checkpointStore.save(playerGuid, playerEmail, challenge.challengeId, solved.effectiveKUsed);
          L(`  Stored K checkpoint ${solved.effectiveKUsed} (time budget, no success)`);
        }
      } else {
        await checkpointStore.clear(playerGuid, playerEmail, challenge.challengeId);
        L(
          `  Route found: effective=${solved.effectiveFuel}; K used=${solved.effectiveKUsed}; REST submit not called (dry run)`,
        );
      }

      json(res, 200, {
        challengeId: challenge.challengeId,
        challengeName: challenge.challengeName,
        dryRun: true,
        solverResult: solved,
        logLines,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/solve-challenge-dry-stream") {
      const raw = await readBody(req);
      let body: {
        challengeId?: number;
        fastSim?: boolean;
        virtualSecondsPerAttempt?: number;
        useFixture?: boolean;
        skipAscent?: boolean;
      } = {};
      try {
        body = raw ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        json(res, 400, { error: "Invalid JSON" });
        return;
      }

      const challengeId = Number(body.challengeId);
      if (!Number.isFinite(challengeId)) {
        json(res, 400, { error: "challengeId must be a finite number" });
        return;
      }

      const fastSim = body.fastSim !== false;
      const skipAscent = body.skipAscent === true;
      const virtualSecondsPerAttempt =
        typeof body.virtualSecondsPerAttempt === "number" && body.virtualSecondsPerAttempt > 0
          ? body.virtualSecondsPerAttempt
          : 95;
      if (Boolean(body.useFixture)) {
        json(res, 400, { error: "Fixture mode has been removed; use live API only." });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      const sendLine = (obj: object) => {
        res.write(`${JSON.stringify(obj)}\n`);
      };

      try {
        const { playerGuid, playerEmail } = getEnforcedPlayer();
        const { planets, routes, challenges } = await loadGameContext();
        const allChallenges = challenges;
        const challenge = allChallenges.find((c) => c.challengeId === challengeId);
        if (!challenge) {
          sendLine({ type: "error", error: `Challenge ${challengeId} not found in current puzzle list` });
          res.end();
          return;
        }

        const logLines: string[] = [];
        const L = (line: string) => logLines.push(line);
        L(`Dry run: [${challenge.challengeId}] ${challenge.challengeName ?? ""}`);
        if (challenge.isFinished) {
          L("  Note: challenge is marked finished on API — still running local solver (no submit).");
        }

        let resumeK: number | undefined = await checkpointStore.getResumeK(
          playerGuid,
          playerEmail,
          challenge.challengeId,
        );
        if (resumeK !== undefined) {
          L(`  K ladder resume from checkpoint: K=${resumeK}`);
        }

        const baseOpts = fastSim ? createPerChallengeClock(virtualSecondsPerAttempt)(challenge.challengeId) : {};
        const solved = solveGraph(challenge, planets, routes, {
          ...baseOpts,
          ...(skipAscent ? { skipAscent: true } : {}),
          resumeLadderFromK: resumeK ?? baseOpts.resumeLadderFromK ?? null,
          onBeforeSolveAttempt: ({ k, phase }) => {
            sendLine({ type: "progress", k, phase });
          },
        });

        if (!solved.success || solved.route === null) {
          L(`  Solver failed: ${solved.errorMessage ?? "Unknown error"}`);
          if (solved.stoppedByTimeBudgetWithoutSuccess) {
            await checkpointStore.save(playerGuid, playerEmail, challenge.challengeId, solved.effectiveKUsed);
            L(`  Stored K checkpoint ${solved.effectiveKUsed} (time budget, no success)`);
          }
        } else {
          await checkpointStore.clear(playerGuid, playerEmail, challenge.challengeId);
          L(
            `  Route found: effective=${solved.effectiveFuel}; K used=${solved.effectiveKUsed}; REST submit not called (dry run)`,
          );
        }

        sendLine({
          type: "complete",
          challengeId: challenge.challengeId,
          challengeName: challenge.challengeName,
          dryRun: true,
          solverResult: solved,
          logLines,
        });
      } catch (e) {
        sendLine({ type: "error", error: String((e as Error).message ?? e) });
      }
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/challenge-submit") {
      const raw = await readBody(req);
      let body: {
        challengeId?: number;
        submit?: boolean;
        fastSim?: boolean;
        virtualSecondsPerAttempt?: number;
        skipAscent?: boolean;
      } = {};
      try {
        body = raw ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        json(res, 400, { error: "Invalid JSON" });
        return;
      }

      const challengeId = Number(body.challengeId);
      if (!Number.isFinite(challengeId)) {
        json(res, 400, { error: "challengeId must be a finite number" });
        return;
      }

      const submitToApi = Boolean(body.submit);
      const fastSim = body.fastSim !== false;
      const skipAscent = body.skipAscent === true;
      const virtualSecondsPerAttempt =
        typeof body.virtualSecondsPerAttempt === "number" && body.virtualSecondsPerAttempt > 0
          ? body.virtualSecondsPerAttempt
          : 95;

      const { playerGuid, playerEmail } = getEnforcedPlayer();
      const clientOpts = { playerGuid, playerEmail };

      const { planets, routes, challenges } = await loadGameContext();
      const allChallenges = challenges;
      const challenge = allChallenges.find((c) => c.challengeId === challengeId);
      if (!challenge) {
        json(res, 404, { error: `Challenge ${challengeId} not found in current puzzle list` });
        return;
      }

      const logLines: string[] = [];
      const L = (line: string) => logLines.push(line);
      L(`${submitToApi ? "Submit" : "Calculate"} (API): [${challenge.challengeId}] ${challenge.challengeName ?? ""}`);
      if (challenge.isFinished) {
        L("  Note: challenge is marked finished on API — solver still runs; API may reject.");
      }

      let resumeK: number | undefined = await checkpointStore.getResumeK(
        playerGuid,
        playerEmail,
        challenge.challengeId,
      );
      if (resumeK !== undefined) {
        L(`  K ladder resume from checkpoint: K=${resumeK}`);
      }

      const baseOpts = fastSim ? createPerChallengeClock(virtualSecondsPerAttempt)(challenge.challengeId) : {};
      const solved = solveGraph(challenge, planets, routes, {
        ...baseOpts,
        ...(skipAscent ? { skipAscent: true } : {}),
        resumeLadderFromK: resumeK ?? baseOpts.resumeLadderFromK ?? null,
      });

      if (!solved.success || solved.route === null) {
        L(`  Solver failed: ${solved.errorMessage ?? "Unknown error"}`);
        if (solved.stoppedByTimeBudgetWithoutSuccess) {
          await checkpointStore.save(playerGuid, playerEmail, challenge.challengeId, solved.effectiveKUsed);
          L(`  Stored K checkpoint ${solved.effectiveKUsed} (time budget, no success)`);
        }
        json(res, 200, {
          solverOk: false,
          challengeId: challenge.challengeId,
          challengeName: challenge.challengeName,
          solverResult: solved,
          calculate: null,
          submit: null,
          restError: null,
          logLines,
        });
        return;
      }

      await checkpointStore.clear(playerGuid, playerEmail, challenge.challengeId);
      L(`  Route found: effective=${solved.effectiveFuel}; K used=${solved.effectiveKUsed}`);

      const planetsById = new Map(planets.map((p) => [p.id, p] as const));
      const submission = buildSubmissionFromRoute(solved.route, planetsById);
      L(`  Submission: ${submission.map((p) => `${p.PlanetId}:${p.Name || "?"}`).join(" → ")}`);

      let calculate: SubmissionResult | null = null;
      let submitResult: SubmissionResult | null = null;
      let restError: string | null = null;

      try {
        calculate = await calculateCoaxium(challenge.challengeId, submission, clientOpts);
        L(
          `  CalculateCoaxium: isSuccess=${calculate.isSuccess}; coaxium=${calculate.coaxium}; ${calculate.feedbackMessage}`,
        );
        if (submitToApi) {
          submitResult = await submitChallengeSolution(challenge.challengeId, submission, clientOpts);
          L(
            `  SubmitChallengeSolution: isSuccess=${submitResult.isSuccess}; coaxium=${submitResult.coaxium}; ${submitResult.feedbackMessage}`,
          );
        } else {
          L("  Submit skipped (calculate-only).");
        }
      } catch (e) {
        restError = String((e as Error).message ?? e);
        L(`  REST error: ${restError}`);
      }

      json(res, 200, {
        solverOk: true,
        challengeId: challenge.challengeId,
        challengeName: challenge.challengeName,
        solverResult: solved,
        calculate,
        submit: submitToApi ? submitResult : null,
        skippedSubmit: !submitToApi,
        restError,
        logLines,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/github-dispatch-config") {
      json(res, 200, getGithubDispatchConfigPublic());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/github-repository-dispatch") {
      try {
        const result = await postRepositoryDispatch();
        json(res, 200, result);
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        const status = msg.includes("not set") ? 503 : 502;
        json(res, status, { error: msg });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run-cli") {
      const raw = await readBody(req);
      let body: { command?: string } = {};
      try {
        body = raw ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        json(res, 400, { error: "Invalid JSON" });
        return;
      }
      const cmd = body.command;
      if (cmd !== "solveDry" && cmd !== "solveSubmit" && cmd !== "solveDrySubmit") {
        json(res, 400, {
          error: 'Body.command must be "solveDry", "solveSubmit", or "solveDrySubmit".',
        });
        return;
      }
      try {
        const result = await runCliCommand(rootDir, cmd as CliCommandKind);
        json(res, 200, result);
      } catch (e) {
        json(res, 500, { error: String((e as Error).message ?? e) });
      }
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }

    const urlPath = url.pathname;
    if (await tryServeStatic(urlPath, res)) return;

    const indexPath = path.join(publicDir, "index.html");
    try {
      const html = await fs.readFile(indexPath);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length });
      res.end(html);
    } catch {
      res.writeHead(404).end("Not found");
    }
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String((e as Error).message ?? e) });
  }
});

server.listen(port, () => {
  console.log(`Star Delivery TS simulator UI  http://127.0.0.1:${port}`);
});
