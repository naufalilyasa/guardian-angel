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
  ctx?: PluginContext,
  opts?: Record<string, unknown>,
): AdvisorSdkClient | undefined {
  if (opts?.advisorClient) {
    return opts.advisorClient as AdvisorSdkClient;
  }
  // v2.1.4 has no session-API client on ctx; use stateless generate.text
  // and adapt it to the v1 AdvisorSdkClient shape (session.create+prompt).
  const genText = (ctx as any)?.generate?.text;
  if (typeof genText !== "function") return undefined;
  return {
    session: {
      create: async () => ({ data: { id: "guardian-angel-advisor" } }),
      prompt: async (req: any) => {
        const body = req?.body ?? {};
        const user = (body.parts ?? [])
          .filter((p: any) => p?.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text)
          .join("\n");
        const prompt = [body.system, user].filter(Boolean).join("\n\n");
        const model = body.model
          ? { id: body.model.modelID, providerID: body.model.providerID }
          : undefined;
        const out = await genText(model ? { prompt, model } : { prompt });
        const text = typeof out?.text === "string" ? out.text : "";
        return { data: { parts: text ? [{ type: "text", text }] : [] } };
      },
    },
  } as unknown as AdvisorSdkClient;
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
      advisorClient: resolveAdvisorClient(ctx, opts),
      advisorModel: (opts.advisorModel as string | undefined) ?? resolveAdvisorModel(workspace),
    });

    await ctx.tool.hook("execute.before", hook as any);
  },
});

export default GuardianAngelServerV2;
