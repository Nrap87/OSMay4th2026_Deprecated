import { MinPriorityQueue } from "../priorityQueue.js";
import { DEFAULT_REQUESTED_K, effectiveKByKeyNodes } from "./adaptiveK.js";
import type { BonusStop, PlanetNode, RouteDiscount, SolverInput, SolverOutput } from "./types.js";

type PathCandidate = { cost: number; path: number[] };
const EPSILON = 1e-9;

function hasCliFlag(flag: string): boolean {
  if (process.argv.includes(flag)) return true;

  const npmArgv = process.env.npm_config_argv;
  if (npmArgv) {
    try {
      const parsed = JSON.parse(npmArgv) as { original?: string[] };
      if (parsed.original?.includes(flag)) return true;
    } catch {
      // Ignore malformed npm_config_argv and try fallback key below.
    }
  }

  const fallbackKey = flag === "--tsp-debug" ? process.env.npm_config_tsp_debug : undefined;
  return fallbackKey === "true";
}

const DEBUG_TSP = hasCliFlag("--tsp-debug");

function debugTspLog(message: string, details?: unknown): void {
  if (!DEBUG_TSP) return;
  if (details === undefined) {
    console.log(`[tsp-debug] ${message}`);
    return;
  }
  console.log(`[tsp-debug] ${message}`, details);
}

function edgeKey(a: number, b: number): string {
  return a <= b ? `${a}-${b}` : `${b}-${a}`;
}

function directedEdgeKey(from: number, to: number): string {
  return `${from}-${to}`;
}

function euclideanDistance(planetsById: Map<number, PlanetNode>, a: number, b: number): number {
  const pa = planetsById.get(a)!;
  const pb = planetsById.get(b)!;
  const dx = pa.x - pb.x;
  const dy = pa.y - pb.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function buildDiscountSets(routes: readonly RouteDiscount[]): { mainSet: Set<string>; otherSet: Set<string> } {
  const mainSet = new Set<string>();
  const otherSet = new Set<string>();

  for (const route of routes) {
    const key = edgeKey(route.from, route.to);
    const routeType = route.routeType.trim().toLowerCase().replace(/_/g, "").replace(/\s+/g, "");
    if (routeType.includes("main")) {
      mainSet.add(key);
    } else if (routeType.includes("other")) {
      otherSet.add(key);
    }
  }

  return { mainSet, otherSet };
}

function edgeCost(
  planetsById: Map<number, PlanetNode>,
  a: number,
  b: number,
  mainSet: Set<string>,
  otherSet: Set<string>,
): number {
  const base = euclideanDistance(planetsById, a, b);
  const key = edgeKey(a, b);
  if (mainSet.has(key)) return 0.5 * base;
  if (otherSet.has(key)) return (2 / 3) * base;
  return base;
}

function getDist(dist: Map<number, number>, node: number): number {
  return dist.get(node) ?? Number.POSITIVE_INFINITY;
}

function dijkstra(
  planetsById: Map<number, PlanetNode>,
  source: number,
  target: number,
  mainSet: Set<string>,
  otherSet: Set<string>,
  forbiddenNodes: Set<number>,
  forbiddenEdges: Set<string>,
): PathCandidate | null {
  if (source === target) return { cost: 0, path: [source] };
  if (forbiddenNodes.has(source) || forbiddenNodes.has(target)) return null;

  const usable = [...planetsById.keys()].filter((id) => !forbiddenNodes.has(id));
  const dist = new Map<number, number>([[source, 0]]);
  const prev = new Map<number, number>();
  const queue = new MinPriorityQueue<number>();
  queue.enqueue(source, 0);

  let next = queue.tryDequeue();
  while (next !== undefined) {
    const u = next.value;
    const du = next.priority;
    if (du > getDist(dist, u)) {
      next = queue.tryDequeue();
      continue;
    }
    if (u === target) break;

    for (const v of usable) {
      if (u === v) continue;
      if (forbiddenEdges.has(directedEdgeKey(u, v))) continue;
      const candidate = du + edgeCost(planetsById, u, v, mainSet, otherSet);
      if (candidate < getDist(dist, v)) {
        dist.set(v, candidate);
        prev.set(v, u);
        queue.enqueue(v, candidate);
      }
    }
    next = queue.tryDequeue();
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

function pathsPrefixEqual(path: readonly number[], prefix: readonly number[]): boolean {
  if (path.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (path[i] !== prefix[i]) return false;
  }
  return true;
}

function pathCost(
  planetsById: Map<number, PlanetNode>,
  path: readonly number[],
  mainSet: Set<string>,
  otherSet: Set<string>,
): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += edgeCost(planetsById, path[i], path[i + 1], mainSet, otherSet);
  }
  return total;
}

function yenKShortestPaths(
  planetsById: Map<number, PlanetNode>,
  source: number,
  target: number,
  k: number,
  mainSet: Set<string>,
  otherSet: Set<string>,
  forbiddenNodes: Set<number>,
): PathCandidate[] {
  const first = dijkstra(planetsById, source, target, mainSet, otherSet, forbiddenNodes, new Set<string>());
  if (first === null) return [];

  const accepted: PathCandidate[] = [first];
  const candidates = new MinPriorityQueue<PathCandidate>();
  const seenKeys = new Set<string>();

  for (let kth = 1; kth < k; kth++) {
    const previous = accepted[kth - 1].path;
    for (let i = 0; i < previous.length - 1; i++) {
      const spurNode = previous[i];
      const rootPath = previous.slice(0, i + 1);

      const localForbiddenEdges = new Set<string>();
      for (const acceptedPath of accepted) {
        if (acceptedPath.path.length <= i) continue;
        if (pathsPrefixEqual(acceptedPath.path, rootPath)) {
          const a = acceptedPath.path[i];
          const b = acceptedPath.path[i + 1];
          localForbiddenEdges.add(directedEdgeKey(a, b));
          localForbiddenEdges.add(directedEdgeKey(b, a));
        }
      }

      const localForbiddenNodes = new Set<number>(forbiddenNodes);
      for (let rootIndex = 0; rootIndex < rootPath.length - 1; rootIndex++) {
        localForbiddenNodes.add(rootPath[rootIndex]);
      }

      const spurPath = dijkstra(
        planetsById,
        spurNode,
        target,
        mainSet,
        otherSet,
        localForbiddenNodes,
        localForbiddenEdges,
      );
      if (spurPath === null) continue;

      const totalPath = rootPath.slice(0, -1).concat(spurPath.path);
      const key = totalPath.join(">");
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const cost = pathCost(planetsById, totalPath, mainSet, otherSet);
      candidates.enqueue({ cost, path: totalPath }, cost);
    }

    const nextCandidate = candidates.tryDequeue();
    if (nextCandidate === undefined) break;
    accepted.push(nextCandidate.value);
  }

  return accepted.sort((a, b) => a.cost - b.cost).slice(0, k);
}

function popCount(mask: number): number {
  let count = 0;
  for (let value = mask; value > 0; value &= value - 1) count++;
  return count;
}

function* bonusSubsetsBySize(bonuses: readonly BonusStop[]): Generator<BonusStop[]> {
  const n = bonuses.length;
  const max = 1 << n;
  for (let size = 0; size <= n; size++) {
    for (let mask = 0; mask < max; mask++) {
      if (popCount(mask) !== size) continue;
      const subset: BonusStop[] = [];
      for (let bit = 0; bit < n; bit++) {
        if ((mask & (1 << bit)) !== 0) subset.push(bonuses[bit]);
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
  yield* permute(items, used, current);
}

function* permute(items: readonly number[], used: boolean[], current: number[]): Generator<number[]> {
  if (current.length === items.length) {
    yield [...current];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    current.push(items[i]);
    yield* permute(items, used, current);
    current.pop();
    used[i] = false;
  }
}

const PERMUTATION_SORT_MAX_STOPS = 8;

function collectAllPermutations(items: readonly number[]): number[][] {
  const out: number[][] = [];
  for (const permutation of permutations(items)) out.push(permutation);
  return out;
}

function sortPermutationsByEuclideanLb(
  perms: number[][],
  planetsById: Map<number, PlanetNode>,
  startId: number,
  bonusCredit: number,
): void {
  const score = (perm: readonly number[]): number => {
    if (perm.length === 0) return -bonusCredit;
    let sum = euclideanDistance(planetsById, startId, perm[0]);
    for (let i = 0; i < perm.length - 1; i++) {
      sum += euclideanDistance(planetsById, perm[i], perm[i + 1]);
    }
    sum += euclideanDistance(planetsById, perm[perm.length - 1], startId);
    return sum - bonusCredit;
  };
  perms.sort((a, b) => score(a) - score(b));
}

function hasIllegalRepeats(route: readonly number[], startId: number): boolean {
  const counts = new Map<number, number>();
  for (const id of route) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [planetId, seenCount] of counts) {
    if (planetId === startId) {
      if (seenCount !== 2) return true;
      if (route[0] !== startId || route[route.length - 1] !== startId) return true;
      continue;
    }
    if (seenCount !== 1) return true;
  }
  return false;
}

function strictlyBetter(
  effective: number,
  gross: number,
  bestEffective: number,
  bestGross: number,
): boolean {
  if (effective < bestEffective - EPSILON) return true;
  if (Math.abs(effective - bestEffective) <= EPSILON && gross < bestGross - EPSILON) return true;
  return false;
}

/**
 * Stitch one route along key-node sequence using shortest available segment candidates that stay
 * vertex-disjoint (same rule as DFS): no planet repeats except returning to start at the end.
 */
function tryStitchDisjointFromSequence(
  sequence: readonly number[],
  kspCache: ReadonlyMap<string, PathCandidate[]>,
  pairKeyFn: (a: number, b: number) => string,
): { path: number[]; gross: number } | null {
  const origin = sequence[0]!;
  const visited = new Set<number>([origin]);
  let path: number[] = [origin];
  let gross = 0;

  for (let segIdx = 0; segIdx < sequence.length - 1; segIdx++) {
    const from = sequence[segIdx]!;
    const to = sequence[segIdx + 1]!;
    const isLast = segIdx === sequence.length - 2;
    const candidates = kspCache.get(pairKeyFn(from, to)) ?? [];
    let picked: PathCandidate | null = null;

    for (const candidate of candidates) {
      const intermediates = candidate.path.slice(1, -1);
      if (intermediates.some((node) => visited.has(node))) continue;
      const endpoint = candidate.path[candidate.path.length - 1]!;
      if (!isLast && visited.has(endpoint)) continue;
      picked = candidate;
      break;
    }

    if (picked === null) return null;

    gross += picked.cost;
    const intermediates = picked.path.slice(1, -1);
    for (const node of intermediates) visited.add(node);
    if (!isLast) visited.add(picked.path[picked.path.length - 1]!);
    path = path.concat(picked.path.slice(1));
  }

  return { path, gross };
}

/** Nearest-neighbor order over mandatory keys using cheapest KSP edge cost from current position. */
function greedyMandatoryVisitOrder(
  startId: number,
  mandatory: readonly number[],
  kspCache: ReadonlyMap<string, PathCandidate[]>,
  pairKeyFn: (a: number, b: number) => string,
): number[] {
  const remaining = new Set(mandatory);
  const order: number[] = [];
  let current = startId;

  while (remaining.size > 0) {
    let bestNext: number | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const cand of remaining) {
      const cheapest = kspCache.get(pairKeyFn(current, cand))?.[0]?.cost;
      if (cheapest === undefined) continue;
      if (cheapest < bestCost - EPSILON || (Math.abs(cheapest - bestCost) <= EPSILON && (bestNext === null || cand < bestNext))) {
        bestCost = cheapest;
        bestNext = cand;
      }
    }
    if (bestNext === null) break;
    order.push(bestNext);
    remaining.delete(bestNext);
    current = bestNext;
  }

  return order.length === mandatory.length ? order : [];
}

function failed(errorMessage: string, effectiveKUsed = 0): SolverOutput {
  return {
    success: false,
    route: null,
    grossFuel: 0,
    bonusCollected: 0,
    effectiveFuel: 0,
    effectiveKUsed,
    errorMessage,
  };
}

export function solveChallengeTsp(input: SolverInput): SolverOutput {
  const planetsById = new Map(input.planets.map((planet) => [planet.id, planet] as const));
  const startId = input.challenge.startPlanetId;
  if (!planetsById.has(startId)) {
    return failed("Start planet is not present in planets list.");
  }

  const forbidden = new Set(input.challenge.forbiddenPlanetIds);
  if (forbidden.has(startId)) {
    return failed("Start planet is forbidden.");
  }

  const mandatory: number[] = [];
  const seenMandatory = new Set<number>();
  for (const planetId of input.challenge.mandatoryPlanetIds) {
    if (planetId === startId) continue;
    if (!planetsById.has(planetId)) {
      return failed(`Mandatory planet ${planetId} is missing from planets list.`);
    }
    if (forbidden.has(planetId)) {
      return failed(`Mandatory planet ${planetId} is forbidden in this challenge.`);
    }
    if (!seenMandatory.has(planetId)) {
      seenMandatory.add(planetId);
      mandatory.push(planetId);
    }
  }

  const validBonuses = input.challenge.bonusStops.filter(
    (bonus) =>
      bonus.value > 0 &&
      bonus.planetId !== startId &&
      planetsById.has(bonus.planetId) &&
      !forbidden.has(bonus.planetId),
  );

  if (mandatory.length === 0 && validBonuses.length === 0) {
    return {
      success: true,
      route: [startId, startId],
      grossFuel: 0,
      bonusCollected: 0,
      effectiveFuel: 0,
      effectiveKUsed: 1,
      errorMessage: null,
    };
  }

  const keyNodeIds = [...new Set([startId, ...mandatory, ...validBonuses.map((bonus) => bonus.planetId)])];
  const requestedK = input.requestedK ?? DEFAULT_REQUESTED_K;
  const k = effectiveKByKeyNodes(requestedK, keyNodeIds.length);
  debugTspLog("solve-start", {
    startId,
    mandatoryCount: mandatory.length,
    validBonusCount: validBonuses.length,
    forbiddenCount: forbidden.size,
    keyNodeCount: keyNodeIds.length,
    requestedK,
    effectiveKUsed: k,
  });

  const { mainSet, otherSet } = buildDiscountSets(input.routes);
  const kspCache = new Map<string, PathCandidate[]>();
  const pairKey = (a: number, b: number): string => `${a}-${b}`;
  type PairStat = { from: number; to: number; count: number; cheapestCost: number | null; mostExpensiveCost: number | null };
  const pairStats: PairStat[] = [];

  for (const from of keyNodeIds) {
    for (const to of keyNodeIds) {
      if (from === to) continue;
      const paths = yenKShortestPaths(planetsById, from, to, k, mainSet, otherSet, forbidden);
      kspCache.set(pairKey(from, to), paths);
      pairStats.push({
        from,
        to,
        count: paths.length,
        cheapestCost: paths.length > 0 ? paths[0].cost : null,
        mostExpensiveCost: paths.length > 0 ? paths[paths.length - 1].cost : null,
      });
    }
  }
  if (pairStats.length > 0) {
    const counts = pairStats.map((x) => x.count);
    const minCount = Math.min(...counts);
    const maxCount = Math.max(...counts);
    const zeroCountPairs = pairStats.filter((x) => x.count === 0).length;
    const constrainedPairs = [...pairStats]
      .sort((a, b) => a.count - b.count)
      .slice(0, Math.min(10, pairStats.length))
      .map((x) => `${x.from}->${x.to} (count=${x.count}, cheapest=${x.cheapestCost ?? "n/a"})`);
    debugTspLog("ksp-cache-summary", {
      pairCount: pairStats.length,
      minCandidateCount: minCount,
      maxCandidateCount: maxCount,
      zeroCountPairs,
      mostConstrainedPairs: constrainedPairs,
    });
  }

  const reachabilityCore = [startId, ...mandatory];
  for (const from of reachabilityCore) {
    for (const to of reachabilityCore) {
      if (from === to) continue;
      const paths = kspCache.get(pairKey(from, to)) ?? [];
      if (paths.length === 0) {
        return failed(`No route between required planets ${from} and ${to}.`, k);
      }
    }
  }

  let bestEffective = Number.POSITIVE_INFINITY;
  let bestGross = Number.POSITIVE_INFINITY;
  let bestBonus = 0;
  let bestRoute: number[] | null = null;
  const searchCounters = {
    expandedNodes: 0,
    completePaths: 0,
    pruneBound: 0,
    pruneSubsetBonusBound: 0,
    prunePermutationBound: 0,
    pruneIntermediateCollision: 0,
    pruneEndpointCollision: 0,
    pruneNoCandidates: 0,
    bestUpdates: 0,
    greedySeedApplied: 0,
  };
  let currentTraceLabel = "initial";

  type Segment = { from: number; to: number };
  const dfsDisjoint = (
    segments: Segment[],
    idx: number,
    visited: Set<number>,
    costSoFar: number,
    pathSoFar: number[],
    bonusCredit: number,
  ): void => {
    searchCounters.expandedNodes++;
    if (costSoFar - bonusCredit >= bestEffective - EPSILON) return;
    if (idx === segments.length) {
      const effective = costSoFar - bonusCredit;
      if (!strictlyBetter(effective, costSoFar, bestEffective, bestGross)) return;
      searchCounters.completePaths++;
      searchCounters.bestUpdates++;
      bestEffective = effective;
      bestGross = costSoFar;
      bestBonus = bonusCredit;
      bestRoute = [...pathSoFar];
      debugTspLog("best-update", {
        trace: currentTraceLabel,
        bestEffective,
        bestGross,
        bestBonus,
        routeLength: bestRoute.length,
      });
      return;
    }

    const segment = segments[idx];
    const candidates = kspCache.get(pairKey(segment.from, segment.to)) ?? [];
    if (candidates.length === 0) {
      searchCounters.pruneNoCandidates++;
      return;
    }
    const isLast = idx === segments.length - 1;

    for (const candidate of candidates) {
      if (costSoFar + candidate.cost - bonusCredit >= bestEffective - EPSILON) {
        searchCounters.pruneBound++;
        break;
      }
      const intermediates = candidate.path.slice(1, -1);
      if (intermediates.some((node) => visited.has(node))) {
        searchCounters.pruneIntermediateCollision++;
        continue;
      }
      const endpoint = candidate.path[candidate.path.length - 1];
      if (!isLast && visited.has(endpoint)) {
        searchCounters.pruneEndpointCollision++;
        continue;
      }

      const nextVisited = new Set<number>(visited);
      for (const node of intermediates) nextVisited.add(node);
      if (!isLast) nextVisited.add(endpoint);

      dfsDisjoint(
        segments,
        idx + 1,
        nextVisited,
        costSoFar + candidate.cost,
        pathSoFar.concat(candidate.path.slice(1)),
        bonusCredit,
      );
    }
  };

  if (mandatory.length > 0) {
    const nnOrder = greedyMandatoryVisitOrder(startId, mandatory, kspCache, pairKey);
    if (nnOrder.length === mandatory.length) {
      const seedSequence = [startId, ...nnOrder, startId];
      const stitched = tryStitchDisjointFromSequence(seedSequence, kspCache, pairKey);
      if (stitched !== null && !hasIllegalRepeats(stitched.path, startId)) {
        const bonusCredit = 0;
        const effective = stitched.gross - bonusCredit;
        if (strictlyBetter(effective, stitched.gross, bestEffective, bestGross)) {
          searchCounters.greedySeedApplied++;
          searchCounters.bestUpdates++;
          bestEffective = effective;
          bestGross = stitched.gross;
          bestBonus = bonusCredit;
          bestRoute = stitched.path;
          debugTspLog("greedy-seed", {
            mandatoryOrder: nnOrder,
            bestEffective,
            bestGross,
            routeLength: bestRoute.length,
          });
        }
      }
    }
  }

  let subsetIndex = 0;
  for (const subset of bonusSubsetsBySize(validBonuses)) {
    subsetIndex++;
    const bonusCredit = subset.reduce((sum, bonus) => sum + bonus.value, 0);
    if (-bonusCredit >= bestEffective - EPSILON) {
      searchCounters.pruneSubsetBonusBound++;
      continue;
    }
    const forcedStops = [...new Set([...mandatory, ...subset.map((bonus) => bonus.planetId)])];
    if (forcedStops.length <= PERMUTATION_SORT_MAX_STOPS) {
      const sortedPermutations = collectAllPermutations(forcedStops);
      sortPermutationsByEuclideanLb(sortedPermutations, planetsById, startId, bonusCredit);
      let permutationIndex = 0;
      for (const permutation of sortedPermutations) {
        permutationIndex++;
        const sequence = [startId, ...permutation, startId];
        let optimisticGross = 0;
        let missingEdge = false;
        for (let index = 0; index < sequence.length - 1; index++) {
          const cheapestSegment = kspCache.get(pairKey(sequence[index], sequence[index + 1]))?.[0]?.cost;
          if (cheapestSegment === undefined) {
            missingEdge = true;
            break;
          }
          optimisticGross += cheapestSegment;
        }
        if (missingEdge) {
          searchCounters.prunePermutationBound++;
          continue;
        }
        const optimisticEffective = optimisticGross - bonusCredit;
        if (optimisticEffective >= bestEffective - EPSILON) {
          searchCounters.prunePermutationBound++;
          continue;
        }
        const segments: Segment[] = [];
        for (let index = 0; index < sequence.length - 1; index++) {
          segments.push({ from: sequence[index], to: sequence[index + 1] });
        }
        currentTraceLabel = `subset#${subsetIndex} bonus=[${subset.map((b) => b.planetId).join(",") || "none"}] perm#${permutationIndex}`;
        dfsDisjoint(segments, 0, new Set<number>([startId]), 0, [startId], bonusCredit);
      }
    } else {
      let permutationIndex = 0;
      for (const permutation of permutations(forcedStops)) {
        permutationIndex++;
        const sequence = [startId, ...permutation, startId];
        let optimisticGross = 0;
        let missingEdge = false;
        for (let index = 0; index < sequence.length - 1; index++) {
          const cheapestSegment = kspCache.get(pairKey(sequence[index], sequence[index + 1]))?.[0]?.cost;
          if (cheapestSegment === undefined) {
            missingEdge = true;
            break;
          }
          optimisticGross += cheapestSegment;
        }
        if (missingEdge) {
          searchCounters.prunePermutationBound++;
          continue;
        }
        const optimisticEffective = optimisticGross - bonusCredit;
        if (optimisticEffective >= bestEffective - EPSILON) {
          searchCounters.prunePermutationBound++;
          continue;
        }
        const segments: Segment[] = [];
        for (let index = 0; index < sequence.length - 1; index++) {
          segments.push({ from: sequence[index], to: sequence[index + 1] });
        }
        currentTraceLabel = `subset#${subsetIndex} bonus=[${subset.map((b) => b.planetId).join(",") || "none"}] perm#${permutationIndex}`;
        dfsDisjoint(segments, 0, new Set<number>([startId]), 0, [startId], bonusCredit);
      }
    }
  }

  debugTspLog("search-summary", {
    ...searchCounters,
    bestFound: bestRoute !== null,
    bestEffective: Number.isFinite(bestEffective) ? bestEffective : null,
    bestGross: Number.isFinite(bestGross) ? bestGross : null,
    bestBonus,
  });

  if (bestRoute === null) {
    return failed("No valid route found after applying mandatory and forbidden rules.", k);
  }
  if (hasIllegalRepeats(bestRoute, startId)) {
    return failed("Best candidate repeats planets outside start re-entry rule.", k);
  }

  return {
    success: true,
    route: bestRoute,
    grossFuel: Math.round(bestGross * 1e6) / 1e6,
    bonusCollected: Math.round(bestBonus * 1e6) / 1e6,
    effectiveFuel: Math.round(bestEffective * 1e6) / 1e6,
    effectiveKUsed: k,
    errorMessage: null,
  };
}
