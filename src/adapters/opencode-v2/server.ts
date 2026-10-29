import { Plugin } from "@opencode/plugin";
import { resolve } from "node:path";
import { createHookHandler, type ServerHandlerDeps } from "../opencode/server.ts";
import { resolveAdvisorModel, type AdvisorSdkClient } from "../opencode/advisor-client.ts";

export type PluginContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

export type ToolExecuteBeforeEvent = {
  tool: string;
  input: Record<string, unknown>;
  sessionID: string;
  agent?: string;
  messageID?: string;
  id: string;
};

/**
 * Mutates `input` in place so v1-shaped guard rules see `filePath`
 * (v2 file tools send `path`). Mutating the record matters: it is the
 * same object the v2 tool runner will execute.
 */
export function normalizeToolInput(
  tool: string,
  input: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (!input || typeof input !== "object") return input;
  const record = input as Record<string, unknown>;
  if (
    (tool === "write" || tool === "edit" || tool === "patch") &&
    typeof record.path === "string" &&
    !record.filePath
  ) {
    record.filePath = record.path;
  }
  return input;
}

export function resolveAdvisorClient(
  opts?: Record<string, unknown>,
): AdvisorSdkClient | undefined {
  if (opts?.advisorClient) {
    return opts.advisorClient as AdvisorSdkClient;
  }
  // v2.1.4 PluginContext has no client (O-1, verified live); tests inject via opts
  return undefined;
}

/**
 * Creates the v2 tool hook handler from ServerHandlerDeps.
 * Useful for standalone execution and unit tests.
 */
export function createServerV2Hook(deps: ServerHandlerDeps) {
  const handler = createHookHandler(deps);
  return async (event: ToolExecuteBeforeEvent): Promise<void> => {
    const input = (event.input ?? {}) as Record<string, unknown>;
    normalizeToolInput(event.tool, input);
    // v2 renamed the bash tool to "shell"; v1 rules key on "bash"
    const tool = event.tool === "shell" ? "bash" : event.tool;
    await handler(
      { tool, sessionID: event.sessionID, callID: event.id },
      { args: input },
    );
  };
}

export const GuardianAngelServerV2 = Plugin.define({
  id: "guardian-angel",
  async setup(ctx: PluginContext) {
    const opts = (ctx.options ?? {}) as Record<string, unknown>;
    const pkgRoot = (opts.pkgRoot as string) ?? resolve(import.meta.dir, "../../..");
    const workspace =
      (opts.directory as string) ??
      (opts.workspace as string) ??
      (ctx.location as any)?.directory ??
      process.cwd();

    const hook = createServerV2Hook({
      workspace,
      pkgRoot,
      ipcDir: opts.ipcDir as string | undefined,
      confirmTimeoutMs: (opts.confirmTimeoutMs as number) ?? 0,
      guardFn: opts.guardFn as ServerHandlerDeps["guardFn"],
      loadPolicy: opts.loadPolicy as ServerHandlerDeps["loadPolicy"],
      now: opts.now as ServerHandlerDeps["now"],
      advisorClient: resolveAdvisorClient(opts),
      advisorModel: (opts.advisorModel as string | undefined) ?? resolveAdvisorModel(workspace),
    });

    await ctx.tool.hook("execute.before", hook as any);
  },
});

export default GuardianAngelServerV2;
