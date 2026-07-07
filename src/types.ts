/** Shared types for the credit-aware coding router. */

export type AdvisorTrigger =
  | "architecture_change"
  | "complex_planning"
  | "tests_failed_twice"
  | "security_sensitive"
  | "database_or_migration"
  | "large_refactor"
  | "low_executor_confidence"
  | "user_requested_review";

/** Which advisor tier to purchase for a given consult. */
export type AdvisorTier = "opus" | "fable";

export interface AdvisorDecision {
  /** Whether to actually call the advisor. */
  call: boolean;
  /** The model tier to use if calling. */
  tier: AdvisorTier;
  /** Machine-readable reason (the trigger, or why it was skipped). */
  reason: string;
  /** Human-facing note returned to the executor when call === false. */
  note?: string;
}

/** Mutable per-task state the policy layer reasons over. */
export interface CodingState {
  taskId: string;
  task: string;
  touchedFiles: Set<string>;
  changedFileCount: number;
  failedTestAttempts: number;
  lastTestOutput: string | null;
  recentExecutorText: string[];
  advisorCallsThisTask: number;
  advisorSpendThisTask: number;
  lastAdvisorTier: AdvisorTier | null;
  /** Auto-triggers already consulted this task, to avoid re-consulting on the same condition. */
  autoConsulted: Set<string>;
}

/** One billed model call, appended to the cost ledger. */
export interface ModelCallRecord {
  timestamp: string;
  taskId: string;
  model: string;
  role: "executor" | "advisor";
  tier?: AdvisorTier;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedCost: number;
  triggerReason?: string;
  /** True when Fable 5 was selected but unreachable, so Opus 4.8 was billed instead. */
  fellBackFromFable?: boolean;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
