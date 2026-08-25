import {describe, expect, it, vi} from "vitest";
import {fetchCatalog, formatCatalog, parseModelRef, validateSelection, type Catalog} from "../src/catalog.js";
import type {OpencodeClient} from "@opencode-ai/sdk/v2";

describe("model catalog references", () => {
  it("round-trips catalog model IDs that contain slashes", () => {
    const catalog: Catalog = {
      agents: [{id: "build", mode: "primary"}],
      models: [{
        providerID: "openrouter",
        modelID: "vendor/family/model",
        name: "Nested model",
        status: "active",
        enabled: true,
      }],
    };
    const displayed = formatCatalog(catalog);
    expect(displayed).toContain("openrouter/vendor/family/model");
    const parsed = parseModelRef("openrouter/vendor/family/model");
    expect(parsed).toEqual({providerID: "openrouter", modelID: "vendor/family/model"});
    expect(validateSelection({agent: "build", model: parsed}, catalog)).toMatchObject({ok: true});
  });

  it("rejects empty provider or model components", () => {
    expect(parseModelRef("/model")).toBeNull();
    expect(parseModelRef("provider/")).toBeNull();
    expect(parseModelRef(" provider / vendor/model ")).toEqual({
      providerID: "provider", modelID: "vendor/model",
    });
  });

  it("uses configured providers rather than the universal v2 model index", async () => {
    const universalModels = vi.fn(() => {
      throw new Error("the universal model index must not drive selectable models");
    });
    const client = {
      app: {
        agents: async () => ({
          data: [{name: "build", mode: "primary", hidden: false}], error: undefined,
        }),
      },
      v2: {
        model: {list: universalModels},
      },
      config: {
        providers: async ({directory}: {directory: string}) => ({
          data: {
            providers: [{
              id: "local-smoke", name: "Local", source: "config", env: [], options: {},
              models: {
                deterministic: {
                  id: "deterministic", providerID: "local-smoke", name: "Deterministic",
                  status: "active",
                },
              },
            }],
            default: {"local-smoke": "deterministic"},
          },
          error: undefined,
          requestDirectory: directory,
        }),
      },
    } as unknown as OpencodeClient;

    const catalog = await fetchCatalog(client, "C:\\fixture");
    expect(universalModels).not.toHaveBeenCalled();
    expect(catalog.models).toEqual([{
      providerID: "local-smoke", modelID: "deterministic", name: "Deterministic",
      status: "active", enabled: true,
    }]);
  });
});
