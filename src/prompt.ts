/** A single shared readline interface for all interactive prompts. */

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

let rl: readline.Interface | null = null;

function iface(): readline.Interface {
  if (!rl) rl = readline.createInterface({ input, output });
  return rl;
}

export function ask(question: string): Promise<string> {
  return iface().question(question);
}

export async function confirm(prompt: string): Promise<boolean> {
  const answer = (await ask(`${prompt} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

export function closePrompt(): void {
  rl?.close();
  rl = null;
}
