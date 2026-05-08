/** Default when caller omits requestedK; keep aligned with typical ladder top. */
export const DEFAULT_REQUESTED_K = 80;

export function effectiveKByKeyNodes(requestedK: number, keyNodesCount: number): number {
  const safeRequested = Math.max(1, Math.floor(requestedK));
  const cap =
    keyNodesCount <= 4 ? 80 :
    keyNodesCount <= 6 ? 45 :
    keyNodesCount <= 8 ? 45 :
    24;

  return Math.min(safeRequested, cap);
}
