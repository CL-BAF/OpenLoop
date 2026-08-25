import {describe, expect, it} from "vitest";
import {buildReadonlyPermissions, unwrap} from "../src/sdk.js";
import type {OpencodeClient} from "@opencode-ai/sdk/v2";

describe("SDK response envelopes", () => {
  it("does not treat an empty HTTP error response as prompt success", async () => {
    const response = new Response("server failed", {status: 503, statusText: "Unavailable"});
    await expect(unwrap(Promise.resolve({response}), "send prompt", true))
      .rejects.toThrow("HTTP 503 Unavailable - server failed");
  });
});

describe("reviewer read-only permissions", () => {
  it("denies every non-read-only live tool without granting read permissions", async () => {
    const client = {
      tool: {
        ids: async () => ({
          data: ["read", "grep", "edit", "apply_patch", "custom_mutator"],
          error: undefined,
          response: undefined,
        }),
      },
    } as unknown as OpencodeClient;

    const permissions = await buildReadonlyPermissions(client);
    expect(permissions).toEqual(expect.arrayContaining([
      {permission: "edit", pattern: "*", action: "deny"},
      {permission: "apply_patch", pattern: "*", action: "deny"},
      {permission: "custom_mutator", pattern: "*", action: "deny"},
      {permission: "external_directory", pattern: "*", action: "deny"},
    ]));
    expect(permissions).not.toContainEqual(expect.objectContaining({permission: "read"}));
    expect(permissions).not.toContainEqual(expect.objectContaining({permission: "grep"}));
    expect(permissions.filter((rule) => rule.permission === "edit")).toHaveLength(1);
  });
});
