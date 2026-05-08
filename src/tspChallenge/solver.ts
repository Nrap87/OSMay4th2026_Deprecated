import {
  SolverMaxBonusPlanets,
  TspAggressiveDefaultMaxPermutations,
  TspAggressiveSearch,
  TspCheapStitchBeforeDfs,
  TspHeuristicOrdersFirst,
  TspInnerExpandedNodeBudget,
  TspMaxPermutationsPerSubset,
  TspSkipDfsWhenCheapStitchSucceeds,
} from "../config.js";
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

/** Packed directed edge key for `Set<number>` (planet ids are < edgeMul in practice). */
function packDirectedEdge(fromPlanetId: number, toPlanetId: number, edgeMul: number): number {
  return fromPlanetId * edgeMul + toPlanetId;
}

/** Precomputed complete-graph leg costs + reusable Dijkstra scratch (hot path). */
type TspGeometricGraph = {
  n: number;
  edgeMul: number;
  idToIdx: Map<number, number>;
  idxToId: number[];
  cost: Float64Array;
  scratch: {
    dist: Float64Array;
    prev: Int32Array;
    blocked: Uint8Array;
    pq: MinPriorityQueue<number>;
  };
};

const EMPTY_FORBIDDEN_EDGES = new Set<number>();

function buildTspGeometricGraph(
  planetsById: Map<number, PlanetNode>,
  mainSet: Set<string>,
  otherSet: Set<string>,
): TspGeometricGraph {
  const ids = [...planetsById.keys()].sort((a, b) => a - b);
  const n = ids.length;
  let maxId = 0;
  for (const id of ids) {
    if (id > maxId) maxId = id;
  }
  const edgeMul = maxId + 1;

  const idToIdx = new Map<number, number>();
  const idxToId = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    idToIdx.set(ids[i]!, i);
    idxToId[i] = ids[i]!;
  }

  const cost = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    cost[i * n + i] = 0;
    const idi = ids[i]!;
    const pi = planetsById.get(idi)!;
    for (let j = i + 1; j < n; j++) {
      const idj = ids[j]!;
      const pj = planetsById.get(idj)!;
      const dx = pi.x - pj.x;
      const dy = pi.y - pj.y;
      const base = Math.sqrt(dx * dx + dy * dy);
      const undirectedKey = edgeKey(idi, idj);
      let w = base;
      if (mainSet.has(undirectedKey)) w = 0.5 * base;
      else if (otherSet.has(undirectedKey)) w = (2 / 3) * base;
      cost[i * n + j] = w;
      cost[j * n + i] = w;
    }
  }

  return {
    n,
    edgeMul,
    idToIdx,
    idxToId,
    cost,
    scratch: {
      dist: new Float64Array(n),
      prev: new Int32Array(n),
      blocked: new Uint8Array(n),
      pq: new MinPriorityQueue<number>(),
    },
  };
}

function dijkstraOnGraph(
  g: TspGeometricGraph,
  source: number,
  target: number,
  forbiddenNodes: Set<number>,
  forbiddenEdges: Set<number>,
): PathCandidate | null {
  if (source === target) return { cost: 0, path: [source] };
  if (forbiddenNodes.has(source) || forbiddenNodes.has(target)) return null;

  const srcIdx = g.idToIdx.get(source);
  const tgtIdx = g.idToIdx.get(target);
  if (srcIdx === undefined || tgtIdx === undefined) return null;

  const { n, idxToId, cost, edgeMul, scratch } = g;
  const dist = scratch.dist;
  const prev = scratch.prev;
  const blocked = scratch.blocked;
  const pq = scratch.pq;

  dist.fill(Number.POSITIVE_INFINITY);
  prev.fill(-1);
  blocked.fill(0);
  for (const pid of forbiddenNodes) {
    const ix = g.idToIdx.get(pid);
    if (ix !== undefined) blocked[ix] = 1;
  }

  pq.clear();
  dist[srcIdx] = 0;
  pq.enqueue(srcIdx, 0);

  for (;;) {
    const next = pq.tryDequeue();
    if (next === undefined) break;
    const u = next.value;
    const du = next.priority;
    if (du > dist[u]) continue;
    if (u === tgtIdx) break;

    const idU = idxToId[u]!;
    const row = u * n;
    for (let v = 0; v < n; v++) {
      if (v === u || blocked[v]) continue;
      const idV = idxToId[v]!;
      if (forbiddenEdges.has(packDirectedEdge(idU, idV, edgeMul))) continue;
      const cand = du + cost[row + v]!;
      if (cand < dist[v]!) {
        dist[v] = cand;
        prev[v] = u;
        pq.enqueue(v, cand);
      }
    }
  }

  if (!Number.isFinite(dist[tgtIdx]!)) return null;

  const pathIds: number[] = [];
  let cur = tgtIdx;
  while (cur !== srcIdx) {
    pathIds.push(idxToId[cur]!);
    cur = prev[cur]!;
  }
  pathIds.push(idxToId[srcIdx]!);
  pathIds.reverse();
  return { cost: dist[tgtIdx]!, path: pathIds };
}

function pathsPrefixEqual(path: readonly number[], prefix: readonly number[]): boolean {
  if (path.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (path[i] !== prefix[i]) return false;
  }
  return true;
}

function pathCostOnGraph(g: TspGeometricGraph, path: readonly number[]): number {
  let total = 0;
  const { idToIdx, cost, n } = g;
  for (let i = 0; i < path.length - 1; i++) {
    const ia = idToIdx.get(path[i]!);
    const ib = idToIdx.get(path[i + 1]!);
    if (ia === undefined || ib === undefined) return Number.POSITIVE_INFINITY;
    total += cost[ia * n + ib]!;
  }
  return total;
}

/** Mutable Yen state for lazy extension (one increment adds the next shortest path). */
type YenIncrementalState = {
  accepted: PathCandidate[];
  candidates: MinPriorityQueue<PathCandidate>;
  seenKeys: Set<string>;
};

function yenInitState(
  g: TspGeometricGraph,
  source: number,
  target: number,
  forbiddenNodes: Set<number>,
  firstPathHint?: PathCandidate,
): YenIncrementalState | null {
  const first =
    firstPathHint ?? dijkstraOnGraph(g, source, target, forbiddenNodes, EMPTY_FORBIDDEN_EDGES);
  if (first === null) return null;
  return {
    accepted: [first],
    candidates: new MinPriorityQueue<PathCandidate>(),
    seenKeys: new Set<string>(),
  };
}

/**
 * Append one more simple path (next shortest under Yen's construction) if it exists.
 * `maxPaths` caps total accepted paths including the first.
 */
function yenAppendNext(
  state: YenIncrementalState,
  g: TspGeometricGraph,
  target: number,
  forbiddenNodes: Set<number>,
  maxPaths: number,
): boolean {
  if (state.accepted.length >= maxPaths) return false;

  const { edgeMul } = g;
  const previous = state.accepted[state.accepted.length - 1]!.path;

  for (let i = 0; i < previous.length - 1; i++) {
    const spurNode = previous[i]!;
    const rootPath = previous.slice(0, i + 1);

    const localForbiddenEdges = new Set<number>();
    for (const acceptedPath of state.accepted) {
      if (acceptedPath.path.length <= i) continue;
      if (pathsPrefixEqual(acceptedPath.path, rootPath)) {
        const a = acceptedPath.path[i]!;
        const b = acceptedPath.path[i + 1]!;
        localForbiddenEdges.add(packDirectedEdge(a, b, edgeMul));
        localForbiddenEdges.add(packDirectedEdge(b, a, edgeMul));
      }
    }

    const localForbiddenNodes = new Set<number>(forbiddenNodes);
    for (let rootIndex = 0; rootIndex < rootPath.length - 1; rootIndex++) {
      localForbiddenNodes.add(rootPath[rootIndex]!);
    }

    const spurPath = dijkstraOnGraph(g, spurNode, target, localForbiddenNodes, localForbiddenEdges);
    if (spurPath === null) continue;

    const totalPath = rootPath.slice(0, -1).concat(spurPath.path);
    const key = totalPath.join(">");
    if (state.seenKeys.has(key)) continue;
    state.seenKeys.add(key);

    const pathCostVal = pathCostOnGraph(g, totalPath);
    state.candidates.enqueue({ cost: pathCostVal, path: totalPath }, pathCostVal);
  }

  const nextCandidate = state.candidates.tryDequeue();
  if (nextCandidate === undefined) return false;
  state.accepted.push(nextCandidate.value);
  return true;
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
/** Disjoint stitch using only KSP index 0 per segment (single shortest path per leg). */
function tryCheapStitchDisjointOnly(
  sequence: readonly number[],
  getKspPathAt: (from: number, to: number, pathIndex: number) => PathCandidate | null,
): { path: number[]; gross: number } | null {
  return tryStitchDisjointFromSequence(sequence, (from, to, idx) =>
    idx === 0 ? getKspPathAt(from, to, 0) : null,
  );
}

function tryStitchDisjointFromSequence(
  sequence: readonly number[],
  getKspPathAt: (from: number, to: number, pathIndex: number) => PathCandidate | null,
): { path: number[]; gross: number } | null {
  const origin = sequence[0]!;
  const visited = new Set<number>([origin]);
  let path: number[] = [origin];
  let gross = 0;

  for (let segIdx = 0; segIdx < sequence.length - 1; segIdx++) {
    const from = sequence[segIdx]!;
    const to = sequence[segIdx + 1]!;
    const isLast = segIdx === sequence.length - 2;
    let picked: PathCandidate | null = null;

    for (let pathIndex = 0; ; pathIndex++) {
      const candidate = getKspPathAt(from, to, pathIndex);
      if (candidate === null) break;
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

/** Nearest-neighbor visit order over a set of key planets from `startId` (shortest-leg greedy). */
function greedyKeyVisitOrder(
  startId: number,
  keys: readonly number[],
  firstLeg: (from: number, to: number) => PathCandidate | null,
): number[] {
  const remaining = new Set(keys);
  const order: number[] = [];
  let current = startId;

  while (remaining.size > 0) {
    let bestNext: number | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const cand of remaining) {
      const leg = firstLeg(current, cand);
      if (leg === null) continue;
      const cheapest = leg.cost;
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

  return order.length === keys.length ? order : [];
}

/** Nearest-neighbor order over mandatory keys using cheapest KSP edge cost from current position. */
function greedyMandatoryVisitOrder(
  startId: number,
  mandatory: readonly number[],
  firstLeg: (from: number, to: number) => PathCandidate | null,
): number[] {
  return greedyKeyVisitOrder(startId, mandatory, firstLeg);
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

  if (validBonuses.length > SolverMaxBonusPlanets) {
    return failed(
      `Too many bonus planets (${validBonuses.length}); maximum supported is ${SolverMaxBonusPlanets}.`,
      k,
    );
  }

  const maxPermsAfterSort =
    TspMaxPermutationsPerSubset > 0
      ? TspMaxPermutationsPerSubset
      : TspAggressiveSearch
        ? TspAggressiveDefaultMaxPermutations
        : 0;

  const tryHeuristicPermsFirst = TspAggressiveSearch || TspHeuristicOrdersFirst;
  const skipDfsWhenCheapSucceeds = TspAggressiveSearch || TspSkipDfsWhenCheapStitchSucceeds;

  debugTspLog("solve-start", {
    startId,
    mandatoryCount: mandatory.length,
    validBonusCount: validBonuses.length,
    forbiddenCount: forbidden.size,
    keyNodeCount: keyNodeIds.length,
    requestedK,
    effectiveKUsed: k,
    tspAggressiveSearch: TspAggressiveSearch,
    maxPermsAfterSort: maxPermsAfterSort || null,
    tryHeuristicPermsFirst,
    skipDfsWhenCheapSucceeds,
  });

  const { mainSet, otherSet } = buildDiscountSets(input.routes);
  const g = buildTspGeometricGraph(planetsById, mainSet, otherSet);
  const pairKey = (a: number, b: number): string => `${a}-${b}`;
  const firstLegMemo = new Map<string, PathCandidate | null>();
  type LazyKspEntry = { yenState: YenIncrementalState | null };
  const lazyKspMemo = new Map<string, LazyKspEntry>();

  function memoFirstLeg(from: number, to: number): PathCandidate | null {
    const key = pairKey(from, to);
    if (firstLegMemo.has(key)) return firstLegMemo.get(key)!;
    const p = dijkstraOnGraph(g, from, to, forbidden, EMPTY_FORBIDDEN_EDGES);
    firstLegMemo.set(key, p);
    return p;
  }

  /** Lazily extends Yen's paths only as far as `pathIndex` requires (cap `k`). */
  function getKspPathAt(from: number, to: number, pathIndex: number): PathCandidate | null {
    if (pathIndex >= k) return null;
    const key = pairKey(from, to);
    let entry = lazyKspMemo.get(key);
    if (entry === undefined) {
      let hint: PathCandidate | undefined;
      if (firstLegMemo.has(key)) {
        const fl = firstLegMemo.get(key)!;
        if (fl === null) {
          lazyKspMemo.set(key, { yenState: null });
          return null;
        }
        hint = fl;
      }

      const state = yenInitState(g, from, to, forbidden, hint);
      if (state === null) {
        lazyKspMemo.set(key, { yenState: null });
        if (!firstLegMemo.has(key)) firstLegMemo.set(key, null);
        return null;
      }

      entry = { yenState: state };
      lazyKspMemo.set(key, entry);
      if (!firstLegMemo.has(key)) {
        firstLegMemo.set(key, state.accepted[0]!);
      }
    }

    if (entry.yenState === null) return null;

    const state = entry.yenState;
    while (pathIndex >= state.accepted.length && state.accepted.length < k) {
      if (!yenAppendNext(state, g, to, forbidden, k)) break;
    }

    return state.accepted[pathIndex] ?? null;
  }

  let innerSearchAborted = false;
  const reachabilityCore = [startId, ...mandatory];
  for (const from of reachabilityCore) {
    for (const to of reachabilityCore) {
      if (from === to) continue;
      if (memoFirstLeg(from, to) === null) {
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
    pruneInnerBudgetAbort: 0,
    cheapStitchHits: 0,
    cheapStitchSkippedDfs: 0,
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
    if (TspInnerExpandedNodeBudget > 0 && searchCounters.expandedNodes >= TspInnerExpandedNodeBudget) {
      searchCounters.pruneInnerBudgetAbort++;
      innerSearchAborted = true;
      return;
    }
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
    const isLast = idx === segments.length - 1;

    let sawCandidate = false;
    for (let pathIndex = 0; ; pathIndex++) {
      const candidate = getKspPathAt(segment.from, segment.to, pathIndex);
      if (candidate === null) break;
      sawCandidate = true;
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

    if (!sawCandidate) {
      searchCounters.pruneNoCandidates++;
    }
  };

  const runStitchedSearchForPermutation = (
    sequence: readonly number[],
    segments: Segment[],
    bonusCredit: number,
    traceLabel: string,
  ): void => {
    currentTraceLabel = traceLabel;
    let skipDfs = false;
    if (TspCheapStitchBeforeDfs) {
      const cheap = tryCheapStitchDisjointOnly(sequence, getKspPathAt);
      if (cheap !== null && !hasIllegalRepeats(cheap.path, startId)) {
        searchCounters.cheapStitchHits++;
        const effective = cheap.gross - bonusCredit;
        if (strictlyBetter(effective, cheap.gross, bestEffective, bestGross)) {
          searchCounters.bestUpdates++;
          bestEffective = effective;
          bestGross = cheap.gross;
          bestBonus = bonusCredit;
          bestRoute = [...cheap.path];
          debugTspLog("cheap-stitch-hit", {
            trace: traceLabel,
            bestEffective,
            bestGross,
            bonusCredit,
          });
        }
        if (skipDfsWhenCheapSucceeds) {
          searchCounters.cheapStitchSkippedDfs++;
          skipDfs = true;
        }
      }
    }
    if (!skipDfs) {
      dfsDisjoint(segments, 0, new Set<number>([startId]), 0, [startId], bonusCredit);
    }
  };

  const runOnePermutationPipeline = (
    permutation: readonly number[],
    subset: readonly BonusStop[],
    subsetIndex: number,
    permutationIndex: number,
    bonusCredit: number,
  ): void => {
    const sequence = [startId, ...permutation, startId];
    let optimisticGross = 0;
    let missingEdge = false;
    for (let index = 0; index < sequence.length - 1; index++) {
      const leg = memoFirstLeg(sequence[index]!, sequence[index + 1]!);
      if (leg === null) {
        missingEdge = true;
        break;
      }
      optimisticGross += leg.cost;
    }
    if (missingEdge) {
      searchCounters.prunePermutationBound++;
      return;
    }
    const optimisticEffective = optimisticGross - bonusCredit;
    if (optimisticEffective >= bestEffective - EPSILON) {
      searchCounters.prunePermutationBound++;
      return;
    }
    const segments: Segment[] = [];
    for (let index = 0; index < sequence.length - 1; index++) {
      segments.push({ from: sequence[index]!, to: sequence[index + 1]! });
    }
    const traceLabel = `subset#${subsetIndex} bonus=[${subset.map((b) => b.planetId).join(",") || "none"}] perm#${permutationIndex}`;
    runStitchedSearchForPermutation(sequence, segments, bonusCredit, traceLabel);
  };

  if (mandatory.length > 0) {
    const nnOrder = greedyMandatoryVisitOrder(startId, mandatory, memoFirstLeg);
    if (nnOrder.length === mandatory.length) {
      const seedSequence = [startId, ...nnOrder, startId];
      const stitched = tryStitchDisjointFromSequence(seedSequence, getKspPathAt);
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
  subsetLoop: for (const subset of bonusSubsetsBySize(validBonuses)) {
    subsetIndex++;
    if (innerSearchAborted) break subsetLoop;
    const bonusCredit = subset.reduce((sum, bonus) => sum + bonus.value, 0);
    if (-bonusCredit >= bestEffective - EPSILON) {
      searchCounters.pruneSubsetBonusBound++;
      continue;
    }
    const forcedStops = [...new Set([...mandatory, ...subset.map((bonus) => bonus.planetId)])];

    const mergedPermutations: number[][] = [];
    const permKeySeen = new Set<string>();
    const pushUniquePerm = (perm: number[]): void => {
      if (perm.length !== forcedStops.length) return;
      const pk = perm.join("\0");
      if (permKeySeen.has(pk)) return;
      permKeySeen.add(pk);
      mergedPermutations.push(perm);
    };

    if (tryHeuristicPermsFirst) {
      const nn = greedyKeyVisitOrder(startId, forcedStops, memoFirstLeg);
      if (nn.length === forcedStops.length) {
        pushUniquePerm(nn);
        pushUniquePerm([...nn].reverse());
      }
    }

    const slotLimit = maxPermsAfterSort > 0 ? maxPermsAfterSort : 10_000_000;

    if (forcedStops.length <= PERMUTATION_SORT_MAX_STOPS) {
      const sortedPermutations = collectAllPermutations(forcedStops);
      sortPermutationsByEuclideanLb(sortedPermutations, planetsById, startId, bonusCredit);
      const room = Math.max(0, slotLimit - mergedPermutations.length);
      const capped = maxPermsAfterSort > 0 ? sortedPermutations.slice(0, room) : sortedPermutations.slice();
      for (const p of capped) pushUniquePerm(p);
    } else {
      for (const permutation of permutations(forcedStops)) {
        if (mergedPermutations.length >= slotLimit) break;
        pushUniquePerm(permutation);
      }
    }

    let permutationIndex = 0;
    for (const permutation of mergedPermutations) {
      permutationIndex++;
      runOnePermutationPipeline(permutation, subset, subsetIndex, permutationIndex, bonusCredit);
      if (innerSearchAborted) break subsetLoop;
    }
  }

  debugTspLog("ksp-lazy-summary", {
    directedPairsFirstLegMemo: firstLegMemo.size,
    directedPairsLazyKspMemo: lazyKspMemo.size,
    possibleDirectedKeyPairs: keyNodeIds.length * (keyNodeIds.length - 1),
  });

  debugTspLog("search-summary", {
    ...searchCounters,
    bestFound: bestRoute !== null,
    bestEffective: Number.isFinite(bestEffective) ? bestEffective : null,
    bestGross: Number.isFinite(bestGross) ? bestGross : null,
    bestBonus,
  });

  if (bestRoute === null) {
    const base = "No valid route found after applying mandatory and forbidden rules.";
    const suffix =
      innerSearchAborted && TspInnerExpandedNodeBudget > 0
        ? ` (Inner search expanded-node budget ${TspInnerExpandedNodeBudget} exceeded; increase TspInnerExpandedNodeBudget in config if appropriate.)`
        : "";
    return failed(`${base}${suffix}`, k);
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
