/**
 * Context compressor.
 *
 * The whole point of the router (vs. the official advisor tool) is that the
 * advisor does NOT receive the full transcript. Instead we hand it a compact
 * packet: the task, what the executor just did, the changed files, a truncated
 * git diff, relevant excerpts, and the latest test output. On a large session
 * this is ~5-10k tokens instead of 60-100k — a 10-20x cut on advisor input cost.
 *
 * The tradeoff is that the advisor sees less, so it may miss something buried in
 * the trace. The advisor system prompt lets it ask for a specific file/output
 * when the packet isn't enough.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import type { CodingState } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: CONFIG.workspaceRoot,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

export async function buildAdvisorPacket(
  state: CodingState,
  question: string
): Promise<string> {
  const diffStat = await git(["diff", "--stat"]);
  const diff = truncate(await git(["diff"]), 6000);

  const touched = [...state.touchedFiles];
  const excerpts: string[] = [];
  for (const f of touched.slice(0, 4)) {
    try {
      const abs = path.resolve(CONFIG.workspaceRoot, f);
      const content = await fs.readFile(abs, "utf8");
      excerpts.push(`--- ${f} ---\n${truncate(content, 2500)}`);
    } catch {
      /* file may have been deleted or is binary; skip */
    }
  }

  const recent = truncate(
    state.recentExecutorText.slice(-3).join("\n---\n") || "(no notes yet)",
    1500
  );

  const parts = [
    "# Advisor consult",
    "",
    "## Task",
    state.task,
    "",
    "## What the executor has done recently",
    recent,
    "",
    `## Files changed (${state.changedFileCount})`,
    touched.length ? touched.join("\n") : "(none yet)",
    "",
    "## git diff --stat",
    diffStat || "(no diff / not a git repo)",
    "",
    "## git diff (truncated)",
    diff || "(empty)",
    "",
  ];

  if (excerpts.length) {
    parts.push("## Relevant file excerpts", excerpts.join("\n\n"), "");
  }
  if (state.lastTestOutput) {
    parts.push(
      "## Latest command / test output (truncated)",
      truncate(state.lastTestOutput, 2500),
      ""
    );
  }

  parts.push("## Question for you", question);
  return parts.join("\n");
}
