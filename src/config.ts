/**
 * Central configuration.
 *
 * The router calls the executor for most work and only escalates to an advisor
 * model when the policy layer allows it. Opus 4.8 is the default advisor; Fable
 * 5 is reserved for genuinely high-stakes consults (it costs ~2x Opus).
 */

import type { AdvisorTrigger } from "./types.js";

export const MODELS = {
  /** Does the bulk of the work. */
  executor: "claude-sonnet-5",
  /** Default advisor tier. */
  advisorPrimary: "claude-opus-4-8",
  /** High-stakes advisor tier (opt-in via policy or hard=true). */
  advisorHard: "claude-fable-5",
};

/**
 * Prices are USD per million tokens. These are estimates compiled from public
 * pricing around July 2026 and are meant to be edited — verify the current rate
 * card at https://platform.claude.com/ before trusting the cost report.
 */
export const PRICING: Record<
  string,
  { input: number; output: number; cacheRead: number }
> = {
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1.0 },
};

export const POLICY = {
  /** Hard cap on advisor consults per task. */
  maxAdvisorCallsPerTask: 3,
  /** Dollar cap on advisor spend per task (0 = unlimited). */
  maxAdvisorSpendPerTask: 0.75,
  /** A change touching more than this many files is a "large refactor". */
  largeRefactorFileThreshold: 8,
  /** Number of failed test runs that auto-triggers a consult. */
  testFailEscalation: 2,
  /** Triggers that justify the pricier Fable tier instead of Opus. */
  fableTriggers: new Set<AdvisorTrigger>([
    "security_sensitive",
    "database_or_migration",
    "complex_planning",
  ]),
  /** Path fragments that mark a change as security/data sensitive. */
  sensitivePathFragments: [
    "auth",
    "payment",
    "billing",
    "crypto",
    "password",
    "secret",
    "token",
    "migration",
  ],
};

export const LIMITS = {
  maxTurns: 40,
  executorMaxTokens: 8192,
  advisorMaxTokens: 1536,
  bashTimeoutMs: 120_000,
};

export const CONFIG = {
  /** Directory the agent may read/write within. */
  workspaceRoot: process.cwd(),
  /** Confirm before state-changing tools (write/edit/bash). Recommended. */
  confirmMutations: true,
  /** Where the cost ledger is appended (relative to workspaceRoot). */
  ledgerPath: ".advisor-coder/ledger.jsonl",
};

/** Settings for the MCP server (`npm run mcp` / dist/mcp.js). */
export const MCP = {
  /**
   * Rolling cap on advisor spend per calendar day across ALL consults through
   * the MCP server (0 = unlimited). A backstop so an IDE agent can't run away.
   */
  dailySpendCap: 5.0,
  /** Task id used to group consults when the caller doesn't supply one. */
  defaultTaskId: "adhoc",
};

export function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key."
    );
  }
  return key;
}
