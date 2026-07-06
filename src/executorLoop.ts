/**
 * Executor loop.
 *
 * Runs the Sonnet executor with the client tools plus request_advisor. Handles:
 *   - dispatching fs/bash tools and tracking their effects into CodingState
 *   - executor-initiated consults (request_advisor) routed through the policy
 *   - automatic policy-driven consults (repeated test failures, large refactor,
 *     sensitive files), injected back as a high-signal message
 *   - per-task cost reporting via the ledger
 */

import { randomUUID } from "node:crypto";
import { MODELS, LIMITS } from "./config.js";
import { EXECUTOR_SYSTEM } from "./systemPrompt.js";
import { CLIENT_TOOLS, REQUEST_ADVISOR_TOOL, dispatchTool } from "./tools.js";
import { callModel } from "./providers/anthropic.js";
import { CostLedger, estimateCost } from "./costLedger.js";
import { classifyState, decideAdvisor } from "./advisorPolicy.js";
import { consultAdvisor } from "./advisor.js";
import type {
  CodingState,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

function looksLikeTestFailure(output: string): boolean {
  const s = output.toLowerCase();
  const failish = /(^|\s)(fail|failed|failing|error|exception|assert|not ok|✗|✖)/.test(s);
  const cleanish = /\b0 (failed|failing|errors?)\b|all tests passed|passed, 0 failed/.test(s);
  return failish && !cleanish;
}

function summarize(input: Record<string, unknown>): string {
  if ("command" in input) return String(input.command).slice(0, 60);
  if ("path" in input) return String(input.path);
  return Object.keys(input).join(", ");
}

function newState(task: string): CodingState {
  return {
    taskId: randomUUID().slice(0, 8),
    task,
    touchedFiles: new Set(),
    changedFileCount: 0,
    failedTestAttempts: 0,
    lastTestOutput: null,
    recentExecutorText: [],
    advisorCallsThisTask: 0,
    advisorSpendThisTask: 0,
    lastAdvisorTier: null,
    autoConsulted: new Set(),
  };
}

function trackToolEffect(
  state: CodingState,
  use: ToolUseBlock,
  result: ToolResultBlock
): void {
  if ((use.name === "write_file" || use.name === "edit_file") && !result.is_error) {
    state.touchedFiles.add(String(use.input.path));
    state.changedFileCount = state.touchedFiles.size;
  }
  if (use.name === "run_bash") {
    state.lastTestOutput = result.content;
    const cmd = String(use.input.command).toLowerCase();
    const isTestCmd = /test|jest|vitest|pytest|mocha|go test|cargo test/.test(cmd);
    if (isTestCmd) {
      if (result.is_error || looksLikeTestFailure(result.content)) {
        state.failedTestAttempts += 1;
      } else {
        state.failedTestAttempts = 0;
      }
    }
  }
}

export async function runTask(
  sharedMessages: any[],
  task: string,
  ledger: CostLedger
): Promise<void> {
  const state = newState(task);
  sharedMessages.push({ role: "user", content: task });
  const tools = [REQUEST_ADVISOR_TOOL, ...CLIENT_TOOLS];

  for (let turn = 1; turn <= LIMITS.maxTurns; turn++) {
    const res = await callModel({
      model: MODELS.executor,
      system: EXECUTOR_SYSTEM,
      messages: sharedMessages,
      tools,
      maxTokens: LIMITS.executorMaxTokens,
    });

    ledger.record({
      timestamp: new Date().toISOString(),
      taskId: state.taskId,
      model: MODELS.executor,
      role: "executor",
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      cacheReadTokens: res.usage?.cache_read_input_tokens ?? 0,
      estimatedCost: estimateCost(MODELS.executor, res.usage),
    });

    sharedMessages.push({ role: "assistant", content: res.content });

    for (const b of res.content) {
      if (b.type === "text" && b.text.trim()) {
        console.log(`\n${b.text.trim()}`);
        state.recentExecutorText.push(b.text.trim());
      }
    }

    if (res.stopReason === "end_turn") break;

    if (res.stopReason === "tool_use") {
      const toolUses = res.content.filter((b: any) => b.type === "tool_use") as ToolUseBlock[];
      const results: ToolResultBlock[] = [];

      for (const use of toolUses) {
        if (use.name === "request_advisor") {
          const reason = String(use.input.reason ?? "low_executor_confidence");
          const question = String(use.input.question ?? "What should I do next?");
          const forceFable = Boolean(use.input.hard);
          const decision = decideAdvisor(
            state,
            forceFable ? "security_sensitive" : "low_executor_confidence",
            { forceFable }
          );

          let advice: string;
          if (!decision.call) {
            advice = decision.note ?? "Advisor unavailable — use your best judgment.";
            console.log(`  advisor: [skipped] ${advice}`);
          } else {
            console.log(`  … consulting advisor (${decision.tier}) — ${reason}`);
            advice = await consultAdvisor({ state, decision, question, ledger });
            console.log(`  advisor (${state.lastAdvisorTier}): ${advice}\n`);
          }
          results.push({ type: "tool_result", tool_use_id: use.id, content: advice });
          continue;
        }

        console.log(`  → ${use.name}(${summarize(use.input)})`);
        const result = await dispatchTool(use);
        results.push(result);
        trackToolEffect(state, use, result);
      }

      sharedMessages.push({ role: "user", content: results });

      // Automatic policy-driven consult, if a trigger fired this turn.
      const trigger = classifyState(state);
      if (trigger) {
        const alreadyDone =
          trigger !== "tests_failed_twice" && state.autoConsulted.has(trigger);
        if (!alreadyDone) {
          const decision = decideAdvisor(state, trigger);
          if (decision.call) {
            console.log(`  … auto-consulting advisor (${decision.tier}) — ${trigger}`);
            const advice = await consultAdvisor({
              state,
              decision,
              question: `Automatic review triggered by: ${trigger}. What is the single highest-priority correction before continuing?`,
              ledger,
            });
            console.log(`  advisor (${state.lastAdvisorTier}): ${advice}\n`);
            sharedMessages.push({
              role: "user",
              content: `[Advisor review — ${trigger}]\n${advice}`,
            });
            state.autoConsulted.add(trigger);
            // Clear the failure counter so we don't re-consult on the same failures.
            if (trigger === "tests_failed_twice") state.failedTestAttempts = 0;
          }
        }
      }
      continue;
    }

    console.log(`\n[executor stopped: ${res.stopReason}]`);
    break;
  }

  printSummary(ledger, state.taskId);
}

function printSummary(ledger: CostLedger, taskId: string): void {
  const s = ledger.taskSummary(taskId);
  console.log("\n─── task usage ───");
  console.log(
    `  executor calls: ${s.executorCalls}   advisor calls: ${s.advisorCalls} (opus ${s.byTier.opus}, fable ${s.byTier.fable})`
  );
  console.log(`  executor cost:  $${s.executorCost.toFixed(4)}`);
  console.log(`  advisor cost:   $${s.advisorCost.toFixed(4)}`);
  console.log(
    `  total:          $${s.totalCost.toFixed(4)}   (upper-model share ${(s.upperModelShare * 100).toFixed(1)}%)`
  );
  console.log("──────────────────");
}
