/**
 * OutSystems REST client mirroring {@link StarDeliveryClient} in the .NET solver (same paths + headers).
 */
import type { ChallengeOut, PlanetMapSimple, PlanetOut, RouteOut } from "./types.js";

/** Same default as `StarDelivery.TspSolver.Config.BaseUrl`. */
export const DEFAULT_STAR_DELIVERY_BASE_URL =
  "https://wecode.outsystems.com/StarDelivery_Ngin/rest/StarDeliveryServices";

export interface StarDeliveryClientOptions {
  baseUrl?: string;
  playerGuid: string;
  playerEmail: string;
  signal?: AbortSignal;
}

function resolvedBaseUrl(explicit?: string): string {
  const raw = (explicit ?? process.env.STAR_DELIVERY_BASE_URL ?? DEFAULT_STAR_DELIVERY_BASE_URL).trim();
  return raw.replace(/\/+$/, "");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function pickStr(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

function pickBool(obj: Record<string, unknown>, ...keys: string[]): boolean {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "boolean") return v;
  }
  return false;
}

export function normalizePlanet(raw: unknown): PlanetOut {
  const o = asRecord(raw) ?? {};
  return {
    id: num(o.Id ?? o.id),
    name: pickStr(o, "Name", "name"),
    coordinateX: num(o.Coordinate_X ?? o.CoordinateX ?? o.coordinateX ?? o.coordinate_x),
    coordinateY: num(o.Coordinate_Y ?? o.CoordinateY ?? o.coordinateY ?? o.coordinate_y),
  };
}

export function normalizeRoute(raw: unknown): RouteOut {
  const o = asRecord(raw) ?? {};
  return {
    fromPlanet: num(o.From_Planet ?? o.FromPlanet ?? o.fromPlanet),
    toPlanetId: num(o.To_PlanetId ?? o.ToPlanetId ?? o.toPlanetId),
    routeType: pickStr(o, "RouteType", "routeType") || undefined,
  };
}

export function normalizePlanetMapSimple(raw: unknown): PlanetMapSimple {
  const o = asRecord(raw) ?? {};
  return {
    planetId: num(o.PlanetId ?? o.planetId),
    name: pickStr(o, "Name", "name"),
    bonus: num(o.Bonus ?? o.bonus),
  };
}

export function normalizeChallenge(raw: unknown): ChallengeOut {
  const o = asRecord(raw) ?? {};
  const mand = Array.isArray(o.MandatoryPlanets) ? o.MandatoryPlanets : o.mandatoryPlanets;
  const forb = Array.isArray(o.ForbiddenPlanets) ? o.ForbiddenPlanets : o.forbiddenPlanets;
  const bonus = Array.isArray(o.BonusPlanets) ? o.BonusPlanets : o.bonusPlanets;
  const levelRaw = o.Level ?? o.level;
  return {
    challengeId: num(o.ChallengeId ?? o.challengeId),
    challengeName: pickStr(o, "ChallengeName", "challengeName"),
    startPlanetId: pickStr(o, "StartPlanetId", "startPlanetId"),
    mandatoryPlanets: Array.isArray(mand) ? mand.map(normalizePlanetMapSimple) : [],
    forbiddenPlanets: Array.isArray(forb) ? forb.map(normalizePlanetMapSimple) : [],
    bonusPlanets: Array.isArray(bonus) ? bonus.map(normalizePlanetMapSimple) : [],
    isFinished: pickBool(o, "IsFinished", "isFinished"),
    level: typeof levelRaw === "string" ? levelRaw : undefined,
  };
}

async function fetchStarDeliveryJson<T>(
  relativePath: string,
  opts: StarDeliveryClientOptions,
): Promise<T> {
  const base = resolvedBaseUrl(opts.baseUrl);
  const url = `${base}/${relativePath.replace(/^\/+/, "")}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      PlayerGuid: opts.playerGuid,
      PlayerEmail: opts.playerEmail,
    },
    signal: opts.signal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Star Delivery ${relativePath} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!text.trim()) {
    throw new Error(`Star Delivery ${relativePath}: empty response body`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Star Delivery ${relativePath}: response is not JSON`);
  }
}

export interface StarDeliveryGameState {
  planets: PlanetOut[];
  routes: RouteOut[];
  challenges: ChallengeOut[];
}

/** OutSystems payload for CalculateCoaxium / SubmitChallengeSolution (PascalCase like C# default serializer). */
export interface PlanetSimplePayload {
  PlanetId: number;
  Name: string;
}

export interface SubmissionResult {
  isSuccess: boolean;
  feedbackMessage: string;
  coaxium: number;
  timeElapsedInSeconds?: number;
  timeElapsed?: number;
}

export function buildSubmissionFromRoute(
  route: readonly number[],
  planetsById: Map<number, PlanetOut>,
): PlanetSimplePayload[] {
  return route.map((id) => ({
    PlanetId: id,
    Name: planetsById.get(id)?.name ?? "",
  }));
}

function normalizeSubmissionResult(raw: unknown): SubmissionResult {
  const o = asRecord(raw) ?? {};
  return {
    isSuccess: pickBool(o, "IsSuccess", "isSuccess"),
    feedbackMessage: pickStr(o, "FeedbackMessage", "feedbackMessage"),
    coaxium: Math.trunc(num(o.Coaxium ?? o.coaxium)),
    timeElapsedInSeconds:
      typeof o.TimeElapsedInSeconds === "number"
        ? o.TimeElapsedInSeconds
        : typeof o.timeElapsedInSeconds === "number"
          ? o.timeElapsedInSeconds
          : undefined,
    timeElapsed:
      typeof o.TimeElapsed === "number"
        ? o.TimeElapsed
        : typeof o.timeElapsed === "number"
          ? o.timeElapsed
          : undefined,
  };
}

async function postStarDeliveryJson(
  relativePathWithQuery: string,
  body: unknown,
  opts: StarDeliveryClientOptions,
): Promise<SubmissionResult> {
  const base = resolvedBaseUrl(opts.baseUrl);
  const url = `${base}/${relativePathWithQuery.replace(/^\/+/, "")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      PlayerGuid: opts.playerGuid,
      PlayerEmail: opts.playerEmail,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Star Delivery ${relativePathWithQuery.split("?")[0]} HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!text.trim()) {
    return {
      isSuccess: false,
      feedbackMessage: "Empty response body.",
      coaxium: 0,
    };
  }
  try {
    return normalizeSubmissionResult(JSON.parse(text));
  } catch {
    throw new Error("Response is not JSON");
  }
}

export function calculateCoaxium(
  challengeId: number,
  route: PlanetSimplePayload[],
  opts: StarDeliveryClientOptions,
): Promise<SubmissionResult> {
  return postStarDeliveryJson(`CalculateCoaxium?ChallengeId=${encodeURIComponent(String(challengeId))}`, route, opts);
}

export function submitChallengeSolution(
  challengeId: number,
  route: PlanetSimplePayload[],
  opts: StarDeliveryClientOptions,
): Promise<SubmissionResult> {
  return postStarDeliveryJson(
    `SubmitChallengeSolution?ChallengeId=${encodeURIComponent(String(challengeId))}`,
    route,
    opts,
  );
}

export async function fetchStarDeliveryGameState(opts: StarDeliveryClientOptions): Promise<StarDeliveryGameState> {
  const mapUnknown = await fetchStarDeliveryJson<unknown>("GetPlanetsAndRoutes", opts);
  if (mapUnknown === null || typeof mapUnknown !== "object") {
    throw new Error("GetPlanetsAndRoutes returned empty payload.");
  }
  const mapRec = asRecord(mapUnknown) ?? {};
  const planetsRaw = mapRec.Planets ?? mapRec.planets;
  const routesRaw = mapRec.Routes ?? mapRec.routes;
  const planets = Array.isArray(planetsRaw) ? planetsRaw.map(normalizePlanet) : [];
  const routes = Array.isArray(routesRaw) ? routesRaw.map(normalizeRoute) : [];

  const challengesUnknown = await fetchStarDeliveryJson<unknown>("GetDailyChallenge", opts);
  const challengesArr = Array.isArray(challengesUnknown)
    ? challengesUnknown
    : Array.isArray((challengesUnknown as Record<string, unknown>)?.items)
      ? ((challengesUnknown as Record<string, unknown>).items as unknown[])
      : [];

  const challenges = challengesArr.map(normalizeChallenge);

  return { planets, routes, challenges };
}
