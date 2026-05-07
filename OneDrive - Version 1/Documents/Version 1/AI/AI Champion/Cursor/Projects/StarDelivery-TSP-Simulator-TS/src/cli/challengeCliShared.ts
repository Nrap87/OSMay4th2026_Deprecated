import type { SubmissionResult } from "../starDeliveryApi.js";
import type { ChallengeOut, PlanetOut, SolverResult } from "../types.js";

export function fmtNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "NaN";
}

export function formatRouteNames(route: readonly number[], planetsById: Map<number, PlanetOut>): string {
  return route.map((id) => planetsById.get(id)?.name ?? String(id)).join(" -> ");
}

export function challengeLabel(challenge: ChallengeOut): string {
  return challenge.challengeName?.trim() ? challenge.challengeName : `Challenge ${challenge.challengeId}`;
}

export function levelLabel(challenge: ChallengeOut): string {
  return challenge.level?.trim() ? challenge.level : "undefined";
}

export function printSubmitDetail(
  challenge: ChallengeOut,
  result: SolverResult,
  calculateResult: SubmissionResult | null,
  submitResult: SubmissionResult | null,
  restError: string | null,
  planetsById: Map<number, PlanetOut>,
  options?: { quiet?: boolean },
): void {
  if (options?.quiet) return;
  console.log(`[${levelLabel(challenge)}] ${challengeLabel(challenge)}`);
  if (!result.success || result.route === null) {
    console.log(`  Solver failed: ${result.errorMessage ?? "Unknown error"}`);
    console.log(`  Effective K (last ladder attempt): ${fmtNumber(result.effectiveKUsed)}`);
    console.log("");
    return;
  }

  console.log(`  Effective K used : ${fmtNumber(result.effectiveKUsed)}`);
  console.log(`  Effective fuel : ${fmtNumber(result.effectiveFuel)}`);
  console.log(`  Gross fuel     : ${fmtNumber(result.grossFuel)}`);
  console.log(`  Bonus collected: ${fmtNumber(result.bonusCollected)}`);
  console.log(`  Route (${result.route.length} planets): ${formatRouteNames(result.route, planetsById)}`);
  if (calculateResult) {
    console.log(
      `  CalculateCoaxium: isSuccess=${calculateResult.isSuccess}; coaxium=${calculateResult.coaxium}; ${calculateResult.feedbackMessage}`,
    );
  } else {
    console.log("  CalculateCoaxium: not executed");
  }
  if (submitResult) {
    console.log(
      `  SubmitChallengeSolution: isSuccess=${submitResult.isSuccess}; coaxium=${submitResult.coaxium}; ${submitResult.feedbackMessage}`,
    );
  } else if (restError) {
    console.log(`  SubmitChallengeSolution: error (${restError})`);
  } else {
    console.log("  SubmitChallengeSolution: not executed");
  }
  console.log("");
}
