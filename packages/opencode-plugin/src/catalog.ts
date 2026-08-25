import type {OpencodeClient} from "@opencode-ai/sdk/v2";
import type {AgentV2Info, ModelV2Info} from "@opencode-ai/sdk/v2";
import type {ModelRef, SessionSelection} from "@openloop/core";

export interface AgentOption {
  id: string;
  mode: AgentV2Info["mode"];
  description?: string;
}

export interface ModelOption {
  providerID: string;
  modelID: string;
  name: string;
  status: ModelV2Info["status"];
  enabled: boolean;
}

export interface Catalog {
  agents: AgentOption[];
  models: ModelOption[];
}

/** Query the live OpenCode environment for available agents and models. */
export async function fetchCatalog(client: OpencodeClient, directory: string): Promise<Catalog> {
  const [agentRes, modelRes] = await Promise.all([
    client.v2.agent.list({location: {directory}}),
    client.v2.model.list({location: {directory}}),
  ]);
  const agentData = (agentRes.data as {data?: AgentV2Info[]} | undefined)?.data ?? [];
  const modelData = (modelRes.data as {data?: ModelV2Info[]} | undefined)?.data ?? [];

  const agents: AgentOption[] = agentData
    .filter((a) => !a.hidden && (a.mode === "primary" || a.mode === "all"))
    .map((a) => ({id: a.id, mode: a.mode, description: a.description}));

  const models: ModelOption[] = modelData
    .filter((m) => m.enabled)
    .map((m) => ({
      providerID: m.providerID,
      modelID: m.id,
      name: m.name,
      status: m.status,
      enabled: m.enabled,
    }));

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
  const parts = trimmed.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return {providerID: parts[0]!, modelID: parts[1]!};
}