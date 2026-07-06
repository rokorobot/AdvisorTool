/**
 * Advisor policy — the heart of the credit-aware design.
 *
 * `classifyState` maps observable execution state (repeated test failures,
 * touched sensitive files, large diffs) to a trigger. `decideAdvisor` then
 * enforces the budget caps and picks the tier: Opus 4.8 by default, Fable 5
 * only for high-stakes triggers or an explicit hard escalation.
 */

import { POLICY } from "./config.js";
import type {
  AdvisorDecision,
  AdvisorTier,
  AdvisorTrigger,
  CodingState,
} from "./types.js";

/** Detect a policy trigger from current state, or null if none applies. */
export function classifyState(state: CodingState): AdvisorTrigger | null {
  if (state.failedTestAttempts >= POLICY.testFailEscalation) {
    return "tests_failed_twice";
  }
  const files = [...state.touchedFiles].map((f) => f.toLowerCase());
  const sensitive = files.some((f) =>
    POLICY.sensitivePathFragments.some((frag) => f.includes(frag))
  );
  if (sensitive) {
    const migration = files.some((f) => f.includes("migration"));
    return migration ? "database_or_migration" : "security_sensitive";
  }
  if (state.changedFileCount > POLICY.largeRefactorFileThreshold) {
    return "large_refactor";
  }
  return null;
}

/** Apply budget gates and select the advisor tier for a given trigger. */
export function decideAdvisor(
  state: CodingState,
  trigger: AdvisorTrigger,
  opts: { forceFable?: boolean } = {}
): AdvisorDecision {
  if (state.advisorCallsThisTask >= POLICY.maxAdvisorCallsPerTask) {
    return {
      call: false,
      tier: "opus",
      reason: "advisor_call_cap_reached",
      note: "Advisor call cap reached for this task — proceed with your best judgment.",
    };
  }
  if (
    POLICY.maxAdvisorSpendPerTask > 0 &&
    state.advisorSpendThisTask >= POLICY.maxAdvisorSpendPerTask
  ) {
    return {
      call: false,
      tier: "opus",
      reason: "advisor_budget_exhausted",
      note: "Advisor budget for this task is exhausted — proceed without further consults.",
    };
  }

  // Opus by default. Escalate to Fable for hard triggers, an explicit hard
  // flag, or when a repeat test failure persists after an Opus consult.
  let tier: AdvisorTier = "opus";
  const hardTrigger = POLICY.fableTriggers.has(trigger);
  const escalation =
    trigger === "tests_failed_twice" && state.lastAdvisorTier === "opus";
  if (opts.forceFable || hardTrigger || escalation) tier = "fable";

  return { call: true, tier, reason: trigger };
}
