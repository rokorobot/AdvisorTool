/**
 * Cost ledger.
 *
 * Records every billed model call (executor and advisor) with tokens, model,
 * tier, trigger, and an estimated dollar cost. Records are kept in memory for
 * the per-task summary and appended to a JSONL file so you can audit upper-model
 * spend share over time. Nobody can "pretend" work was upper-model — the log
 * shows exactly which model ran, why, and what it cost.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { PRICING } from "./config.js";
import type { ModelCallRecord } from "./types.js";

export function estimateCost(model: string, usage: any): number {
  const p = PRICING[model];
  if (!p) return 0;
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  return (
    (input / 1e6) * p.input +
    (output / 1e6) * p.output +
    (cacheRead / 1e6) * p.cacheRead
  );
}

export class CostLedger {
  private records: ModelCallRecord[] = [];

  constructor(private ledgerPath: string) {}

  record(rec: ModelCallRecord): void {
    this.records.push(rec);
  }

  /**
   * Append everything recorded since the last persist to the JSONL file.
   * Clears the pending buffer afterwards so records are never written twice.
   */
  async persist(): Promise<void> {
    if (this.records.length === 0) return;
    await fs.mkdir(path.dirname(this.ledgerPath), { recursive: true });
    const lines = this.records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await fs.appendFile(this.ledgerPath, lines, "utf8");
    this.records = [];
  }

  taskSummary(taskId: string) {
    const recs = this.records.filter((r) => r.taskId === taskId);
    const exec = recs.filter((r) => r.role === "executor");
    const adv = recs.filter((r) => r.role === "advisor");
    const sum = (rs: ModelCallRecord[]) =>
      rs.reduce((a, r) => a + r.estimatedCost, 0);
    const executorCost = sum(exec);
    const advisorCost = sum(adv);
    const totalCost = executorCost + advisorCost;
    return {
      executorCalls: exec.length,
      advisorCalls: adv.length,
      executorCost,
      advisorCost,
      totalCost,
      upperModelShare: totalCost > 0 ? advisorCost / totalCost : 0,
      byTier: {
        opus: adv.filter((r) => r.tier === "opus").length,
        fable: adv.filter((r) => r.tier === "fable").length,
      },
    };
  }
}
