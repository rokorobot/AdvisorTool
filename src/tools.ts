/**
 * Client-side tools available to the executor, plus a dispatcher.
 *
 * `request_advisor` is defined here but NOT dispatched here — the executor loop
 * intercepts it and routes it through the policy + consult layer instead.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG, LIMITS } from "./config.js";
import { confirm } from "./prompt.js";
import type { ToolUseBlock, ToolResultBlock } from "./types.js";

const execAsync = promisify(exec);

export const CLIENT_TOOLS = [
  {
    name: "list_dir",
    description: "List the files and subdirectories in a directory.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path, relative to the workspace root." },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of a text file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the workspace root." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create a new file or overwrite an existing one with the given content.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the workspace root." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact substring in a file. old_str must match exactly and appear exactly once.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the workspace root." },
        old_str: { type: "string", description: "Exact text to replace (must be unique in the file)." },
        new_str: { type: "string", description: "Replacement text." },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
  {
    name: "run_bash",
    description: "Run a shell command in the workspace root and return stdout/stderr.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
      },
      required: ["command"],
    },
  },
];

/** Escalation tool. Handled specially by the executor loop, not by dispatchTool. */
export const REQUEST_ADVISOR_TOOL = {
  name: "request_advisor",
  description:
    "Consult a stronger advisor model for high-leverage guidance. Use SPARINGLY — it costs more than your own work. Provide a short reason and a specific question.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Why you're escalating (e.g. 'uncertain which approach', 'stuck on failing tests', 'security-sensitive change').",
      },
      question: {
        type: "string",
        description: "The specific question you want the advisor to answer.",
      },
      hard: {
        type: "boolean",
        description: "Set true ONLY for high-stakes calls (security, data migration). Uses the more expensive model.",
      },
    },
    required: ["reason", "question"],
  },
};

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "run_bash"]);

function safeResolve(relPath: string): string {
  const root = path.resolve(CONFIG.workspaceRoot);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path "${relPath}" escapes the workspace root and is not allowed.`);
  }
  return resolved;
}

export async function dispatchTool(block: ToolUseBlock): Promise<ToolResultBlock> {
  const { name, input: args, id } = block;

  if (CONFIG.confirmMutations && MUTATING_TOOLS.has(name)) {
    const preview = name === "run_bash" ? `run: ${args.command}` : `${name}: ${args.path}`;
    const ok = await confirm(`\n  Agent wants to ${preview}\n  Allow?`);
    if (!ok) {
      return { type: "tool_result", tool_use_id: id, content: "User declined this action.", is_error: true };
    }
  }

  try {
    switch (name) {
      case "list_dir": {
        const dir = safeResolve(String(args.path));
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const listing = entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n");
        return { type: "tool_result", tool_use_id: id, content: listing || "(empty)" };
      }
      case "read_file": {
        const file = safeResolve(String(args.path));
        const text = await fs.readFile(file, "utf8");
        return { type: "tool_result", tool_use_id: id, content: text };
      }
      case "write_file": {
        const file = safeResolve(String(args.path));
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, String(args.content), "utf8");
        return { type: "tool_result", tool_use_id: id, content: `Wrote ${args.path}.` };
      }
      case "edit_file": {
        const file = safeResolve(String(args.path));
        const original = await fs.readFile(file, "utf8");
        const oldStr = String(args.old_str);
        const occurrences = original.split(oldStr).length - 1;
        if (occurrences === 0) {
          return { type: "tool_result", tool_use_id: id, content: `old_str not found in ${args.path}.`, is_error: true };
        }
        if (occurrences > 1) {
          return { type: "tool_result", tool_use_id: id, content: `old_str appears ${occurrences} times in ${args.path}; it must be unique.`, is_error: true };
        }
        await fs.writeFile(file, original.replace(oldStr, String(args.new_str)), "utf8");
        return { type: "tool_result", tool_use_id: id, content: `Edited ${args.path}.` };
      }
      case "run_bash": {
        const { stdout, stderr } = await execAsync(String(args.command), {
          cwd: CONFIG.workspaceRoot,
          maxBuffer: 10 * 1024 * 1024,
          timeout: LIMITS.bashTimeoutMs,
        });
        const out = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`]
          .filter(Boolean)
          .join("\n\n");
        return { type: "tool_result", tool_use_id: id, content: out || "(no output)" };
      }
      default:
        return { type: "tool_result", tool_use_id: id, content: `Unknown tool: ${name}`, is_error: true };
    }
  } catch (err) {
    // run_bash rejects on non-zero exit; surface stdout/stderr as an error result.
    const e = err as any;
    if (name === "run_bash" && (e?.stdout !== undefined || e?.stderr !== undefined)) {
      const out = [e.stdout && `stdout:\n${e.stdout}`, e.stderr && `stderr:\n${e.stderr}`]
        .filter(Boolean)
        .join("\n\n");
      return { type: "tool_result", tool_use_id: id, content: out || `Command failed: ${e.message}`, is_error: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { type: "tool_result", tool_use_id: id, content: `Error: ${message}`, is_error: true };
  }
}
