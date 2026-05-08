# Star Delivery TSP — TypeScript simulator

This project **simulates** the .NET web host’s **batch runner**, **K ladder** (escalate `K` from `KLadderMinK` to `KLadderTopK` until first success, then bounded ascent; see `src/config.ts` / `workflow.ts`), and **checkpoint** behavior. The core **`Solver.cs` logic is ported to TypeScript** (`src/solver.ts`: Dijkstra, Yen K-shortest legs, mandatory/forbidden/bonus DFS). The **web server** loads map + daily challenges from the same **OutSystems REST** endpoints as `StarDeliveryClient` (`GetPlanetsAndRoutes`, `GetDailyChallenge`). Submit/coaxium calls are available in the submit CLI and API routes.

## What it is / isn’t

| Included | Not included |
|----------|----------------|
| Port of `Solver.cs` + min-priority queue | Bit-identical FLOAT parity vs C# (JS `number` vs `double`) |
| K ladder loop + time budget check | `CalculateCoaxium` / `SubmitChallengeSolution` |
| Resume-from-K checkpoints (JSON file) | EF Core / ASP.NET UI |
| Batch loop: skip finished when submit | EF-backed batch execution history (DotNet web only) |
| React + Vite dashboard (`client/` → built into `public/`) | ASP.NET Razor pages |

## Setup

```bash
cd StarDelivery-TSP-Simulator-TS
npm install
cd client && npm install && cd ..
npm run build          # compiles Node TS + Vite client into public/
```

### Web UI (React + Vite + Node API)

**Development (hot reload):** run API + Vite together (install root deps so `concurrently` is available):

```bash
npm run build:server   # once, or after changing src/server.ts / solver
npm run dev
```

- **Vite:** http://127.0.0.1:5173 — proxies `/api` → http://127.0.0.1:5175  
- **API:** same port as before (`PORT`, default **5175**)

**Production-style (single server):** build the client, then serve only Node:

```bash
npm run build
npm run web
```

Open **http://127.0.0.1:5175**. The UI is the compiled React bundle under `public/`; all solver logic stays in Node (`src/solver.ts`, `workflow.ts`, etc.). The server loads map + daily challenges from OutSystems using the enforced player headers. The **CLI runner** tab runs `solve:dry` (with **`--includeFinished`** so finished challenges are included), `solve:submit`, and `solve:dry:submit` equivalents via `POST /api/run-cli` (needs `dist/cli/` from `npm run build:server`).

Environment (optional):

| Variable | Purpose |
|----------|---------|
| `STAR_DELIVERY_BASE_URL` | REST base (defaults to the same URL as `Config.BaseUrl` in the .NET project). |
| `GITHUB_DISPATCH_TOKEN` | GitHub PAT for **CLI runner → Trigger scheduled-run** (`repository_dispatch`). Never commit; restart server after setting. |
| `GITHUB_DISPATCH_OWNER` | Optional repo owner (default `Nrap87`). |
| `GITHUB_DISPATCH_REPO` | Optional repo name (default `OSMay4th2026`). |
| `GITHUB_DISPATCH_EVENT_TYPE` | Optional `event_type` payload (default `scheduled-run`). |

**Player identity** for REST headers and checkpoint keys is **fixed** in `src/enforcedPlayer.ts` (same values as `StarDeliveryWebDefaults` in the .NET web host). The API ignores any client-supplied GUID/email.

**Single-challenge dry run:** `POST /api/solve-challenge-dry` with JSON `{ "challengeId": <number>, "fastSim"?: bool, "virtualSecondsPerAttempt"?: number, "skipAscent"?: bool }` runs `solveGraph` for that challenge only (no REST submit). When `skipAscent` is true, the solver stops after the first successful escalation (no post-success K climb). Checkpoints are updated on timeout like batch mode. Batch (`POST /api/run-batch`), dry stream, and `POST /api/challenge-submit` accept the same `skipAscent` field.

## Layout

- `src/config.ts` — K ladder bounds (`KLadderTopK` / `Floor` / `Step`, ascent stale-stop, optional `KLadderSkipAscent`) and `MaxRequestedK` for Yen.
- `src/workflow.ts` — `solveGraph()` aligned with `StarDeliveryChallengeWorkflow.SolveGraph`.
- `src/solver.ts` — port of `Solver.Solve` (+ `src/priorityQueue.ts`).
- `src/batchRunner.ts` — `runBatch()` mirrors `ChallengeBatchRunner` checkpoint hooks.
- `src/checkpointStore.ts` — JSON persistence analogous to `ChallengeKCheckpoints`.
- `src/server.ts` — HTTP server + JSON API; serves `public/` (Vite build output).
- `client/` — React (Vite) UI; `npm run build` inside copies bundle to `../public`.
- `src/enforcedPlayer.ts` — fixed `PlayerGuid` / `PlayerEmail` for API + checkpoints.
- `src/starDeliveryApi.ts` — Node `fetch` client for `GetPlanetsAndRoutes` / `GetDailyChallenge`.

## Customize

- Tune ladder speed vs quality in `src/config.ts` (`KLadderMinK`, `KLadderTopK`, `KLadderStep`, `KLadderAscentStopAfterStaleSuccesses`, `KLadderSkipAscent`). (`KLadderFloorK` is deprecated but kept as an alias of `KLadderMinK`.) For one-off fast runs, use CLI `--no-ascent` instead of editing config.
- Set `createSolveOptions` to use real wall clock only: `{ }` (defaults to `Date.now`), understanding full ladder may take up to **`KLadderTimeBudgetSeconds`** (~1000s default) per challenge.

## New constrained TSP core

A dedicated solver module now exists in `src/tspChallenge/` for challenge-oriented runs (start/end same planet, mandatory nodes, forbidden nodes, optional bonuses).

- `src/tspChallenge/solver.ts` — 4-layer approach (edge cost, Dijkstra, Yen KSP, constrained DFS).
- `src/tspChallenge/adaptiveK.ts` — adaptive K cap based on key-node count.
- `src/tspChallenge/types.ts` — typed input/output contracts for standalone use.
### Dry-run CLI (OutSystems-like terminal output)

```bash
npm run solve:dry
```

Useful flags (run after build with `npm run solve:dry:run -- ...`):

- `--challengeId=<id>`: solve one specific challenge.
- `--includeFinished`: include finished challenges in dry run filtering.
- `--progress`: print K-ladder progress (`phase`, `k`, `attempt`, elapsed ms). Ignored when `--parallel` is greater than `1` or when `--quiet` is set.
- `--quiet`: suppress normal stdout (headers, per-challenge lines, dry-run detail, submit detail, completion lines). Warnings and `[tsp-debug]` are also skipped when combined with `--quiet`. Errors still go to stderr (e.g. failed submit stop). Implies no `--progress`. Always prints one final line: `Total elapsed: <ms>ms (<scope>)` covering fetch and solve, plus submit when `--submit` is used.
- `--parallel=<n>`: solve challenges concurrently with `n` worker threads (default `1`). Routes are computed once per challenge; results are not re-solved for submit.
- `--submit`: call `CalculateCoaxium` then `SubmitChallengeSolution` for each successful route **in ascending `challengeId` order**. Submits are **pipelined** with parallel solves: as soon as the lowest pending id’s solve finishes, its REST submit runs while other challenges may still be solving; the next id submits only after the previous id’s HTTP chain completes. If a submit fails or returns `isSuccess=false`, later ids are skipped for submit.
- `--warnAfterMs=<ms>`: warn when a challenge solve exceeds this duration (default `10000`).
- `--no-ascent`: after the first successful escalation, skip the ascent phase (no further solves at higher K). Faster; may yield worse effective fuel than the full ladder. Optional npm config: `npm_config_no_ascent=true`.

Example:

```bash
npm run solve:dry -- --parallel=3 --submit
```

Preset `npm run solve:dry:submit` runs `build:server` then `solve:dry` with `--parallel=3 --submit --warnAfterMs=15000 --includeFinished` (edit `package.json` to change defaults). **`--quiet` is not part of the preset**; add it when you want minimal output and the final `Total elapsed` line: `npm run solve:dry:submit -- --quiet` (or set `npm_config_quiet=true` for that npm invocation).

### Submit CLI (same look/feel, with live submit)

```bash
npm run solve:submit -- --challengeId=80 --progress --warnAfterMs=15000
```

Useful flags:

- `--challengeId=<id>`: submit one specific challenge (recommended).
- `--all`: submit all pending challenges (safety guard requires either `--challengeId` or `--all`).
- `--includeFinished`: include finished challenges in filtering.
- `--progress`: print K-ladder progress (`phase`, `k`, `attempt`, elapsed ms). Disabled when `--quiet` is set.
- `--quiet`: suppress normal stdout (same idea as dry run); errors still on stderr. Prints one final `Total elapsed: …` line for the full run (fetch + solve + submit).
- `--warnAfterMs=<ms>`: warn when a challenge solve exceeds this duration (default `10000`). Warnings are skipped when `--quiet` is set.
- `--no-ascent`: same as dry-run (skip post-success K climb for speed).

Notes:

- Submit CLI uses live API calls (`CalculateCoaxium` + `SubmitChallengeSolution`).
- Challenge selection for submit uses the same OutSystems flow as dry run: `GetDailyChallenge` via `fetchStarDeliveryGameState`.

## Compliance

Use only in line with Star Delivery / employer API and automation policies. The web host ships a **fixed** player identity in `enforcedPlayer.ts`; change that file if you need a different account.
