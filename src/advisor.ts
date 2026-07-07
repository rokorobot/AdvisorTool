/**
 * Advisor consult orchestration.
 *
 * Given a decision from the policy layer, build a compressed packet, call the
 * chosen model tier as a one-shot, and inject the advice back into the executor.
 * If Fable 5 is selected but unreachable (e.g. usage credits not enabled), we
 * downgrade to Opus 4.8 and record the fallback rather than failing the task.
 */

import { MODELS, LIMITS } from "./config.js";
import type { AdvisorDecision, CodingState, ModelCallRecord } from "./types.js";
import { buildAdvisorPacket } from "./contextCompressor.js";
import { callModel, isAccessError } from "./providers/anthropic.js";
import { CostLedger, estimateCost } from "./costLedger.js";

const ADVISOR_SYSTEM =
  "You are a senior engineering advisor consulted mid-task by a coding agent. " +
  "You receive a compressed packet: the task, the executor's recent actions, changed files, a truncated diff, and test output. " +
  "Give focused, high-leverage guidance — the single best next action and the reasoning, not a full essay. " +
  "If the packet is missing something you need to answer well, say exactly which file or output should be included next time. " +
  "Keep your answer under ~150 words.";

export interface ConsultResult {
  advice: string;
  tier: "opus" | "fable";
  model: string;
  cost: number;
  fellBackFromFable: boolean;
}

/**
 * Core consult: call the decided tier with a prebuilt packet, falling back
 * Fable→Opus on access errors, and record the spend. Shared by the CLI
 * executor loop and the MCP server.
 */
export async function consultWithPacket(args: {
  packet: string;
  decision: AdvisorDecision;
  taskId: string;
  ledger: CostLedger;
  onFallback?: () => void;
}): Promise<ConsultResult> {
  const { packet, decision, taskId, ledger, onFallback } = args;

  let model = decision.tier === "fable" ? MODELS.advisorHard : MODELS.advisorPrimary;
  let usedTier = decision.tier;
  let fellBackFromFable = false;

  let res;
  try {
    res = await callModel({
      model,
      system: ADVISOR_SYSTEM,
      messages: [{ role: "user", content: packet }],
      maxTokens: LIMITS.advisorMaxTokens,
    });
  } catch (err) {
    if (decision.tier === "fable" && isAccessError(err)) {
      model = MODELS.advisorPrimary;
      usedTier = "opus";
      fellBackFromFable = true;
      onFallback?.();
      res = await callModel({
        model,
        system: ADVISOR_SYSTEM,
        messages: [{ role: "user", content: packet }],
        maxTokens: LIMITS.advisorMaxTokens,
      });
    } else {
      throw err;
    }
  }

  const advice = res.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();

  const cost = estimateCost(model, res.usage);
  const rec: ModelCallRecord = {
    timestamp: new Date().toISOString(),
    taskId,
    model,
    role: "advisor",
    tier: usedTier,
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
    cacheReadTokens: res.usage?.cache_read_input_tokens ?? 0,
    estimatedCost: cost,
    triggerReason: decision.reason,
    fellBackFromFable,
  };
  ledger.record(rec);

  return {
    advice: advice || "(advisor returned no text)",
    tier: usedTier,
    model,
    cost,
    fellBackFromFable,
  };
}

export async function consultAdvisor(args: {
  state: CodingState;
  decision: AdvisorDecision;
  question: string;
  ledger: CostLedger;
}): Promise<string> {
  const { state, decision, question, ledger } = args;
  const packet = await buildAdvisorPacket(state, question);

  const result = await consultWithPacket({
    packet,
    decision,
    taskId: state.taskId,
    ledger,
    onFallback: () =>
      console.log("  advisor: Fable 5 not reachable — falling back to Opus 4.8."),
  });

  state.advisorCallsThisTask += 1;
  state.advisorSpendThisTask += result.cost;
  state.lastAdvisorTier = result.tier;

  return result.advice;
}
