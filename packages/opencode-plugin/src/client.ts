import type {PluginInput} from "@opencode-ai/plugin";
import type {OpencodeClient} from "@opencode-ai/sdk/v2";

type InjectedClient = PluginInput["client"];
type FlatArgs = Record<string, unknown> | undefined;

/**
 * Adapt OpenCode's injected plugin client to the v2-shaped calls used by the
 * runtime. The injected client uses OpenCode's in-process transport in Desktop
 * and the TUI; constructing another HTTP client from serverUrl is not reliable
 * there because an embedded instance need not expose a reachable listener.
 */
export function adaptPluginClient(injected: InjectedClient, directory: string): OpencodeClient {
  const scope = (requested?: unknown, extra: Record<string, unknown> = {}) => ({
    directory: typeof requested === "string" && requested ? requested : directory,
    ...extra,
  });

  const session = injected.session as unknown as Record<string, (args?: unknown) => unknown>;
  const app = injected.app as unknown as Record<string, (args?: unknown) => unknown>;
  const config = injected.config as unknown as Record<string, (args?: unknown) => unknown>;
  const tool = injected.tool as unknown as Record<string, (args?: unknown) => unknown>;

  return {
    session: {
      create: (args: FlatArgs = {}) => session.create!({
        body: omit(args, "directory"),
        query: scope(args.directory),
      }),
      status: (args: FlatArgs = {}) => session.status!({query: scope(args.directory)}),
      messages: (args: FlatArgs = {}) => session.messages!({
        path: {id: args.sessionID},
        query: scope(args.directory, pick(args, "limit")),
      }),
      diff: (args: FlatArgs = {}) => session.diff!({
        path: {id: args.sessionID},
        query: scope(args.directory, pick(args, "messageID")),
      }),
      abort: (args: FlatArgs = {}) => session.abort!({
        path: {id: args.sessionID},
        query: scope(args.directory),
      }),
      delete: (args: FlatArgs = {}) => session.delete!({
        path: {id: args.sessionID},
        query: scope(args.directory),
      }),
      promptAsync: (args: FlatArgs = {}) => session.promptAsync!({
        path: {id: args.sessionID},
        query: scope(args.directory),
        body: omit(args, "sessionID", "directory"),
      }),
    },
    app: {
      agents: (args: FlatArgs = {}) => app.agents!({query: scope(args.directory)}),
    },
    config: {
      providers: (args: FlatArgs = {}) => config.providers!({query: scope(args.directory)}),
    },
    tool: {
      ids: (args: FlatArgs = {}) => tool.ids!({query: scope(args.directory)}),
    },
  } as unknown as OpencodeClient;
}

function omit(value: FlatArgs, ...keys: string[]): Record<string, unknown> {
  const result = {...(value ?? {})};
  for (const key of keys) delete result[key];
  return result;
}

function pick(value: FlatArgs, ...keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (value?.[key] !== undefined) result[key] = value[key];
  }
  return result;
}
