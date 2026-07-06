/**
 * Route planner — the `route` subcommand / `--dry-run` flag.
 *
 * Shows how a task WOULD be routed without spending anything: which model the
 * executor uses, the default advisor tier, whether the risk signals in the task
 * would escalate to Fable 5, the estimated advisor packet size, and an estimated
 * cost ceiling. It runs no model calls — the numbers are derived from the policy
 * and price table in src/config.ts, so treat the cost as an upper-bound estimate.
 */

import { MODELS, PRICING, POLICY, LIMITS } from "./config.js";
import type { AdvisorTrigger } from "./types.js";

/** ~4 chars per token is close enough for a planning estimate. */
function toTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

interface DetectedRisk {
  fragment: string;
  trigger: AdvisorTrigger;
}

/** Scan the task text for sensitive path fragments that would route to Fable. */
export function detectRisks(task: string): DetectedRisk[] {
  const lower = task.toLowerCase();
  const risks: DetectedRisk[] = [];
  for (const frag of POLICY.sensitivePathFragments) {
    if (lower.includes(frag)) {
      const trigger: AdvisorTrigger =
        frag === "migration" ? "database_or_migration" : "security_sensitive";
      risks.push({ fragment: frag, trigger });
    }
  }
  return risks;
}

/**
 * Estimate advisor packet size. At plan time nothing has executed, so the low
 * end is task + scaffolding; the high end reflects the compressor's own caps
 * (truncated diff, up to 4 file excerpts, recent notes, test output).
 */
function estimatePacket(task: string): { minTokens: number; maxTokens: number } {
  const scaffoldChars = 500; // packet headers + question
  const minChars = task.length + scaffoldChars;
  const maxChars =
    scaffoldChars +
    task.length +
    6000 + // truncated git diff
    4 * 2500 + // up to 4 file excerpts
    1500 + // recent executor notes
    2500; // latest test output
  return { minTokens: toTokens(minChars), maxTokens: toTokens(maxChars) };
}

function money(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** Estimated cost of one advisor consult at a given model, given packet input. */
function consultCost(model: string, packetInputTokens: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (
    (packetInputTokens / 1e6) * p.input +
    (LIMITS.advisorMaxTokens / 1e6) * p.output
  );
}

export function planRoute(task: string): string {
  const risks = detectRisks(task);
  const uniqueTriggers = [...new Set(risks.map((r) => r.trigger))];
  const fableWouldFire = uniqueTriggers.some((t) => POLICY.fableTriggers.has(t));
  const packet = estimatePacket(task);

  // Cost ceiling: the tool hard-caps advisor spend; the executor is only capped
  // by turn count, so we estimate it and label it as rough.
  const consultModel = fableWouldFire
    ? MODELS.advisorHard
    : MODELS.advisorPrimary;
  const perConsult = consultCost(consultModel, packet.maxTokens);
  const advisorCallCeiling = perConsult * POLICY.maxAdvisorCallsPerTask;
  const advisorHardCap =
    POLICY.maxAdvisorSpendPerTask > 0
      ? Math.min(advisorCallCeiling, POLICY.maxAdvisorSpendPerTask)
      : advisorCallCeiling;

  // Rough executor ceiling: maxTurns × (typical input + max output) at Sonnet.
  const execP = PRICING[MODELS.executor];
  const execRoughInputPerTurn = 6000; // grows with the transcript; rough midpoint
  const execRough =
    execP
      ? LIMITS.maxTurns *
        ((execRoughInputPerTurn / 1e6) * execP.input +
          (LIMITS.executorMaxTokens / 1e6) * execP.output)
      : 0;

  const lines: string[] = [];
  lines.push("Adviser Tool — route plan (dry run, no spend)");
  lines.push(`  task: ${task.length > 80 ? task.slice(0, 80) + "…" : task}`);
  lines.push("");
  lines.push(`  executor model:   ${MODELS.executor}`);
  lines.push(`  advisor default:  ${MODELS.advisorPrimary} (Opus tier)`);
  lines.push(
    `  Fable allowed:    ${fableWouldFire ? "yes — a detected risk trigger routes to Fable 5" : "no — Opus tier unless request_advisor(hard=true)"}`
  );
  lines.push("");

  if (risks.length) {
    lines.push("  risk triggers detected in task text:");
    for (const r of risks) {
      lines.push(`    • "${r.fragment}" → ${r.trigger}`);
    }
  } else {
    lines.push("  risk triggers detected in task text: none");
    lines.push(
      "    (auto-triggers still fire at runtime from touched files, large diffs, repeated test failures)"
    );
  }
  lines.push("");

  lines.push(
    `  estimated advisor packet:  ~${packet.minTokens}–${packet.maxTokens} tokens`
  );
  lines.push(
    `    (vs. full-transcript forwarding — the packet is the ~10–20× input saving)`
  );
  lines.push("");

  lines.push("  estimated cost ceiling (upper bound, not a quote):");
  lines.push(
    `    advisor:  ${money(advisorHardCap)}  (≤ ${POLICY.maxAdvisorCallsPerTask} consults @ ~${money(perConsult)} on ${consultModel}` +
      (POLICY.maxAdvisorSpendPerTask > 0
        ? `, hard cap ${money(POLICY.maxAdvisorSpendPerTask)})`
        : `, no dollar cap)`)
  );
  lines.push(
    `    executor: ~${money(execRough)}  (rough: ≤ ${LIMITS.maxTurns} turns on ${MODELS.executor})`
  );
  lines.push(
    `    total:    ~${money(advisorHardCap + execRough)}  (estimate — verify prices at platform.claude.com)`
  );

  return lines.join("\n");
}
