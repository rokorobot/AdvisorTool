/**
 * Thin wrapper around the Anthropic SDK.
 *
 * The client is created lazily so that dotenv has loaded ANTHROPIC_API_KEY
 * before we read it. `isAccessError` is used to detect when Fable 5 isn't
 * reachable (e.g. usage credits not enabled) so the caller can fall back.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getApiKey } from "../config.js";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: getApiKey() });
  return _client;
}

export interface ModelResponse {
  content: any[];
  stopReason: string | null;
  usage: any;
}

export async function callModel(params: {
  model: string;
  system: string;
  messages: any[];
  tools?: any[];
  maxTokens: number;
}): Promise<ModelResponse> {
  const res: any = await client().messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: params.messages,
    ...(params.tools && params.tools.length ? { tools: params.tools } : {}),
  } as any);
  return { content: res.content, stopReason: res.stop_reason, usage: res.usage };
}

/** True if an error looks like a model-access / entitlement problem (→ fall back). */
export function isAccessError(err: unknown): boolean {
  const e = err as any;
  const status = e?.status;
  const msg = String(e?.message ?? "").toLowerCase();
  return (
    status === 403 ||
    status === 404 ||
    msg.includes("permission") ||
    msg.includes("not allowed") ||
    msg.includes("access") ||
    msg.includes("enable") ||
    msg.includes("credit")
  );
}
