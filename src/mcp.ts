/**
 * MCP server — exposes the credit-aware advisor to IDE agents (Claude Code,
 * or anything speaking MCP over stdio).
 *
 * This is the v0.2 shape of the tool: the IDE agent IS the executor, so there
 * is no executor loop here. What remains is the part with no built-in
 * equivalent — the tier policy (Opus by default, Fable for security /
 * migration / complex planning / hard), the compressed consult packet, the
 * budget gates, and the auditable cost ledger.
 *
 * Register with Claude Code:
 *   claude mcp add advisor -- node "<absolute path>/dist/mcp.js"
 *
 * IMPORTANT: stdout is the JSON-RPC channel — never console.log here; use
 * console.error for diagnostics.
 */

import "dotenv/config";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CONFIG, MCP, MODELS, POLICY } from "./config.js";
import { decideAdvisor } from "./advisorPolicy.js";
import { consultWithPacket } from "./advisor.js";
import { buildConsultPacket } from "./contextCompressor.js";
import { CostLedger } from "./costLedger.js";
import { readLedger, aggregate, formatReport, parseDuration } from "./ledgerReport.js";
import { planRoute } from "./routePlan.js";
import type { AdvisorTrigger, CodingState } from "./types.js";

const PURPOSE_TO_TRIGGER: Record<string, AdvisorTrigger> = {
  guidance: "low_executor_confidence",
  planning: "complex_planning",
  security: "security_sensitive",
  migration: "database_or_migration",
  review: "user_requested_review",
};

function ledgerPathFor(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, CONFIG.ledgerPath);
}

/** Advisor spend/calls already logged for a task id, plus today's total. */
async function budgetSnapshot(ledgerFile: string, taskId: string) {
  const records = await readLedger(ledgerFile);
  const advisor = records.filter((r) => r.role === "advisor");
  const forTask = advisor.filter((r) => r.taskId === taskId);
  const today = new Date().toDateString();
  const spentToday = advisor
    .filter((r) => new Date(r.timestamp).toDateString() === today)
    .reduce((a, r) => a + r.estimatedCost, 0);
  const lastTier = forTask.length ? forTask[forTask.length - 1].tier ?? null : null;
  return {
    taskCalls: forTask.length,
    taskSpend: forTask.reduce((a, r) => a + r.estimatedCost, 0),
    spentToday,
    lastTier,
  };
}

/** Minimal CodingState so the shared policy layer can gate MCP consults. */
function stateFor(taskId: string, snap: { taskCalls: number; taskSpend: number; lastTier: any }): CodingState {
  return {
    taskId,
    task: "",
    touchedFiles: new Set(),
    changedFileCount: 0,
    failedTestAttempts: 0,
    lastTestOutput: null,
    recentExecutorText: [],
    advisorCallsThisTask: snap.taskCalls,
    advisorSpendThisTask: snap.taskSpend,
    lastAdvisorTier: snap.lastTier,
    autoConsulted: new Set(),
  };
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const server = new McpServer({ name: "advisor-tool", version: "0.2.0" });

server.registerTool(
  "consult_advisor",
  {
    description:
      "Consult a stronger advisor model for high-leverage guidance. Costs real money — use SPARINGLY, only when genuinely stuck or the stakes are high. " +
      `Routes to ${MODELS.advisorPrimary} by default; purpose 'planning'/'security'/'migration' (or hard=true) escalates to ${MODELS.advisorHard}. ` +
      "Budgets are enforced per task_id and per day; the call is refused (not billed) when a cap is hit. Every consult is logged to the workspace cost ledger.",
    inputSchema: {
      question: z.string().describe("The specific question you want the advisor to answer."),
      task: z.string().describe("One-line description of the overall task you are working on."),
      situation: z
        .string()
        .optional()
        .describe("What you've tried, what's failing, and any error output. More signal here = better advice."),
      files_changed: z.array(z.string()).optional().describe("Repo-relative paths you have changed so far."),
      test_output: z.string().optional().describe("Latest relevant test/command output, if any."),
      purpose: z
        .enum(["guidance", "planning", "security", "migration", "review"])
        .optional()
        .describe(
          "Why you're consulting. 'planning' = complex/architectural task planning, 'security'/'migration' = high-stakes changes — these three use the premium tier. Default: 'guidance'."
        ),
      hard: z
        .boolean()
        .optional()
        .describe("Force the premium tier for a genuinely high-stakes call. Costs ~2x."),
      task_id: z
        .string()
        .optional()
        .describe("Stable id to group this task's consults under one budget. Default: 'adhoc'."),
      workspace_root: z
        .string()
        .optional()
        .describe("Absolute path of the project being worked on (for git diff + ledger). Default: server cwd."),
    },
  },
  async (args) => {
    const workspaceRoot = args.workspace_root ?? process.cwd();
    const taskId = args.task_id ?? MCP.defaultTaskId;
    const ledgerFile = ledgerPathFor(workspaceRoot);

    const snap = await budgetSnapshot(ledgerFile, taskId);

    if (MCP.dailySpendCap > 0 && snap.spentToday >= MCP.dailySpendCap) {
      return text(
        `REFUSED (not billed): daily advisor spend cap reached ($${snap.spentToday.toFixed(2)} of $${MCP.dailySpendCap.toFixed(2)} today). ` +
          "Proceed with your own judgment, or raise MCP.dailySpendCap in src/config.ts."
      );
    }

    const trigger = PURPOSE_TO_TRIGGER[args.purpose ?? "guidance"];
    const decision = decideAdvisor(stateFor(taskId, snap), trigger, {
      forceFable: args.hard === true,
    });

    if (!decision.call) {
      return text(
        `REFUSED (not billed): ${decision.note ?? decision.reason}. ` +
          `(task_id "${taskId}": ${snap.taskCalls} consults, $${snap.taskSpend.toFixed(4)} spent; caps: ${POLICY.maxAdvisorCallsPerTask} calls / $${POLICY.maxAdvisorSpendPerTask})`
      );
    }

    const packet = await buildConsultPacket({
      task: args.task,
      situation: args.situation,
      filesChanged: args.files_changed,
      testOutput: args.test_output,
      question: args.question,
      workspaceRoot,
    });

    const ledger = new CostLedger(ledgerFile);
    const result = await consultWithPacket({
      packet,
      decision,
      taskId,
      ledger,
      onFallback: () => console.error("advisor-tool: Fable 5 not reachable — falling back to Opus 4.8."),
    });
    await ledger.persist();

    const footer =
      `\n\n---\n[advisor: ${result.model} (${result.tier} tier)` +
      (result.fellBackFromFable ? ", fell back from Fable" : "") +
      ` | trigger: ${decision.reason} | est. cost $${result.cost.toFixed(4)}` +
      ` | task_id "${taskId}": ${snap.taskCalls + 1}/${POLICY.maxAdvisorCallsPerTask} consults]`;

    return text(result.advice + footer);
  }
);

server.registerTool(
  "advisor_ledger",
  {
    description:
      "Read the workspace's advisor cost ledger — spend by model, upper-model share, avg cost per task, Fable trigger reasons, Fable→Opus fallbacks. Read-only, free, no API call. All costs are LOCAL ESTIMATES from the price table in src/config.ts, not billing data.",
    inputSchema: {
      last: z.string().optional().describe("Rolling window like '30m', '24h', '7d', '2w'. Omit for all time."),
      task_id: z.string().optional().describe("Only records for this task id."),
      workspace_root: z.string().optional().describe("Project root containing .advisor-coder/. Default: server cwd."),
    },
  },
  async (args) => {
    const workspaceRoot = args.workspace_root ?? process.cwd();
    const ledgerFile = ledgerPathFor(workspaceRoot);
    const records = await readLedger(ledgerFile);
    const scopeLabel = args.task_id ? `task ${args.task_id}` : args.last ? `last ${args.last}` : "all time";
    const agg = aggregate(records, ledgerFile, {
      windowMs: args.last ? parseDuration(args.last) : undefined,
      taskId: args.task_id,
      scopeLabel,
    });
    return text(formatReport(agg));
  }
);

server.registerTool(
  "estimate_route",
  {
    description:
      "Dry-run routing plan for a task: which models would run, whether the premium tier would be allowed, detected risk triggers, estimated packet size, and an upper-bound cost estimate. Free, no API call.",
    inputSchema: {
      task: z.string().describe("The task to plan, in plain English."),
    },
  },
  async (args) => text(planRoute(args.task))
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `advisor-tool MCP server ready (advisor: ${MODELS.advisorPrimary} default / ${MODELS.advisorHard} premium; daily cap $${MCP.dailySpendCap})`
  );
}

main().catch((err) => {
  console.error("advisor-tool MCP server fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
