export const DEFAULT_REQUESTED_K = 50;

export function effectiveKByKeyNodes(requestedK: number, keyNodesCount: number): number {
  const safeRequested = Math.max(1, Math.floor(requestedK));
  const cap =
    keyNodesCount <= 4 ? 50 :
    keyNodesCount <= 6 ? 35 :
    keyNodesCount <= 8 ? 35 :
    20;

  return Math.min(safeRequested, cap);
}
