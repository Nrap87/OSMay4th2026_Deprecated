/**
 * worker_threads entry: solves one challenge in isolation (CPU parallelism for solve:dry --parallel).
 */
import { parentPort, workerData } from "node:worker_threads";
import type { ChallengeOut, PlanetOut, RouteOut, SolverResult } from "../types.js";
import { solveGraph, type SolveGraphOptions } from "../workflow.js";

export type SolveDryWorkerInput = {
  planets: PlanetOut[];
  routes: RouteOut[];
  challenge: ChallengeOut;
  /** Passed through to `solveGraph` (e.g. `{ skipAscent: true }`). */
  solveGraphOptions?: SolveGraphOptions;
};

export type SolveDryWorkerOutput = {
  result: SolverResult;
  elapsedMs: number;
};

const data = workerData as SolveDryWorkerInput | undefined;
if (!data?.challenge || !Array.isArray(data.planets) || !Array.isArray(data.routes)) {
  throw new Error("solveDryWorker: invalid workerData");
}
if (!parentPort) {
  throw new Error("solveDryWorker: missing parentPort");
}

const started = Date.now();
const result = solveGraph(data.challenge, data.planets, data.routes, data.solveGraphOptions ?? {});
const elapsedMs = Date.now() - started;

const out: SolveDryWorkerOutput = { result, elapsedMs };
parentPort.postMessage(out);
