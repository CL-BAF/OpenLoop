import type {OpencodeClient} from "@opencode-ai/sdk/v2";
import type {Agent, Model} from "@opencode-ai/sdk/v2";
import type {ModelRef, SessionSelection} from "@openloop/core";
import {unwrap} from "./sdk.js";

export interface AgentOption {
  id: string;
  mode: Agent["mode"];
  description?: string;
}

export interface ModelOption {
  providerID: string;
  modelID: string;
  name: string;
  status: Model["status"];
  enabled: boolean;
}

export interface Catalog {
  agents: AgentOption[];
  models: ModelOption[];
}

/** Query the live OpenCode environment for available agents and models. */
export async function fetchCatalog(client: OpencodeClient, directory: string): Promise<Catalog> {
  const [agentData, providerData] = await Promise.all([
    // The legacy-named /agent route is the current configured agent list. The
    // newer /api/agent route may be empty when no desktop workspace exists.
    unwrap(client.app.agents({directory}), "list agents"),
    // /api/model is the universal models.dev catalog in current OpenCode, not
    // the set the user can actually invoke. /config/providers returns only
    // active/configured providers and also includes project-local custom ones.
    unwrap(client.config.providers({directory}), "list configured providers"),
  ]);
  const agents: AgentOption[] = agentData
    .filter((a) => !a.hidden && (a.mode === "primary" || a.mode === "all"))
    .map((a) => ({id: a.name, mode: a.mode, description: a.description}));

  const models: ModelOption[] = providerData.providers.flatMap((provider) =>
    Object.values(provider.models).map((model) => ({
      providerID: provider.id,
      modelID: model.id,
      name: model.name,
      status: model.status,
      enabled: true,
    })),
  );

  return {agents, models};
}

/** Validate a selection against a catalog. Returns the normalized selection or an error message. */
export function validateSelection(sel: SessionSelection, catalog: Catalog): {ok: true; selection: SessionSelection} | {ok: false; error: string} {
  if (catalog.agents.length === 0) {
    return {ok: false, error: "No agents available in this OpenCode environment."};
  }
  const agent = catalog.agents.find((a) => a.id === sel.agent);
  if (!agent) {
    return {ok: false, error: `Agent "${sel.agent}" is not available. Available: ${catalog.agents.map((a) => a.id).join(", ")}`};
  }
  if (sel.model) {
    if (catalog.models.length === 0) {
      return {ok: false, error: "No models available in this OpenCode environment."};
    }
    const model = catalog.models.find((m) => m.providerID === sel.model!.providerID && m.modelID === sel.model!.modelID);
    if (!model) {
      const sample = catalog.models.slice(0, 8).map((m) => `${m.providerID}/${m.modelID}`).join(", ");
      return {ok: false, error: `Model "${sel.model.providerID}/${sel.model.modelID}" is not available. Available include: ${sample}${catalog.models.length > 8 ? " ..." : ""}`};
    }
    if (!model.enabled) {
      return {ok: false, error: `Model "${model.providerID}/${model.modelID}" is present but not enabled.`};
    }
  }
  return {ok: true, selection: {agent: agent.id, model: sel.model}};
}

/** Format the catalog as a human-readable list for the chat-based picker. */
export function formatCatalog(catalog: Catalog): string {
  const agents = catalog.agents.length
    ? catalog.agents.map((a) => `  - ${a.id}${a.mode !== "primary" ? ` (${a.mode})` : ""}${a.description ? ` — ${a.description}` : ""}`).join("\n")
    : "  (none)";
  const models = catalog.models.length
    ? catalog.models.map((m) => `  - ${m.providerID}/${m.modelID} (${m.name}, ${m.status})`).join("\n")
    : "  (none)";
  return `## Available agents\n${agents}\n\n## Available models\n${models}`;
}

/** Parse a "provider/model" string into a ModelRef, or null if invalid/empty. */
export function parseModelRef(value: string | undefined | null): ModelRef | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf("/");
  const providerID = trimmed.slice(0, separator).trim();
  const modelID = trimmed.slice(separator + 1).trim();
  if (separator <= 0 || !providerID || !modelID) return null;
  return {providerID, modelID};
}
