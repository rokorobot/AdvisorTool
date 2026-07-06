/**
 * Interactive CLI entry point.
 *
 * REPL: each line is a task. Conversation persists across tasks in a session.
 * The cost ledger is flushed to disk after every task.
 *
 * Usage:
 *   npm start
 *   npm start -- "add input validation to src/parser.ts and a test for it"
 */

import "dotenv/config";
import path from "node:path";
import { CONFIG, MODELS } from "./config.js";
import { runTask } from "./executorLoop.js";
import { CostLedger } from "./costLedger.js";
import { ask, closePrompt } from "./prompt.js";
import { runLedgerCommand } from "./ledgerReport.js";
import { planRoute } from "./routePlan.js";

async function main() {
  const ledgerFile = path.resolve(CONFIG.workspaceRoot, CONFIG.ledgerPath);
  const argv = process.argv.slice(2);

  // Subcommand: ledger — read the cost log, no model calls, no API key needed.
  if (argv[0] === "ledger") {
    await runLedgerCommand(ledgerFile, argv.slice(1));
    return;
  }

  // Subcommand / flag: route or --dry-run — show the routing plan, spend nothing.
  const dryRunIdx = argv.indexOf("--dry-run");
  if (argv[0] === "route" || dryRunIdx !== -1) {
    const rest =
      argv[0] === "route"
        ? argv.slice(1)
        : argv.filter((_, i) => i !== dryRunIdx);
    const task = rest.join(" ").trim();
    if (!task) {
      console.error('Provide a task, e.g. npm start -- --dry-run "refactor auth"');
      process.exit(1);
    }
    console.log(planRoute(task));
    return;
  }

  const ledger = new CostLedger(ledgerFile);

  console.log("Adviser Tool — credit-aware coding router");
  console.log(`  executor: ${MODELS.executor}`);
  console.log(`  advisor:  ${MODELS.advisorPrimary} (default) / ${MODELS.advisorHard} (hard cases)`);
  console.log(`  workspace: ${CONFIG.workspaceRoot}`);
  console.log(
    CONFIG.confirmMutations
      ? "  mutations require confirmation."
      : "  ⚠ mutations run WITHOUT confirmation."
  );
  console.log('Type a task. "exit" or Ctrl-C to quit.\n');

  const messages: any[] = [];

  const argvTask = argv.join(" ").trim();
  if (argvTask) {
    await runTask(messages, argvTask, ledger);
    await ledger.persist();
    console.log();
  }

  try {
    while (true) {
      const line = (await ask("task> ")).trim();
      if (!line) continue;
      if (line === "exit" || line === "quit") break;
      await runTask(messages, line, ledger);
      await ledger.persist();
      console.log();
    }
  } finally {
    closePrompt();
  }
}

main().catch((err) => {
  console.error("\nFatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
