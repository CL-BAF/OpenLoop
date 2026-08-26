import {describe, expect, it, vi} from "vitest";
import type {PluginInput} from "@opencode-ai/plugin";
import {adaptPluginClient} from "../src/client.js";

describe("injected plugin client adapter", () => {
  it("maps v2-shaped calls onto the in-process plugin client", async () => {
    const injected = {
      session: {
        create: vi.fn(), status: vi.fn(), messages: vi.fn(), diff: vi.fn(),
        abort: vi.fn(), delete: vi.fn(), promptAsync: vi.fn(),
      },
      app: {agents: vi.fn()},
      config: {providers: vi.fn()},
      tool: {ids: vi.fn()},
    } as unknown as PluginInput["client"];
    const client = adaptPluginClient(injected, "C:\\project");

    await client.config.providers({directory: "C:\\other"});
    await client.app.agents({directory: "C:\\other"});
    await client.tool.ids();
    await client.session.create({title: "CODER", permission: [{permission: "edit", pattern: "*", action: "deny"}]});
    await client.session.messages({sessionID: "ses-1", limit: 5});
    await client.session.diff({sessionID: "ses-1", messageID: "msg-1"});
    await client.session.promptAsync({sessionID: "ses-1", messageID: "msg-2", parts: [{type: "text", text: "go"}]});
    await client.session.abort({sessionID: "ses-1"});
    await client.session.delete({sessionID: "ses-1"});

    expect(injected.config.providers).toHaveBeenCalledWith({query: {directory: "C:\\other"}});
    expect(injected.app.agents).toHaveBeenCalledWith({query: {directory: "C:\\other"}});
    expect(injected.tool.ids).toHaveBeenCalledWith({query: {directory: "C:\\project"}});
    expect(injected.session.create).toHaveBeenCalledWith({
      body: {title: "CODER", permission: [{permission: "edit", pattern: "*", action: "deny"}]},
      query: {directory: "C:\\project"},
    });
    expect(injected.session.messages).toHaveBeenCalledWith({
      path: {id: "ses-1"}, query: {directory: "C:\\project", limit: 5},
    });
    expect(injected.session.diff).toHaveBeenCalledWith({
      path: {id: "ses-1"}, query: {directory: "C:\\project", messageID: "msg-1"},
    });
    expect(injected.session.promptAsync).toHaveBeenCalledWith({
      path: {id: "ses-1"}, query: {directory: "C:\\project"},
      body: {messageID: "msg-2", parts: [{type: "text", text: "go"}]},
    });
    expect(injected.session.abort).toHaveBeenCalledWith({
      path: {id: "ses-1"}, query: {directory: "C:\\project"},
    });
    expect(injected.session.delete).toHaveBeenCalledWith({
      path: {id: "ses-1"}, query: {directory: "C:\\project"},
    });
  });
});
