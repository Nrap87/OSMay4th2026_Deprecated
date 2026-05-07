export interface PlanetOut {
  id: number;
  name: string;
  /** Euclidean X (maps JSON `Coordinate_X`). */
  coordinateX: number;
  /** Euclidean Y (maps JSON `Coordinate_Y`). */
  coordinateY: number;
}

export interface RouteOut {
  fromPlanet: number;
  toPlanetId: number;
  /** e.g. `"Main"` / `"Other"` — affects edge fuel discount (see `Solver`). */
  routeType?: string;
}

export interface PlanetMapSimple {
  planetId: number;
  name: string;
  bonus: number;
}

export interface ChallengeOut {
  challengeId: number;
  challengeName: string;
  startPlanetId: string;
  mandatoryPlanets: PlanetMapSimple[];
  forbiddenPlanets: PlanetMapSimple[];
  bonusPlanets: PlanetMapSimple[];
  isFinished: boolean;
  /** Present on live API payloads (OutSystems). */
  level?: string;
}

export interface SolverResult {
  success: boolean;
  errorMessage: string | null;
  route: number[] | null;
  grossFuel: number;
  bonusCollected: number;
  effectiveFuel: number;
  effectiveKUsed: number;
  ladderMinKApplied: number;
  ladderMaxKApplied: number;
  executionStartUtc: string;
  executionEndUtc: string;
  durationSeconds: number;
  stoppedByTimeBudgetWithoutSuccess: boolean;
}

export interface BatchChallengeResultRow {
  challengeId: number;
  challengeName: string;
  status: string;
  detail: string;
  totalDurationMs: number | null;
}

export interface BatchRunSummary {
  planetCount: number;
  routeCount: number;
  challengeCount: number;
  skippedFinished: number;
  solverSuccess: number;
  solverFailure: number;
}

export interface BatchRunReport {
  summary: BatchRunSummary;
  rows: BatchChallengeResultRow[];
}
