# CLAUDE.md — Claude Code Advisor Policy

For this project, the `advisor` MCP server is a credit-aware escalation layer you
call **deliberately**. Nothing routes automatically: in a Claude Code session *you*
do the coding and *you* choose when to call these tools. (The executor→advisor
auto-routing — Sonnet escalating to Opus/Fable — lives only in the standalone CLI,
`npm start -- ...` / the global `advisor` command, not in this chat.)

## Default behavior

- Use the normal coding model for routine implementation, inspection, small fixes,
  tests, and refactors.
- Do **not** call `consult_advisor` for trivial edits or simple questions.
- Use `estimate_route` **before** larger, multi-file, architectural, security, auth,
  payment, database, migration, or planning-heavy tasks, and show the plan.
  `estimate_route` is free and makes no API call.
- Propose `consult_advisor` at high-stakes checkpoints, but never invoke it silently.

## Advisor model tier policy

- **Opus** is the default advisor tier.
- **Fable** is allowed for:
  - complex planning
  - architecture decisions
  - security / auth / payment-sensitive work
  - database migrations
  - hard / stuck debugging
  - explicit user request

## Paid consult rule

`consult_advisor` spends real money. Before calling it, state **why** the consult is
needed and its estimated cost, then ask for approval — the user must approve the
paid tool call. Server backstops enforce this too: per-`task_id` cap of 3 consults /
$0.75 and a rolling daily cap of $5 (`MCP.dailySpendCap` in `src/config.ts`). A
consult over budget is **refused, not billed**.

## Ledger

Use `advisor_ledger` (free) after paid consults or when the user asks to review
spend. Costs are local estimates from `src/config.ts`, not billing data.
