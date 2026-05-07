import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson, simStateUrl } from "./api";
import { ENFORCED_PLAYER_EMAIL, ENFORCED_PLAYER_GUID, FIXTURE_PREF_KEY } from "./constants";
import "./index.css";

type View = "dash" | "cp" | "batches" | "cli";

interface PlanetRow {
  id: number;
  name: string;
}

interface RouteRow {
  fromPlanet: number;
  toPlanetId: number;
  routeType?: string;
}

interface ChallengeOut {
  challengeId: number;
  challengeName?: string;
  startPlanetId: string;
  mandatoryPlanets?: unknown[];
  forbiddenPlanets?: unknown[];
  bonusPlanets?: unknown[];
  isFinished?: boolean;
  level?: string;
}

interface PlanetRefRow {
  planetId: number;
  name: string;
}

interface SimState {
  source?: string;
  error?: string;
  planets?: PlanetRow[];
  routes?: RouteRow[];
  planetCount: number;
  routeCount: number;
  challengeCount: number;
  challenges?: ChallengeOut[];
}

interface CheckpointRow {
  playerGuid: string;
  playerEmail: string;
  challengeId: number;
  resumeFromK: number;
  updatedAtUtc: string;
}

interface StoredBatchRun {
  id: number;
  startedAtUtc: string;
  submit: boolean;
  playerGuid: string;
  playerEmail: string;
  report: BatchRunReport;
  logLines: string[];
}

interface BatchRunReport {
  summary?: BatchRunSummary;
  rows?: BatchChallengeResultRow[];
}

interface BatchRunSummary {
  challengeCount: number;
  skippedFinished: number;
  solverSuccess: number;
  solverFailure: number;
}

interface BatchChallengeResultRow {
  challengeId: number;
  challengeName: string;
  status: string;
  detail: string;
  totalDurationMs: number | null;
}

interface DryRunResponse {
  challengeId: number;
  challengeName?: string;
  dryRun?: boolean;
  solverResult: Record<string, unknown>;
  logLines: string[];
}

interface ApiSubmissionResult {
  isSuccess: boolean;
  feedbackMessage: string;
  coaxium: number;
  timeElapsedInSeconds?: number;
  timeElapsed?: number;
}

interface ManualSubmitResponse {
  solverOk: boolean;
  challengeId: number;
  challengeName?: string;
  solverResult: Record<string, unknown>;
  calculate: ApiSubmissionResult | null;
  submit: ApiSubmissionResult | null;
  skippedSubmit?: boolean;
  restError: string | null;
  logLines: string[];
}

type DryRunPhase = "escalate" | "ascent";

interface DryRunProgress {
  k: number | null;
  phase: DryRunPhase | null;
  elapsedMs: number;
}

interface RunBatchResponse {
  batchId: number;
  report: BatchRunReport;
  logLines: string[];
}

type CliRunKind = "solveDry" | "solveSubmit" | "solveDrySubmit";

interface RunCliResponse {
  command: CliRunKind;
  label: string;
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

interface GithubDispatchConfigResponse {
  configured: boolean;
  owner: string;
  repo: string;
  eventType: string;
}

interface GithubDispatchTriggerResponse {
  status: number;
  message: string;
}

function loadFixturePref(): boolean {
  try {
    return localStorage.getItem(FIXTURE_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function saveFixturePref(on: boolean): void {
  try {
    localStorage.setItem(FIXTURE_PREF_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function statusTagCls(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("skipped")) return "tag tag--warn";
  if (s.includes("fail")) return "tag tag--danger";
  if (s.includes("solved")) return "tag tag--success";
  return "tag";
}

function formatPlanetLabel(name: string, id: number): string {
  const label = name.trim() || "—";
  return `${label} (${id})`;
}

function formatRouteEndpoint(name: string, id: number): string {
  const label = name.trim() || "—";
  return `${label} - ${id}`;
}

function asPlanetRefs(arr: unknown): PlanetRefRow[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => {
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const id = Number(o.planetId ?? o.PlanetId ?? o.id ?? 0);
    const name =
      typeof o.name === "string" ? o.name : typeof o.Name === "string" ? o.Name : "";
    return { planetId: Number.isFinite(id) ? id : 0, name };
  });
}

function formatStartPlanet(startPlanetId: string, byId: Map<number, { name: string }>): string {
  const raw = String(startPlanetId).trim();
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const row = byId.get(n);
  return formatPlanetLabel(row?.name ?? "", n);
}

function PlanetRefBlock({ title, refs }: { title: string; refs: PlanetRefRow[] }) {
  return (
    <div className="card-planet-block">
      <div className="card-planet-block__title">{title}</div>
      {refs.length === 0 ? (
        <div className="card-planet-block__empty muted">None</div>
      ) : (
        <ul className="planet-line-list">
          {refs.map((p, i) => (
            <li key={`${title}-${p.planetId}-${i}`}>{formatPlanetLabel(p.name, p.planetId)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("dash");
  const [useFixture, setUseFixture] = useState(loadFixturePref);
  const [submit, setSubmit] = useState(false);
  const [fastSim, setFastSim] = useState(true);
  const [virtualSecondsPerAttempt, setVirtualSecondsPerAttempt] = useState(95);

  const [simState, setSimState] = useState<SimState | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointRow[]>([]);
  const [batches, setBatches] = useState<StoredBatchRun[]>([]);

  const [alertMessage, setAlertMessage] = useState("");
  const [alertIsError, setAlertIsError] = useState(false);

  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("Working…");

  const [latestBatch, setLatestBatch] = useState<RunBatchResponse | null>(null);
  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null);
  const [dryRunProgress, setDryRunProgress] = useState<DryRunProgress | null>(null);
  const [dryRunWallMs, setDryRunWallMs] = useState<number | null>(null);
  const [manualSubmit, setManualSubmit] = useState<ManualSubmitResponse | null>(null);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [batchDetail, setBatchDetail] = useState<StoredBatchRun | null>(null);

  const [cliRunning, setCliRunning] = useState<CliRunKind | null>(null);
  const [cliResult, setCliResult] = useState<RunCliResponse | null>(null);
  const [cliError, setCliError] = useState<string | null>(null);

  const [githubDispatchConfig, setGithubDispatchConfig] = useState<GithubDispatchConfigResponse | null>(null);
  const [githubDispatchBusy, setGithubDispatchBusy] = useState(false);
  const [githubDispatchNote, setGithubDispatchNote] = useState<string | null>(null);

  const batchDetailRef = useRef<HTMLElement | null>(null);

  const showAlert = useCallback((msg: string, isError: boolean) => {
    setAlertMessage(msg);
    setAlertIsError(isError);
  }, []);

  useEffect(() => {
    if (!alertMessage || alertIsError) return;
    const t = window.setTimeout(() => setAlertMessage(""), 3500);
    return () => window.clearTimeout(t);
  }, [alertMessage, alertIsError]);

  const loadSimState = useCallback(async () => {
    const data = await fetchJson<SimState>(simStateUrl(useFixture));
    setSimState(data);
  }, [useFixture]);

  const loadCheckpoints = useCallback(async () => {
    const data = await fetchJson<{ rows: CheckpointRow[] }>("/api/checkpoints");
    setCheckpoints(data.rows ?? []);
  }, []);

  const loadBatchesList = useCallback(async () => {
    const data = await fetchJson<{ items: StoredBatchRun[] }>("/api/batches");
    setBatches(data.items ?? []);
  }, []);

  useEffect(() => {
    loadSimState().catch((e: unknown) => showAlert(e instanceof Error ? e.message : String(e), true));
  }, [loadSimState, showAlert]);

  const goNav = (next: View) => {
    setView(next);
    if (next === "cp") {
      loadCheckpoints().catch((e: unknown) => showAlert(e instanceof Error ? e.message : String(e), true));
    }
    if (next === "batches") {
      loadBatchesList().catch((e: unknown) => showAlert(e instanceof Error ? e.message : String(e), true));
    }
  };

  useEffect(() => {
    if (view !== "cli") return;
    setGithubDispatchNote(null);
    fetchJson<GithubDispatchConfigResponse>("/api/github-dispatch-config")
      .then(setGithubDispatchConfig)
      .catch(() => {
        setGithubDispatchConfig(null);
      });
  }, [view]);

  const runCli = useCallback(async (command: CliRunKind) => {
    setCliRunning(command);
    setCliError(null);
    setCliResult(null);
    const labels: Record<CliRunKind, string> = {
      solveDry: "solve:dry",
      solveSubmit: "solve:submit",
      solveDrySubmit: "solve:dry:submit",
    };
    try {
      const data = await fetchJson<RunCliResponse>("/api/run-cli", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      setCliResult(data);
      if (data.exitCode !== 0) {
        showAlert(`${labels[command]} exited with code ${data.exitCode ?? "—"}`, true);
      } else {
        showAlert(`${labels[command]} finished in ${data.durationMs}ms`, false);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCliError(msg);
      showAlert(msg, true);
    } finally {
      setCliRunning(null);
    }
  }, [showAlert]);

  const triggerGithubRepositoryDispatch = useCallback(async () => {
    setGithubDispatchBusy(true);
    setGithubDispatchNote(null);
    try {
      const data = await fetchJson<GithubDispatchTriggerResponse>("/api/github-repository-dispatch", {
        method: "POST",
      });
      const line = `GitHub responded HTTP ${data.status}. ${data.message}`;
      setGithubDispatchNote(line);
      showAlert("Repository dispatch sent.", false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setGithubDispatchNote(msg);
      showAlert(msg, true);
    } finally {
      setGithubDispatchBusy(false);
    }
  }, [showAlert]);

  const onFixtureChange = (checked: boolean) => {
    setUseFixture(checked);
    saveFixturePref(checked);
    loadSimState().catch((e: unknown) => showAlert(e instanceof Error ? e.message : String(e), true));
  };

  const dryRunChallenge = async (challengeId: number) => {
    setDryRunWallMs(null);
    setDryRunProgress({ k: null, phase: null, elapsedMs: 0 });
    showAlert("", false);
    const started = performance.now();
    const tick = window.setInterval(() => {
      setDryRunProgress((p) =>
        p ? { ...p, elapsedMs: Math.round(performance.now() - started) } : p,
      );
    }, 100);
    try {
      const res = await fetch("/api/solve-challenge-dry-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({
          challengeId,
          fastSim,
          virtualSecondsPerAttempt,
          useFixture,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = res.statusText;
        try {
          const j = JSON.parse(text) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          if (text) msg = text.slice(0, 200);
        }
        throw new Error(msg);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as
            | { type: "progress"; k: number; phase: DryRunPhase }
            | { type: "complete"; challengeId: number; challengeName?: string; dryRun?: boolean; solverResult: Record<string, unknown>; logLines: string[] }
            | { type: "error"; error: string };
          if (msg.type === "progress") {
            setDryRunProgress({
              k: msg.k,
              phase: msg.phase,
              elapsedMs: Math.round(performance.now() - started),
            });
          } else if (msg.type === "complete") {
            setDryRun({
              challengeId: msg.challengeId,
              challengeName: msg.challengeName,
              dryRun: msg.dryRun,
              solverResult: msg.solverResult,
              logLines: msg.logLines,
            });
          } else if (msg.type === "error") {
            throw new Error(msg.error);
          }
        }
      }
      setDryRunWallMs(Math.round(performance.now() - started));
      await loadCheckpoints();
    } catch (e: unknown) {
      showAlert(e instanceof Error ? e.message : String(e), true);
    } finally {
      window.clearInterval(tick);
      setDryRunProgress(null);
    }
  };

  const cardBusy = dryRunProgress !== null || submitLoading || loading;

  const submitManualChallenge = async (challengeId: number, doSubmit: boolean) => {
    if (useFixture) {
      showAlert("Turn off the local fixture to call OutSystems Calculate/Submit.", true);
      return;
    }
    if (doSubmit) {
      const ok = window.confirm(
        "Submit this solved route to OutSystems as your solution? This uses SubmitChallengeSolution after CalculateCoaxium.",
      );
      if (!ok) return;
    }
    setManualSubmit(null);
    setSubmitLoading(true);
    showAlert("", false);
    try {
      const data = await fetchJson<ManualSubmitResponse>("/api/challenge-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId,
          submit: doSubmit,
          fastSim,
          virtualSecondsPerAttempt,
          useFixture,
        }),
      });
      setManualSubmit(data);
      if (data.restError) {
        showAlert(data.restError, true);
      } else if (!data.solverOk) {
        showAlert(`Solver did not produce a route for challenge ${data.challengeId}.`, true);
      } else if (data.calculate && !data.calculate.isSuccess) {
        showAlert(`CalculateCoaxium: ${data.calculate.feedbackMessage || "not successful"}`, true);
      } else if (doSubmit && data.submit && !data.submit.isSuccess) {
        showAlert(`SubmitChallengeSolution: ${data.submit.feedbackMessage || "not successful"}`, true);
      } else {
        showAlert(doSubmit ? "Calculate and submit completed." : "Calculate completed.", false);
      }
      await loadSimState();
      await loadCheckpoints();
    } catch (e: unknown) {
      showAlert(e instanceof Error ? e.message : String(e), true);
    } finally {
      setSubmitLoading(false);
    }
  };

  const runBatch = async () => {
    setLoadingMessage("Running batch…");
    setLoading(true);
    showAlert("", false);
    try {
      const data = await fetchJson<RunBatchResponse>("/api/run-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submit,
          fastSim,
          virtualSecondsPerAttempt,
          useFixture,
        }),
      });
      setLatestBatch(data);
      await loadSimState();
      await loadCheckpoints();
      await loadBatchesList();
    } catch (e: unknown) {
      showAlert(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  };

  const openBatchDetail = async (id: number) => {
    try {
      const data = await fetchJson<StoredBatchRun>(`/api/batches/${encodeURIComponent(String(id))}`);
      setBatchDetail(data);
      queueMicrotask(() => batchDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    } catch (e: unknown) {
      showAlert(e instanceof Error ? e.message : String(e), true);
    }
  };

  const dataSourceLabel =
    simState?.source === "fixture"
      ? "Local fixture (sampleData)"
      : simState?.source === "api"
        ? "OutSystems REST (GetPlanetsAndRoutes + GetDailyChallenge)"
        : "—";

  const challengeHint =
    simState?.source === "fixture"
      ? "Fixture mode: challenges from sampleData.ts."
      : "Live data from OutSystems for the enforced player above.";

  const challenges = simState?.challenges ?? [];
  const planets = simState?.planets;
  const routes = simState?.routes;
  const planetsById = useMemo(
    () => new Map((planets ?? []).map((p) => [p.id, p] as const)),
    [planets],
  );
  const sortedPlanetRows = useMemo(() => [...(planets ?? [])].sort((a, b) => a.id - b.id), [planets]);
  const sortedRouteRows = useMemo(
    () =>
      [...(routes ?? [])].sort((a, b) => a.fromPlanet - b.fromPlanet || a.toPlanetId - b.toPlanetId),
    [routes],
  );

  return (
    <div className="app-shell">
      <main className="container">
        <nav className="nav-bar" aria-label="Main">
          <span className="nav-brand">
            Star Delivery · TSP <span className="nav-badge">Simulator</span>
          </span>
          <div className="nav-links">
            <button
              type="button"
              className="nav-link"
              aria-current={view === "dash" ? "page" : undefined}
              onClick={() => goNav("dash")}
            >
              Dashboard
            </button>
            <button
              type="button"
              className="nav-link"
              aria-current={view === "cp" ? "page" : undefined}
              onClick={() => goNav("cp")}
            >
              K checkpoints
            </button>
            <button
              type="button"
              className="nav-link"
              aria-current={view === "batches" ? "page" : undefined}
              onClick={() => goNav("batches")}
            >
              Batch runs
            </button>
            <button
              type="button"
              className="nav-link"
              aria-current={view === "cli" ? "page" : undefined}
              onClick={() => goNav("cli")}
            >
              CLI runner
            </button>
          </div>
        </nav>

        <section id="view-dash" className={view === "dash" ? "view-panel" : "view-panel hidden"}>
          <header className="page-header">
            <h1>Daily challenge solver</h1>
            <p className="sub-hint">
              React + Vite UI; solver stays in Node TypeScript. Map and challenges load from OutSystems when fixture is off (
              <code>GetPlanetsAndRoutes</code>, <code>GetDailyChallenge</code>). Enable <strong>local fixture</strong> for offline.
            </p>
          </header>

          {alertMessage ? (
            <div className={`alert ${alertIsError ? "" : "alert--info"}`} role="alert">
              {alertMessage}
            </div>
          ) : null}

          <section className="panel">
            <h2>Session</h2>
            <div className="session-form">
              <label>
                Player GUID <span className="hint-inline">(fixed)</span>
                <input type="text" readOnly aria-readonly value={ENFORCED_PLAYER_GUID} />
              </label>
              <label>
                Player email <span className="hint-inline">(fixed)</span>
                <input type="email" readOnly aria-readonly value={ENFORCED_PLAYER_EMAIL} />
              </label>
            </div>
            <label className="inline-check fixture-row">
              <input type="checkbox" checked={useFixture} onChange={(e) => onFixtureChange(e.target.checked)} />
              Use local fixture only (skip OutSystems REST)
            </label>
            <p className="hint">
              Credentials are enforced on the server for REST headers and <code>.data/</code> checkpoints.
            </p>
            <div className="grid-two mt muted">
              <div>
                <strong className="muted">Data source</strong>
                <div>{dataSourceLabel}</div>
              </div>
              <div>
                <strong className="muted">Planets</strong>
                <div>{simState?.planetCount ?? "—"}</div>
              </div>
              <div>
                <strong className="muted">Routes</strong>
                <div>{simState?.routeCount ?? "—"}</div>
              </div>
              <div>
                <strong className="muted">Challenges</strong>
                <div>{simState?.challengeCount ?? "—"}</div>
              </div>
            </div>
            <details className="map-expand mt">
              <summary className="map-expand__summary">Show all planets and routes</summary>
              <div className="map-expand__body">
                <h3 className="map-expand__h">Planets ({sortedPlanetRows.length})</h3>
                {sortedPlanetRows.length === 0 ? (
                  <p className="hint muted">No planet rows in session payload (reload or check API).</p>
                ) : (
                  <ul className="planet-line-list planet-line-list--dense">
                    {sortedPlanetRows.map((p) => (
                      <li key={p.id}>{formatPlanetLabel(p.name, p.id)}</li>
                    ))}
                  </ul>
                )}
                <h3 className="map-expand__h">Routes ({sortedRouteRows.length})</h3>
                {sortedRouteRows.length === 0 ? (
                  <p className="hint muted">No route rows in session payload.</p>
                ) : (
                  <ul className="route-line-list">
                    {sortedRouteRows.map((r, i) => {
                      const fromName = planetsById.get(r.fromPlanet)?.name ?? "";
                      const toName = planetsById.get(r.toPlanetId)?.name ?? "";
                      const line = `(${formatRouteEndpoint(fromName, r.fromPlanet)}, ${formatRouteEndpoint(toName, r.toPlanetId)})`;
                      return (
                        <li key={`${r.fromPlanet}-${r.toPlanetId}-${i}`}>{line}</li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </details>
          </section>

          <section className="panel">
            <h2>Daily challenges</h2>
            <p className="hint">
              {challengeHint} <strong>Dry run</strong> solves locally only. With live data, use <strong>Calculate</strong> or{" "}
              <strong>Submit</strong> to call OutSystems (same options as batch below).
            </p>
            <div className="cards">
              {challenges.map((c) => {
                const name = c.challengeName || String(c.challengeId);
                const mandRefs = asPlanetRefs(c.mandatoryPlanets);
                const forbRefs = asPlanetRefs(c.forbiddenPlanets);
                const bonusRefs = asPlanetRefs(c.bonusPlanets);
                return (
                  <article key={c.challengeId} className="card">
                    <h3 className="card-title">{name}</h3>
                    <div className="card-meta">
                      <div>
                        <strong>Challenge ID</strong> {c.challengeId} · <strong>start</strong>{" "}
                        {formatStartPlanet(c.startPlanetId, planetsById)}
                      </div>
                      {c.level ? (
                        <div>
                          <strong>Level</strong> {c.level}
                        </div>
                      ) : null}
                      <div>
                        <strong>Finished</strong> {c.isFinished ? "yes" : "no"}
                      </div>
                    </div>
                    <div className="card-planet-groups">
                      <PlanetRefBlock title="Mandatory planets" refs={mandRefs} />
                      <PlanetRefBlock title="Forbidden planets" refs={forbRefs} />
                      <PlanetRefBlock title="Bonus planets" refs={bonusRefs} />
                    </div>
                    <div className="card-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={cardBusy}
                        onClick={() => dryRunChallenge(c.challengeId)}
                      >
                        Dry run
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={cardBusy || useFixture}
                        title={useFixture ? "Requires live OutSystems data" : undefined}
                        onClick={() => submitManualChallenge(c.challengeId, false)}
                      >
                        Calculate
                      </button>
                      <button
                        type="button"
                        disabled={cardBusy || useFixture}
                        title={useFixture ? "Requires live OutSystems data" : undefined}
                        onClick={() => submitManualChallenge(c.challengeId, true)}
                      >
                        Submit
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          {dryRunProgress ? (
            <section className="panel dry-run-live" aria-live="polite">
              <h2>Dry run in progress</h2>
              <div className="dry-run-live__metrics">
                <div className="dry-run-live__metric">
                  <span className="dry-run-live__label">Elapsed</span>
                  <span className="dry-run-live__value">{(dryRunProgress.elapsedMs / 1000).toFixed(2)}s</span>
                </div>
                <div className="dry-run-live__metric">
                  <span className="dry-run-live__label">K (this attempt)</span>
                  <span className="dry-run-live__value">
                    {dryRunProgress.k != null ? dryRunProgress.k : "…"}
                  </span>
                </div>
                <div className="dry-run-live__metric">
                  <span className="dry-run-live__label">Phase</span>
                  <span className="dry-run-live__value">
                    {dryRunProgress.phase === "escalate"
                      ? "Escalate"
                      : dryRunProgress.phase === "ascent"
                        ? "Ascent"
                        : "Starting…"}
                  </span>
                </div>
              </div>
              <p className="hint muted">K ladder updates as each inner solve starts. No modal — you can watch progress here.</p>
            </section>
          ) : null}

          {dryRun ? (
            <section className="panel">
              <h2>Single-challenge dry run</h2>
              <p className="hint muted">
                [{dryRun.challengeId}] {dryRun.challengeName ?? ""} ·{" "}
                {dryRun.solverResult.success === true ? "solved (dry run)" : "no route / failed"}
                {dryRunWallMs != null ? ` · UI wall time ${(dryRunWallMs / 1000).toFixed(2)}s` : ""}
                {typeof dryRun.solverResult.durationSeconds === "number"
                  ? ` · solver ladder time ${Number(dryRun.solverResult.durationSeconds).toFixed(2)}s (virtual if fast sim)`
                  : ""}
                {" "}
                · final K returned: {String(dryRun.solverResult.effectiveKUsed ?? "—")} · fastSim uses batch options below
              </p>
              <details open className="batch-log-details">
                <summary>Solver result (JSON)</summary>
                <pre className="batch-log-pre">{JSON.stringify(dryRun.solverResult, null, 2)}</pre>
              </details>
              <details className="batch-log-details">
                <summary>Log</summary>
                <pre className="batch-log-pre">{(dryRun.logLines ?? []).join("\n")}</pre>
              </details>
            </section>
          ) : null}

          {manualSubmit ? (
            <section className="panel">
              <h2>Single-challenge API</h2>
              <p className="hint muted">
                [{manualSubmit.challengeId}] {manualSubmit.challengeName ?? ""} · solver{" "}
                {manualSubmit.solverOk ? "found route" : "no route / failed"}
                {manualSubmit.skippedSubmit ? " · calculate only" : " · calculate + submit"}
                {manualSubmit.restError ? ` · REST error: ${manualSubmit.restError}` : ""}
              </p>
              <details open className="batch-log-details">
                <summary>Calculate / submit (JSON)</summary>
                <pre className="batch-log-pre">
                  {JSON.stringify(
                    {
                      calculate: manualSubmit.calculate,
                      submit: manualSubmit.submit,
                      skippedSubmit: manualSubmit.skippedSubmit,
                      restError: manualSubmit.restError,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <details open className="batch-log-details">
                <summary>Solver result (JSON)</summary>
                <pre className="batch-log-pre">{JSON.stringify(manualSubmit.solverResult, null, 2)}</pre>
              </details>
              <details className="batch-log-details">
                <summary>Log</summary>
                <pre className="batch-log-pre">{(manualSubmit.logLines ?? []).join("\n")}</pre>
              </details>
            </section>
          ) : null}

          <section className="panel">
            <h2>Batch run (all challenges)</h2>
            <p className="hint">Ported solver + K ladder + checkpoint persistence. Per-card Calculate/Submit uses real REST.</p>
            <div className="batch-options">
              <label className="inline-check">
                <input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} />
                Use submit mode (batch only — REST not wired for batch in TS)
              </label>
              <label className="inline-check">
                <input type="checkbox" checked={fastSim} onChange={(e) => setFastSim(e.target.checked)} />
                Fast virtual clock (for checkpoint demos)
              </label>
              <label>
                Virtual seconds per K attempt
                <input
                  type="number"
                  min={1}
                  max={600}
                  step={1}
                  value={virtualSecondsPerAttempt}
                  onChange={(e) => setVirtualSecondsPerAttempt(Number(e.target.value) || 95)}
                />
              </label>
            </div>
            <div className="actions mt">
              <button type="button" onClick={() => runBatch()}>
                Run batch
              </button>
            </div>
          </section>

          {latestBatch ? (
            <section className="panel batch-report-panel">
              <h2>Latest batch run</h2>
              <p className="hint muted">
                batchId {latestBatch.batchId}
                {latestBatch.report.summary
                  ? ` · Challenges ${latestBatch.report.summary.challengeCount} · skipped ${latestBatch.report.summary.skippedFinished} · solver OK ${latestBatch.report.summary.solverSuccess} · solver fail ${latestBatch.report.summary.solverFailure}`
                  : ""}
              </p>
              {latestBatch.report.rows?.length ? (
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Challenge</th>
                        <th>Name</th>
                        <th>Status</th>
                        <th>Duration (ms)</th>
                        <th>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {latestBatch.report.rows.map((r, i) => (
                        <tr key={`${r.challengeId}-${i}-${r.status}`}>
                          <td>{r.challengeId}</td>
                          <td>{r.challengeName}</td>
                          <td>
                            <span className={statusTagCls(r.status)}>{r.status}</span>
                          </td>
                          <td>{r.totalDurationMs != null ? r.totalDurationMs : "—"}</td>
                          <td>{r.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">No rows in report.</p>
              )}
              <details className="batch-log-details">
                <summary>Full batch log (text)</summary>
                <pre className="batch-log-pre">{(latestBatch.logLines ?? []).join("\n")}</pre>
              </details>
            </section>
          ) : null}
        </section>

        <section id="view-cli" className={view === "cli" ? "view-panel" : "view-panel hidden"}>
          <header className="page-header">
            <h1>CLI runner</h1>
            <p className="sub-hint">
              Runs the same packaged scripts as <code>npm run solve:dry</code>, <code>solve:submit</code>, and{" "}
              <code>solve:dry:submit</code> on the Node server. Requires <code>npm run build:server</code> so{" "}
              <code>dist/cli/</code> exists. Submit flows call live OutSystems APIs for the enforced player.
            </p>
          </header>

          {cliRunning ? (
            <div className="cli-running-banner" role="status">
              <div className="loading-spinner cli-running-spinner" aria-hidden />
              <span>
                Running <strong>{cliRunning === "solveDry" ? "solve:dry" : cliRunning === "solveSubmit" ? "solve:submit" : "solve:dry:submit"}</strong>…
              </span>
            </div>
          ) : null}

          <div className="cli-hub">
            <article className="cli-card">
              <div className="cli-card__icon" aria-hidden>
                ◈
              </div>
              <h3>solve:dry</h3>
              <p>Dry-run challenges including finished ones (<code>--includeFinished</code>) — solve only, no REST submit.</p>
              <div className="actions">
                <button type="button" disabled={cliRunning !== null || githubDispatchBusy} onClick={() => runCli("solveDry")}>
                  Run solve:dry
                </button>
              </div>
            </article>
            <article className="cli-card cli-card--accent">
              <div className="cli-card__icon" aria-hidden>
                ↗
              </div>
              <h3>solve:submit</h3>
              <p>
                Solve and submit every matching challenge via{" "}
                <code>--all --includeFinished --warnAfterMs=15000</code> (CLI requires <code>--all</code> or a challenge id).
              </p>
              <div className="actions">
                <button type="button" disabled={cliRunning !== null || githubDispatchBusy} onClick={() => runCli("solveSubmit")}>
                  Run solve:submit
                </button>
              </div>
            </article>
            <article className="cli-card cli-card--bold">
              <div className="cli-card__icon" aria-hidden>
                ⚡
              </div>
              <h3>solve:dry:submit</h3>
              <p>
                Parallel dry solve (<code>--parallel=3</code>) with pipelined submit — same flags as the npm script preset.
              </p>
              <div className="actions">
                <button type="button" disabled={cliRunning !== null || githubDispatchBusy} onClick={() => runCli("solveDrySubmit")}>
                  Run solve:dry:submit
                </button>
              </div>
            </article>
          </div>

          <section className="panel cli-github-panel">
            <div className="cli-github-panel__row">
              <div className="cli-github-panel__copy">
                <h2 className="cli-github-panel__title">GitHub workflow dispatch</h2>
                <p className="hint muted">
                  POST <code>repository_dispatch</code> to{" "}
                  <code>
                    {githubDispatchConfig
                      ? `${githubDispatchConfig.owner}/${githubDispatchConfig.repo}`
                      : "owner/repo"}
                  </code>{" "}
                  with <code>event_type</code>{" "}
                  <code>{githubDispatchConfig?.eventType ?? "scheduled-run"}</code>. The PAT stays on the server (
                  <code>GITHUB_DISPATCH_TOKEN</code>).
                </p>
                {githubDispatchConfig === null ? (
                  <p className="muted">Could not load dispatch config from API.</p>
                ) : null}
                {githubDispatchConfig && !githubDispatchConfig.configured ? (
                  <p className="cli-output-error">
                    Set <code>GITHUB_DISPATCH_TOKEN</code> in the server environment and restart <code>npm run web</code>{" "}
                    / <code>npm run dev</code>.
                  </p>
                ) : null}
              </div>
              <div className="cli-github-panel__actions">
                <button
                  type="button"
                  disabled={
                    cliRunning !== null ||
                    githubDispatchBusy ||
                    githubDispatchConfig === null ||
                    !githubDispatchConfig.configured
                  }
                  onClick={() => triggerGithubRepositoryDispatch()}
                >
                  {githubDispatchBusy ? "Sending…" : "Trigger scheduled-run"}
                </button>
              </div>
            </div>
            {githubDispatchNote ? (
              <pre className="cli-output-pre cli-github-note">{githubDispatchNote}</pre>
            ) : null}
          </section>

          <section className="panel cli-output-panel">
            <h2>Output</h2>
            {cliError && !cliResult ? <p className="cli-output-error">{cliError}</p> : null}
            {cliResult ? (
              <>
                <div className="cli-output-meta">
                  <span className={cliResult.exitCode === 0 ? "tag tag--success" : "tag tag--danger"}>
                    exit {cliResult.exitCode ?? "—"}
                  </span>
                  <span className="muted"> · {cliResult.durationMs}ms · </span>
                  <span className="muted">{cliResult.label}</span>
                  {cliResult.truncated ? (
                    <span className="cli-output-trunc"> · output truncated at server cap</span>
                  ) : null}
                </div>
                <details open className="batch-log-details">
                  <summary>stdout</summary>
                  <pre className="cli-output-pre">{cliResult.stdout || "(empty)"}</pre>
                </details>
                {cliResult.stderr ? (
                  <details open className="batch-log-details">
                    <summary>stderr</summary>
                    <pre className="cli-output-pre cli-output-pre--err">{cliResult.stderr}</pre>
                  </details>
                ) : null}
                <details className="batch-log-details">
                  <summary>argv</summary>
                  <pre className="cli-output-pre">{cliResult.argv.join(" ")}</pre>
                </details>
              </>
            ) : (
              <p className="muted">Run a command above to stream captured stdout/stderr here.</p>
            )}
          </section>
        </section>

        <section id="view-cp" className={view === "cp" ? "view-panel" : "view-panel hidden"}>
          <header className="page-header">
            <h1>K ladder checkpoints</h1>
            <p className="muted">Rows from <code>.data/checkpoints.json</code></p>
          </header>
          <section className="panel">
            <div className="actions mb">
              <button type="button" className="secondary" onClick={() => loadCheckpoints()}>
                Refresh
              </button>
            </div>
            {checkpoints.length === 0 ? (
              <p className="muted">No checkpoints yet — run a batch or dry run first.</p>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Challenge</th>
                      <th>Resume K</th>
                      <th>Updated (UTC)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checkpoints.map((r) => (
                      <tr key={`${r.playerGuid}-${r.challengeId}`}>
                        <td>{r.playerEmail || r.playerGuid}</td>
                        <td>{r.challengeId}</td>
                        <td>{r.resumeFromK}</td>
                        <td>{r.updatedAtUtc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </section>

        <section id="view-batches" className={view === "batches" ? "view-panel" : "view-panel hidden"}>
          <header className="page-header">
            <h1>Batch runs</h1>
            <p className="muted">Recent runs from <code>.data/web-batches.json</code></p>
          </header>
          <section className="panel">
            <div className="actions mb">
              <button type="button" className="secondary" onClick={() => loadBatchesList()}>
                Refresh
              </button>
            </div>
            {batches.length === 0 ? (
              <p className="muted">No stored batch runs yet.</p>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Started (UTC)</th>
                      <th>Submit</th>
                      <th>Player</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr key={b.id}>
                        <td>{b.id}</td>
                        <td>{b.startedAtUtc}</td>
                        <td>
                          {b.submit ? <span className="tag tag--success">yes</span> : <span className="tag tag--warn">no</span>}
                        </td>
                        <td>{b.playerEmail || b.playerGuid}</td>
                        <td>
                          <button type="button" className="link-btn" onClick={() => openBatchDetail(b.id)}>
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {batchDetail ? (
            <section className="panel" ref={batchDetailRef}>
              <h2>Batch detail</h2>
              <pre className="batch-log-pre">
                {[
                  `id: ${batchDetail.id}`,
                  `startedAtUtc: ${batchDetail.startedAtUtc}`,
                  `submit: ${batchDetail.submit}`,
                  `playerGuid: ${batchDetail.playerGuid}`,
                  `playerEmail: ${batchDetail.playerEmail}`,
                  "--- report ---",
                  JSON.stringify(batchDetail.report, null, 2),
                  "--- log ---",
                  ...(batchDetail.logLines ?? []),
                ].join("\n")}
              </pre>
            </section>
          ) : null}
        </section>
      </main>

      {loading ? (
        <div id="loading-overlay" role="presentation">
          <div className="loading-overlay__panel">
            <div className="loading-spinner" aria-hidden />
            <p className="loading-overlay__text">{loadingMessage}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
