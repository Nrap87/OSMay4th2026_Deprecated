export interface PlanetNode {
  id: number;
  name: string;
  x: number;
  y: number;
}

export interface RouteDiscount {
  from: number;
  to: number;
  routeType: string;
}

export interface BonusStop {
  planetId: number;
  value: number;
}

export interface DailyChallengeInput {
  startPlanetId: number;
  mandatoryPlanetIds: number[];
  forbiddenPlanetIds: number[];
  bonusStops: BonusStop[];
}

export interface SolverInput {
  planets: PlanetNode[];
  routes: RouteDiscount[];
  challenge: DailyChallengeInput;
  requestedK?: number;
}

export interface SolverOutput {
  success: boolean;
  route: number[] | null;
  grossFuel: number;
  bonusCollected: number;
  effectiveFuel: number;
  effectiveKUsed: number;
  errorMessage: string | null;
}
