/**
 * Advisor client — wires `src/core/advisor.ts` into the OpenCode SDK.
 *
 * The advisor is advisory-only and toolless: it creates a throwaway session,
 * sends one structured-audit prompt with `tools: {}`, and parses the single
 * JSON response. The verdict never gates execution — the human pressing
 * 1. Deny / 2. Allow does.
 *
 * IPC protocol (parallel to request-/response- files):
 *   advisor-<callID>.json  { callID, status: "loading"|"ready"|"error", result?, error? }
 *
 * The server writes `loading` immediately (non-blocking), then overwrites
 * with `ready` or `error` when the model responds. The TUI polls this file
 * on its existing 200 ms timer — no extra channel needed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildAdvisorMessages,
  ingestFileForAdvisor,
  parseAdvisorResponse,
  DEFAULT_ADVISOR_MODEL,
  type AdvisorResult,
} from "../../core/advisor.ts";

export type AdvisorStatus = "loading" | "ready" | "error";

export type AdvisorIpcEntry = {
  callID: string;
  status: AdvisorStatus;
  result?: AdvisorResult;
  error?: string;
  model?: string;
  updatedAt: number;
};

/**
 * Minimal structural surface of `OpencodeClient` used here. Kept as a local
 * interface so unit tests can inject a stub without depending on the SDK.
 */
export type AdvisorSdkClient = {
  session: {
    create: (options?: {
      body?: { title?: string };
      query?: { directory?: string };
    }) => Promise<{ data?: { id: string } }>;
    prompt: (options: {
      body: {
        model?: { providerID: string; modelID: string };
        system?: string;
        tools?: Record<string, boolean>;
        parts: Array<{ type: "text"; text: string }>;
      };
      path: { id: string };
    }) => Promise<{
      data?: { parts?: Array<{ type: string; text?: string }> };
    }>;
  };
};

/** Split "9router/ag/gemini-3.8-flash-high" into provider + model IDs. */
export function splitModelId(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return { providerID: model, modelID: model };
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/**
 * Resolve the advisor model. Precedence: explicit `model` argument > the
 * project `.guardian-angel/config.json` `llm_advisor.model` field > the
 * global config at `$XDG_CONFIG_HOME/guardian-angel/config.json` > the
 * default. Returns the default when config is unreadable or malformed —
 * advisor failures must never break the guard.
 */
export function resolveAdvisorModel(
  workspace: string,
  model?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (model && model.trim().length > 0) return model.trim();
  const candidates: string[] = [];
  // Project first: project config outranks global per the documented precedence.
  candidates.push(join(workspace, ".guardian-angel", "config.json"));
  const xdg = env.XDG_CONFIG_HOME;
  const home = env.HOME;
  if (xdg) candidates.push(join(xdg, "guardian-angel", "config.json"));
  else if (home) candidates.push(join(home, ".config", "guardian-angel", "config.json"));
  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      const value = (raw as Record<string, unknown> | null)?.llm_advisor;
      if (value && typeof value === "object") {
        const m = (value as Record<string, unknown>).model;
        if (typeof m === "string" && m.trim().length > 0) return m.trim();
      }
    } catch {
      // unreadable or malformed — try the next candidate
    }
  }
  return DEFAULT_ADVISOR_MODEL;
}

export function writeAdvisorStatus(
  callID: string,
  entry: Omit<AdvisorIpcEntry, "callID" | "updatedAt">,
  ipcDir: string,
): void {
  const payload: AdvisorIpcEntry = { callID, updatedAt: Date.now(), ...entry };
  const target = join(ipcDir, `advisor-${callID}.json`);
  try {
    writeFileSync(target, JSON.stringify(payload, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Advisor is best-effort; never fail a tool call over its IPC writes.
  }
}

export type QueryAdvisorOptions = {
  client: AdvisorSdkClient;
  command: string;
  /** Raw file content; the host ingests (binary-check + 64KB cap) here. */
  fileContent?: string;
  filePath?: string;
  model?: string;
  directory?: string;
};

/**
 * Single-shot advisor audit. Creates a throwaway session, prompts the model
 * with zero tools, and returns the parsed result or an error message suitable
 * for the `error` IPC status. Never throws.
 */
export async function queryAdvisor(opts: QueryAdvisorOptions): Promise<{
  result: AdvisorResult | null;
  error?: string;
  model: string;
}> {
  const model = opts.model ?? DEFAULT_ADVISOR_MODEL;
  const { providerID, modelID } = splitModelId(model);

  let fileContent: string | null = null;
  if (opts.fileContent !== undefined) {
    fileContent = ingestFileForAdvisor(opts.fileContent);
  }
  const { system, user } = buildAdvisorMessages(opts.command, fileContent, opts.filePath);

  try {
    const created = await opts.client.session.create({
      body: { title: "guardian-angel-advisor" },
      ...(opts.directory ? { query: { directory: opts.directory } } : {}),
    });
    const sessionID = created?.data?.id;
    if (!sessionID) return { result: null, error: "session creation failed", model };

    const response = await opts.client.session.prompt({
      body: {
        model: { providerID, modelID },
        system,
        tools: {},
        parts: [{ type: "text", text: user }],
      },
      path: { id: sessionID },
    });

    const parts = response?.data?.parts ?? [];
    const text = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
      .trim();
    if (text.length === 0) return { result: null, error: "empty model response", model };

    const parsed = parseAdvisorResponse(text);
    if (!parsed) return { result: null, error: "malformed advisor response", model };
    return { result: parsed, model };
  } catch (err) {
    return {
      result: null,
      error: err instanceof Error ? err.message : "advisor request failed",
      model,
    };
  }
}
