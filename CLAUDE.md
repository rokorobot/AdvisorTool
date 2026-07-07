# CLAUDE.md

Guidance for Claude Code when working in this repo.

## Advisor MCP usage policy

The `advisor` MCP server exposes three tools. Nothing routes automatically — these
are tools to call deliberately. (The executor/advisor auto-routing applies only to
the standalone CLI, `npm start -- ...`, not to a Claude Code session.)

- **`estimate_route`** (free, no API call): call it and show the plan **before
  starting any larger task** — multi-file/architectural, security/auth/migration
  work, or whenever a plan is explicitly requested. Skip it for trivial one-liners
  and quick questions.
- **`consult_advisor`** (spends real money): only **propose** it at planning
  checkpoints for high-stakes work (architecture, security, migration), state the
  estimated cost, and invoke it **only after the user approves** the tool-use
  prompt. Never fire a paid consult unprompted. Server backstops: per-task cap of
  3 consults / $0.75, daily cap $5.
- **`advisor_ledger`** (free): on request, or to sanity-check spend after consults.
