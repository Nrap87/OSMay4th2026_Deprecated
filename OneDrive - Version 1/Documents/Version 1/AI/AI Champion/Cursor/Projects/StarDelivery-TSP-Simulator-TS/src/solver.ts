/**
 * Port of StarDelivery.TspSolver `Solver.cs` — constrained routing with Yen K-shortest
 * legs, Dijkstra on complete geometric graph, mandatory/forbidden/bonus logic.
 */
import { MaxRequestedK } from "./config.js";
import { MinPriorityQueue } from "./priorityQueue.js";
import type { PlanetMapSimple, PlanetOut, RouteOut, SolverResult } from "./types.js";

type BonusPlanet = { planetId: number; value: number };
type PathCandidate = { cost: number; path: number[] };

function edgeKey(a: number, b: number): string {
  return a <= b ? `${a}-${b}` : `${b}-${a}`;
}

function directedEdgeKey(from: number, to: number): string {
  return `${from}-${to}`;
}

function effectiveK(requestedK: number): number {
  const requested = Math.max(1, requestedK);
  return Math.min(requested, MaxRequestedK);
}

function routeHasIllegalPlanetRepeats(route: readonly number[], startId: number): boolean {
  if (route.length === 0) return false;
  const counts = new Map<number, number>();
  for (const id of route) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, n] of counts) {
    if (id === startId) {
      if (n !== 2) return true;
      if (route[0] !== startId || route[route.length - 1] !== startId) return true;
      continue;
    }
    if (n !== 1) return true;
  }
  return false;
}

function euclideanDistance(planetsById: Map<number, PlanetOut>, a: number, b: number): number {
  const pa = planetsById.get(a)!;
  const pb = planetsById.get(b)!;
  const dx = pa.coordinateX - pb.coordinateX;
  const dy = pa.coordinateY - pb.coordinateY;
  return Math.sqrt(dx * dx + dy * dy);
}

function edgeCost(
  planetsById: Map<number, PlanetOut>,
  a: number,
  b: number,
  mainSet: Set<string>,
  otherSet: Set<string>,
): number {
  const baseCost = euclideanDistance(planetsById, a, b);
  const key = edgeKey(a, b);
  if (mainSet.has(key)) return 0.5 * baseCost;
  if (otherSet.has(key)) return (2.0 / 3.0) * baseCost;
  return baseCost;
}

function buildDiscountSets(routes: readonly RouteOut[]): { mainSet: Set<string>; otherSet: Set<string> } {
  const mainSet = new Set<string>();
  const otherSet = new Set<string>();
  for (const route of routes) {
    const key = edgeKey(route.fromPlanet, route.toPlanetId);
    const routeType = (route.routeType ?? "")
      .trim()
      .toLowerCase()
      .replace(/_/g, "")
      .replace(/\s+/g, "");
    if (routeType.includes("main")) mainSet.add(key);
    else if (routeType.includes("other")) otherSet.add(key);
  }
  return { mainSet, otherSet };
}

function getDist(dist: Map<number, number>, node: number): number {
  return dist.get(node) ?? Number.POSITIVE_INFINITY;
}

function dijkstra(
  planetsById: Map<number, PlanetOut>,
  source: number,
  target: number,
  mainSet: Set<string>,
  otherSet: Set<string>,
  forbiddenNodes: Set<number>,
  forbiddenEdges: Set<string>,
): PathCandidate | null {
  if (source === target) return { cost: 0, path: [source] };
  if (forbiddenNodes.has(source) || forbiddenNodes.has(target)) return null;

  const usablePlanetIds = [...planetsById.keys()].filter((id) => !forbiddenNodes.has(id));
  const dist = new Map<number, number>([[source, 0]]);
  const prev = new Map<number, number>();
  const pq = new MinPriorityQueue<number>();
  pq.enqueue(source, 0);

  let deque: { value: number; priority: number } | undefined;
  while ((deque = pq.tryDequeue()) !== undefined) {
    const current = deque.value;
    const currentDistance = deque.priority;
    if (currentDistance > getDist(dist, current)) continue;
    if (current === target) break;

    for (const next of usablePlanetIds) {
      if (next === current) continue;
      if (forbiddenEdges.has(directedEdgeKey(current, next))) continue;

      const candidate = currentDistance + edgeCost(planetsById, current, next, mainSet, otherSet);
      if (candidate < getDist(dist, next)) {
        dist.set(next, candidate);
        prev.set(next, current);
        pq.enqueue(next, candidate);
      }
    }
  }

  if (!dist.has(target)) return null;
  const path: number[] = [target];
  let node = target;
  while (node !== source) {
    node = prev.get(node)!;
    path.push(node);
  }
  path.reverse();
  return { cost: dist.get(target)!, path };
}

function pathCost(
  planetsById: Map<number, PlanetOut>,
  path: readonly number[],
  mainSet: Set<string>,
  otherSet: Set<string>,
): number {
  let cost = 0;
  for (let i = 0; i < path.length - 1; i++) {
    cost += edgeCost(planetsById, path[i], path[i + 1], mainSet, otherSet);
  }
  return cost;
}

function pathsPrefixEqual(path: readonly number[], len: number, prefix: readonly number[]): boolean {
  if (path.length < len || prefix.length !== len) return false;
  for (let i = 0; i < len; i++) if (path[i] !== prefix[i]) return false;
  return true;
}

function yenKShortestPaths(
  planetsById: Map<number, PlanetOut>,
  source: number,
  target: number,
  k: number,
  mainSet: Set<string>,
  otherSet: Set<string>,
  forbiddenNodes: Set<number>,
): PathCandidate[] {
  const first = dijkstra(planetsById, source, target, mainSet, otherSet, forbiddenNodes, new Set());
  if (first === null) return [];

  const accepted: PathCandidate[] = [first];
  const candidateQueue = new MinPriorityQueue<PathCandidate>();
  const candidatePathKeys = new Set<string>();

  const kMax = Math.max(1, k);
  for (let kIndex = 1; kIndex < kMax; kIndex++) {
    const previousPath = accepted[kIndex - 1].path;
    for (let i = 0; i < previousPath.length - 1; i++) {
      const spurNode = previousPath[i];
      const rootPath = previousPath.slice(0, i + 1);

      const localForbiddenEdges = new Set<string>();
      for (const acceptedPath of accepted) {
        if (acceptedPath.path.length <= i) continue;
        if (pathsPrefixEqual(acceptedPath.path, i + 1, rootPath)) {
          const a = acceptedPath.path[i];
          const b = acceptedPath.path[i + 1];
          localForbiddenEdges.add(directedEdgeKey(a, b));
          localForbiddenEdges.add(directedEdgeKey(b, a));
        }
      }

      const localForbiddenNodes = new Set(forbiddenNodes);
      for (let j = 0; j < rootPath.length - 1; j++) {
        localForbiddenNodes.add(rootPath[j]);
      }

      const spur = dijkstra(
        planetsById,
        spurNode,
        target,
        mainSet,
        otherSet,
        localForbiddenNodes,
        localForbiddenEdges,
      );
      if (spur === null) continue;

      const totalPath = rootPath.slice(0, -1).concat(spur.path);
      const totalPathKey = totalPath.join(">");
      if (candidatePathKeys.has(totalPathKey)) continue;
      candidatePathKeys.add(totalPathKey);

      const totalCost = pathCost(planetsById, totalPath, mainSet, otherSet);
      candidateQueue.enqueue({ cost: totalCost, path: totalPath }, totalCost);
    }

    const next = candidateQueue.tryDequeue();
    if (next === undefined) break;
    accepted.push(next.value);
  }

  return [...accepted].sort((x, y) => x.cost - y.cost).slice(0, k);
}

function popCount(mask: number): number {
  let c = 0;
  for (let x = mask; x !== 0; x &= x - 1) c++;
  return c;
}

/** Try smaller bonus subsets first so branch-and-bound often tightens `bestEffective` earlier. */
function* bonusPowersetBySize(bonuses: readonly BonusPlanet[]): Generator<BonusPlanet[]> {
  const count = bonuses.length;
  const maxMask = 1 << count;
  for (let targetPop = 0; targetPop <= count; targetPop++) {
    for (let mask = 0; mask < maxMask; mask++) {
      if (popCount(mask) !== targetPop) continue;
      const subset: BonusPlanet[] = [];
      for (let i = 0; i < count; i++) {
        if ((mask & (1 << i)) !== 0) subset.push(bonuses[i]);
      }
      yield subset;
    }
  }
}

function* permutations(items: readonly number[]): Generator<number[]> {
  if (items.length === 0) {
    yield [];
    return;
  }
  const used = new Array<boolean>(items.length).fill(false);
  const current: number[] = [];
  yield* generatePermutations(items, used, current);
}

function* generatePermutations(items: readonly number[], used: boolean[], current: number[]): Generator<number[]> {
  if (current.length === items.length) {
    yield [...current];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    current.push(items[i]);
    yield* generatePermutations(items, used, current);
    current.pop();
    used[i] = false;
  }
}

/** Sort smaller instances by a cheap Euclidean tour LB so DFS hits good incumbents sooner. */
const PERMUTATION_SORT_MAX_STOPS = 8;

function collectAllPermutations(items: readonly number[]): number[][] {
  const out: number[][] = [];
  for (const p of permutations(items)) out.push(p);
  return out;
}

function sortPermutationsByEuclideanLb(
  perms: number[][],
  planetsById: Map<number, PlanetOut>,
  startId: number,
  bonusCredit: number,
): void {
  const score = (perm: number[]): number => {
    if (perm.length === 0) return -bonusCredit;
    let s = euclideanDistance(planetsById, startId, perm[0]);
    for (let i = 0; i < perm.length - 1; i++) {
      s += euclideanDistance(planetsById, perm[i], perm[i + 1]);
    }
    s += euclideanDistance(planetsById, perm[perm.length - 1], startId);
    return s - bonusCredit;
  };
  perms.sort((a, b) => score(a) - score(b));
}

function emptySolverResult(partial: Partial<SolverResult> & { success: boolean }): SolverResult {
  return {
    success: partial.success,
    errorMessage: partial.errorMessage ?? null,
    route: partial.route ?? null,
    grossFuel: partial.grossFuel ?? 0,
    bonusCollected: partial.bonusCollected ?? 0,
    effectiveFuel: partial.effectiveFuel ?? 0,
    effectiveKUsed: partial.effectiveKUsed ?? 0,
    ladderMinKApplied: partial.ladderMinKApplied ?? 0,
    ladderMaxKApplied: partial.ladderMaxKApplied ?? 0,
    executionStartUtc: partial.executionStartUtc ?? "",
    executionEndUtc: partial.executionEndUtc ?? "",
    durationSeconds: partial.durationSeconds ?? 0,
    stoppedByTimeBudgetWithoutSuccess: partial.stoppedByTimeBudgetWithoutSuccess ?? false,
  };
}

export function solve(
  planets: PlanetOut[],
  routes: RouteOut[],
  startId: number,
  mandatoryIds: number[],
  forbiddenIds: number[],
  bonusPlanets: PlanetMapSimple[],
  requestedK: number,
  initialBest?: SolverResult | null,
): SolverResult {
  const planetsById = new Map(planets.map((p) => [p.id, p] as const));
  if (!planetsById.has(startId)) {
    return emptySolverResult({
      success: false,
      errorMessage: "Start planet is not present in the map.",
    });
  }

  const forbiddenSet = new Set(forbiddenIds);
  if (forbiddenSet.has(startId)) {
    return emptySolverResult({
      success: false,
      errorMessage: "Start planet is forbidden for this challenge.",
    });
  }

  const cleanedMandatory: number[] = [];
  const seenMandatory = new Set<number>();
  for (const mandatoryId of mandatoryIds) {
    if (mandatoryId === startId) continue;
    if (!planetsById.has(mandatoryId)) {
      return emptySolverResult({
        success: false,
        errorMessage: `Mandatory planet ${mandatoryId} does not exist in current map; refresh and retry.`,
      });
    }
    if (forbiddenSet.has(mandatoryId)) {
      return emptySolverResult({
        success: false,
        errorMessage: `Mandatory planet ${mandatoryId} is forbidden in this challenge.`,
      });
    }
    if (!seenMandatory.has(mandatoryId)) {
      seenMandatory.add(mandatoryId);
      cleanedMandatory.push(mandatoryId);
    }
  }

  if (cleanedMandatory.length === 0 && bonusPlanets.length === 0) {
    return emptySolverResult({
      success: true,
      route: [startId, startId],
      grossFuel: 0,
      bonusCollected: 0,
      effectiveFuel: 0,
    });
  }

  const { mainSet, otherSet } = buildDiscountSets(routes);

  const parsedBonuses: BonusPlanet[] = bonusPlanets
    .filter(
      (b) =>
        b.bonus > 0 &&
        planetsById.has(b.planetId) &&
        !forbiddenSet.has(b.planetId) &&
        b.planetId !== startId,
    )
    .map((b) => ({ planetId: b.planetId, value: b.bonus }));

  const k = effectiveK(requestedK);
  const kspCache = new Map<string, PathCandidate[]>();
  const pairKey = (a: number, b: number) => `${a},${b}`;

  function getKsp(source: number, target: number): PathCandidate[] {
    const key = pairKey(source, target);
    let list = kspCache.get(key);
    if (list === undefined) {
      list = yenKShortestPaths(planetsById, source, target, k, mainSet, otherSet, forbiddenSet);
      kspCache.set(key, list);
    }
    return list;
  }

  for (const source of cleanedMandatory) {
    for (const target of cleanedMandatory) {
      if (source === target) continue;
      const paths = getKsp(source, target);
      if (paths.length === 0) {
        return emptySolverResult({
          success: false,
          errorMessage: `Mandatory planets ${source} and ${target} are mutually unreachable.`,
        });
      }
    }
  }

  const hasInitial =
    initialBest != null &&
    initialBest.success &&
    initialBest.route != null &&
    initialBest.route.length > 1;
  let bestEffective = hasInitial ? initialBest!.effectiveFuel : Number.POSITIVE_INFINITY;
  let bestGross = hasInitial ? initialBest!.grossFuel : Number.POSITIVE_INFINITY;
  let bestBonus = hasInitial ? initialBest!.bonusCollected : 0;
  let bestRoute: number[] | null = hasInitial ? [...initialBest!.route!] : null;

  function dfsDisjoint(
    segments: { from: number; to: number }[],
    idx: number,
    visited: Set<number>,
    costSoFar: number,
    pathSoFar: number[],
    bonusCredit: number,
  ): void {
    if (costSoFar - bonusCredit >= bestEffective) return;
    if (idx === segments.length) {
      bestEffective = costSoFar - bonusCredit;
      bestGross = costSoFar;
      bestBonus = bonusCredit;
      bestRoute = [...pathSoFar];
      return;
    }

    const segment = segments[idx];
    const candidates = getKsp(segment.from, segment.to);
    if (candidates.length === 0) return;

    const isLast = idx === segments.length - 1;
    for (const candidate of candidates) {
      if (costSoFar + candidate.cost - bonusCredit >= bestEffective) break;

      //const intermediates = candidate.path.slice(1, -1);
      // DELETE
      //if (intermediates.some((node) => visited.has(node))) continue;

      const endpoint = candidate.path[candidate.path.length - 1];
      if (!isLast && visited.has(endpoint)) continue;

      const newVisited = new Set(visited);
      // DELETE
      /*
      for (const node of intermediates) {
        newVisited.add(node);
      }*/
      if (!isLast) {
        newVisited.add(endpoint);
      }

      const nextPath = pathSoFar.concat(candidate.path.slice(1));
      dfsDisjoint(segments, idx + 1, newVisited, costSoFar + candidate.cost, nextPath, bonusCredit);
    }
  }

  for (const bonusSubset of bonusPowersetBySize(parsedBonuses)) {
    const bonusCredit = bonusSubset.reduce((s, x) => s + x.value, 0);
    const forcedStops = [...new Set([...cleanedMandatory, ...bonusSubset.map((x) => x.planetId)])];

    if (forcedStops.length === 0) {
      if (-bonusCredit < bestEffective) {
        bestEffective = -bonusCredit;
        bestGross = 0;
        bestBonus = bonusCredit;
        bestRoute = [startId, startId];
      }
      continue;
    }

    if (forcedStops.length <= PERMUTATION_SORT_MAX_STOPS) {
      const permList = collectAllPermutations(forcedStops);
      sortPermutationsByEuclideanLb(permList, planetsById, startId, bonusCredit);
      for (const permutation of permList) {
        const sequence = [startId, ...permutation, startId];
        const segments: { from: number; to: number }[] = [];
        for (let i = 0; i < sequence.length - 1; i++) {
          segments.push({ from: sequence[i], to: sequence[i + 1] });
        }
        dfsDisjoint(segments, 0, new Set([startId]), 0, [startId], bonusCredit);
      }
    } else {
      for (const permutation of permutations(forcedStops)) {
        const sequence = [startId, ...permutation, startId];
        const segments: { from: number; to: number }[] = [];
        for (let i = 0; i < sequence.length - 1; i++) {
          segments.push({ from: sequence[i], to: sequence[i + 1] });
        }
        dfsDisjoint(segments, 0, new Set([startId]), 0, [startId], bonusCredit);
      }
    }
  }

  if (bestRoute === null) {
    return emptySolverResult({
      success: false,
      errorMessage: "No valid route found for mandatory/forbidden constraints.",
    });
  }

  if (routeHasIllegalPlanetRepeats(bestRoute, startId)) {
    return emptySolverResult({
      success: false,
      errorMessage:
        "Route would repeat planets; the API requires each planet at most once (except returning to start). Try increasing K.",
    });
  }

  return emptySolverResult({
    success: true,
    route: bestRoute,
    grossFuel: Math.round(bestGross * 1e6) / 1e6,
    bonusCollected: Math.round(bestBonus * 1e6) / 1e6,
    effectiveFuel: Math.round(bestEffective * 1e6) / 1e6,
  });
}
