# Adviser Tool — credit-aware coding router

A credit-aware **advisor service** for coding agents, plus a standalone CLI
agent. The core idea: run cheap models for the bulk of the work and pay for a
stronger **advisor** only when it's worth it — every call policy-gated, logged,
and budgeted.

Two ways to use it:

1. **MCP server (recommended)** — plug it into Claude Code (or any MCP client).
   Your IDE agent stays the executor and calls `consult_advisor` when stuck.
2. **Standalone CLI** — a self-contained Sonnet executor loop driven from a
   `task>` prompt in the terminal.

- **Advisor (default):** `claude-opus-4-8` — high-leverage guidance at half Fable's rate.
- **Advisor (premium):** `claude-fable-5` — reserved for security, data-migration,
  and **complex-planning** consults, or an explicit hard escalation. Falls back
  to Opus automatically if Fable isn't reachable.
- **CLI executor:** `claude-sonnet-5` — reads files, writes code, runs tests.

## Use as an MCP server in Claude Code (v0.2)

```bash
npm install
npm run build
claude mcp add --transport stdio --scope user advisor -- node "/absolute/path/to/AdvisorTool/dist/mcp.js"
```

Everything after `--` is the command Claude Code runs to launch the server;
`--scope user` makes it available in every project (`project`/`local` also work).

The server needs `ANTHROPIC_API_KEY` in its environment (or a `.env` next to
where it runs). It exposes three tools:

| Tool | Cost | What it does |
| --- | --- | --- |
| `consult_advisor` | paid, budgeted | Builds a compressed packet (your question + situation + live `git diff`), applies the tier policy, calls Opus/Fable, logs to the ledger, returns focused advice. |
| `advisor_ledger` | free | Spend report for the workspace: by model, upper-model share, Fable triggers, fallbacks. |
| `estimate_route` | free | Dry-run plan: tier decision, detected risk triggers, cost ceiling. |

Tier selection for consults: `purpose: "planning" | "security" | "migration"`
(or `hard: true`) → Fable 5; everything else → Opus 4.8. Budgets are enforced
per `task_id` (3 consults / $0.75 by default) plus a rolling **daily cap**
($5 by default, `MCP.dailySpendCap` in `src/config.ts`). A consult over budget
is **refused, not billed**.

## Why a router instead of the official advisor tool

The official tool forwards the **full transcript** to the upper model on every
advisor call and lets the executor decide when to call it — great for quality,
not inherently cheap. This router instead sends a **compressed packet** (task,
recent actions, changed files, a truncated diff, test output — ~5–10k tokens
instead of 60–100k) and gates every consult behind an explicit policy. That's
roughly a 10–20× cut on advisor **input** cost, plus a hard per-task budget.

The tradeoff: the advisor sees less, so it can miss something buried in the
trace. The advisor is told to ask for a specific file/output when the packet
isn't enough.

## Setup

Requires Node.js 20+.

```bash
npm install
cp .env.example .env      # paste your ANTHROPIC_API_KEY
```

Fable 5 is billed on the API at ~$10 in / $50 out per Mtok and is available now
and after July 8 as long as your API account has billing enabled — the July 7
"usage credits" cliff is about the claude.ai subscription surface, not the API.

## Run

```bash
npm start                                       # interactive REPL
npm start -- "add input validation to src/parser.ts and a test for it"
```

`cd` into the project you want it to work on before launching (it operates in the
current directory), then type tasks at the `task>` prompt. Sessions keep context
across tasks. `exit` to quit.

## Daily use (install as a global command)

For day-to-day work you don't edit *inside* this repo — you install it once and
call it from whatever project you're working on. Each project gets its own
ledger at `./.advisor-coder/ledger.jsonl`.

**1. Build once** (compiles `src/` to `dist/`):

```bash
npm install
npm run build      # re-run this whenever you change src/config.ts
```

**2. Make your key available everywhere** as an environment variable, so you
don't need a `.env` in every project:

```powershell
# Windows (PowerShell) — persists to new terminals
setx ANTHROPIC_API_KEY "sk-ant-..."
```

```bash
# macOS / Linux — add to ~/.zshrc or ~/.bashrc
export ANTHROPIC_API_KEY="sk-ant-..."
```

**3. Add an `advisor` command** that runs the build against the current folder:

```powershell
# Windows — add to your PowerShell profile ($PROFILE)
function advisor {
    node "C:\absolute\path\to\AdvisorTool\dist\index.js" @args
}
```

```bash
# macOS / Linux — add to ~/.zshrc or ~/.bashrc
advisor() { node "/absolute/path/to/AdvisorTool/dist/index.js" "$@"; }
```

**4. Keep the ledger out of your repos** with a global gitignore:

```bash
git config --global core.excludesfile ~/.gitignore_global
echo ".advisor-coder/" >> ~/.gitignore_global
```

Open a new terminal so all three take effect, then from any project:

```bash
cd /path/to/my-project
advisor                                   # interactive REPL for a work session
advisor "fix the off-by-one in src/pagination.ts"   # one-off task
advisor route "refactor the auth layer"   # plan only, zero spend
advisor ledger                            # this project's spend so far
```

**Daily loop:** `cd` into a project → `advisor` → type plain-English tasks →
confirm the `[y/N]` prompts before each write/edit/shell command → `advisor
ledger` to review spend. Before a big or risky change, `advisor route "..."`
first to see the escalation decision and cost ceiling without paying.

## Commands

Two subcommands read/plan without spending — neither makes a model call, and
`ledger` doesn't even need an API key:

```bash
# Cost report from the ledger (all figures are local estimates, see below)
npm start -- ledger                 # all-time summary
npm start -- ledger --last 7d       # rolling window (30m, 24h, 7d, 2w …)
npm start -- ledger --task abc123   # one task id
npm start -- ledger --json          # machine-readable aggregate

# Routing plan for a task — what would run, and the cost ceiling, without spending
npm start -- route "refactor the auth token handler"
npm start -- --dry-run "refactor the auth token handler"
```

`ledger` reports spend by model (Sonnet / Opus / Fable), upper-model share,
average cost per task, why Fable 5 was consulted, and how many Fable calls fell
back to Opus. Every number is derived from `.advisor-coder/ledger.jsonl` and
stamped with the **local** price table in `src/config.ts` — it is an estimate,
not a reading off your Anthropic bill. The report prints that caveat too.

`route` / `--dry-run` shows the executor model, the default advisor tier, whether
the task's risk signals would escalate to Fable, the estimated advisor packet
size, and an upper-bound cost estimate — all from policy + pricing, no API call.

## How the routing works

1. The executor works with the client tools (`list_dir`, `read_file`,
   `write_file`, `edit_file`, `run_bash`) plus a `request_advisor` tool.
2. **Executor-initiated:** the model calls `request_advisor(reason, question, hard?)`
   when it's genuinely uncertain. The policy layer decides whether to allow it and
   which tier; the advice comes back as that tool's result.
3. **Auto-triggered:** after each turn, `advisorPolicy.classifyState` inspects the
   run — repeated test failures, a large diff (>8 files), or touched
   auth/payment/migration paths — and consults the advisor proactively, injecting
   the advice as a high-signal `[Advisor review — …]` message.
4. Every consult goes through `contextCompressor` (packet) → chosen tier →
   `costLedger`. Fable→Opus fallback on access errors.

## Tuning

Routing thresholds and budgets live in `src/config.ts`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `maxAdvisorCallsPerTask` | 3 | Hard cap on consults per task. |
| `maxAdvisorSpendPerTask` | $0.75 | Dollar cap per task (0 = unlimited). |
| `largeRefactorFileThreshold` | 8 | Diff size that auto-triggers a review. |
| `testFailEscalation` | 2 | Failed test runs before auto-consult. |
| `fableTriggers` | security, db/migration, complex planning | Triggers that use the pricier tier. |
| `MCP.dailySpendCap` | $5 | Daily advisor spend cap for MCP consults (0 = unlimited). |
| `sensitivePathFragments` | auth, payment, … | Paths that mark a change sensitive. |
| `confirmMutations` | true | Confirm before write/edit/bash. |

Model IDs and the (editable, estimated) price table are also in `config.ts` —
verify rates at https://platform.claude.com/ before trusting the cost report.

## Cost ledger

Every model call is appended to `.advisor-coder/ledger.jsonl` in the workspace
with model, role, tier, tokens, trigger, and estimated cost — so upper-model
spend share is auditable, not guessable. After each task the CLI prints a summary
including the upper-model share.

## Safety

This agent **runs shell commands and overwrites files** in its workspace.
`confirmMutations` is on by default, so it asks before any `write_file`,
`edit_file`, or `run_bash`. Paths are constrained to the workspace root. Keep
confirmation on outside a throwaway sandbox.

## Files

```
src/
  index.ts             CLI REPL + ledger/route subcommand dispatch
  config.ts            models, pricing, policy thresholds, limits
  types.ts             shared types
  systemPrompt.ts      executor prompt + escalation guidance
  tools.ts             client tools (fs + bash) + request_advisor def
  prompt.ts            shared readline interface
  executorLoop.ts      Sonnet loop, tool handling, trigger wiring
  advisorPolicy.ts     state → trigger, budget gates, tier selection
  contextCompressor.ts builds the compact advisor packet
  advisor.ts           consult orchestration + Fable→Opus fallback
  costLedger.ts        pricing, per-task summary, JSONL log
  ledgerReport.ts      `ledger` subcommand — reads the log, aggregates spend
  routePlan.ts         `route` / `--dry-run` — routing + cost plan, no spend
  mcp.ts               MCP server — consult_advisor / advisor_ledger / estimate_route
  providers/
    anthropic.ts       SDK wrapper + access-error detection
```
