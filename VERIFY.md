# AdvisorTool — Verification

A repeatable path to prove the two things this tool's value depends on: that
routing sends work to the right model, and that every billed call is logged.
Do the zero-spend checks first; only the "paid smoke test" section costs money.

> All costs shown by the tool are **local estimates** from the price table in
> `src/config.ts`, stamped at call time — not read from your Anthropic bill.

## 1. Zero-spend checks

These make **no API call** and need no key.

```bash
npm ci                                                              # reproducible install from the lockfile
npm run typecheck                                                   # tsc --noEmit
npm start -- route "inspect this repo and suggest one safe improvement"
npm start -- --dry-run "inspect this repo and suggest one safe improvement"
npm start -- ledger
npm start -- ledger --json
git check-ignore -v .advisor-coder/test.jsonl
```

Expected:

- [ ] `typecheck` exits `0`.
- [ ] `route` and `--dry-run` print a routing plan and make **no** API call (identical output — `--dry-run` is an alias for `route`).
- [ ] `ledger` handles the empty state without error ("No model calls recorded for this scope").
- [ ] `ledger --json` prints valid JSON with zeroed totals (`"callCount": 0`, `"byModel": []`) — no `NaN`, no crash.
- [ ] `git check-ignore` traces `.advisor-coder/…` to a line in `.gitignore` (i.e. it is ignored).

## 2. First paid smoke test

Create `.env` (it is gitignored — your key never gets committed):

```bash
cp .env.example .env       # Windows: copy .env.example .env
# then edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

Run one tiny, harmless task:

```bash
npm start -- "make a minimal harmless comment-only change in src/config.ts"
```

Inspect the log and the summary:

```bash
cat .advisor-coder/ledger.jsonl
npm start -- ledger
npm start -- ledger --json
```

Expected:

- [ ] The Sonnet executor call is logged with `"role": "executor"`.
- [ ] **No** advisor call appears — a harmless one-file comment change trips no trigger.
- [ ] Fable 5 is **not** used (nothing security/migration/hard about this task).
- [ ] Each record carries a non-zero `estimatedCost`, and `ledger` reports an upper-model share.
- [ ] `.advisor-coder/` remains untracked in `git status`.

## 3. Advisor-escalation check (zero spend)

`route` mode shows the *decision* without paying for a consult:

```bash
npm start -- route "review auth token handling and database migration safety"
```

Expected:

- [ ] `Fable allowed: yes` — a detected risk trigger routes to Fable 5.
- [ ] Detected triggers include a security/auth signal and `database_or_migration`.
- [ ] Still **no** API call in `route` mode.

To see a real Fable consult end-to-end (this **does** spend), run an actual task
that touches a sensitive path — e.g. one that edits a file with `auth`,
`payment`, or `migration` in its path — then check that the ledger records a
`"tier": "fable"` advisor call with a matching `triggerReason`. If Fable 5 is
not reachable on your account, the log will show the call downgraded to Opus
with `"fellBackFromFable": true`.

## 4. Claude Code MCP verification (v0.2 — the main usage path)

Build first:

```powershell
cd "C:\Users\Robert\Adviser Tool\adviser-tool"
npm ci
npm run build
```

Add the MCP server to Claude Code (everything after `--` is the server command):

```powershell
claude mcp add --transport stdio --scope user advisor -- node "C:\Users\Robert\Adviser Tool\adviser-tool\dist\mcp.js"
```

The server reads `ANTHROPIC_API_KEY` from its environment. In Claude Code, confirm
the tools are visible — ask:

```
List available MCP tools from the advisor server.
```

- [ ] `consult_advisor`, `advisor_ledger`, and `estimate_route` are listed.

**Zero-spend test** — ask Claude Code:

```
Use estimate_route for: refactor the audio engine.
```

- [ ] A route decision is returned, no API call.
- [ ] `Fable allowed` is `yes` only when a planning/security/migration/hard trigger applies.

**Paid planning test** — ask Claude Code:

```
Consult the advisor with purpose planning before changing the architecture.
```

- [ ] `consult_advisor` is called (approve the tool use).
- [ ] `purpose: "planning"` routes to Fable 5 (see the tier note in the response footer).
- [ ] The call is appended to `.advisor-coder/ledger.jsonl` in the project.
- [ ] `advisor_ledger` (ask "check the advisor ledger") shows the new spend.

**Budget gate** — the server refuses (does **not** bill) once a cap is hit: per
`task_id` (3 consults / $0.75) or the rolling daily cap (`MCP.dailySpendCap`,
$5 by default). A refused consult returns a `REFUSED (not billed)` message.

## Notes

- Routing thresholds, budgets, model IDs, and the price table all live in
  `src/config.ts`.
- Per-task caps default to 3 advisor consults / \$0.75; a task cannot silently
  bill unbounded upper-model spend.
