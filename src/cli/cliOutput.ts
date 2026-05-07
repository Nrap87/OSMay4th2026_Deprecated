/** Skip stdout when `quiet` (use `console.error` at call sites for failures). */
export function out(quiet: boolean, ...args: Parameters<typeof console.log>): void {
  if (!quiet) console.log(...args);
}

/** One-line wall-clock summary when running with `--quiet` (always uses `console.log`). */
export function logQuietRunTotal(quiet: boolean, runStartedAt: number, scope: string): void {
  if (!quiet) return;
  const ms = Date.now() - runStartedAt;
  console.log(`Total elapsed: ${ms}ms (${scope})`);
}
