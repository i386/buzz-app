// Goose maps a shared connection to its own command-auth provider. Request
// formatting and streaming remain in Goose, and no refresh token leaves Buzz.
import { invoke } from "@tauri-apps/api/core";
import {
  DATABRICKS_ID,
  type ProviderModel,
} from "../../features/providers/shared";

/** Served models verified with Goose's tools over the Responses route, in
 * picker order. Others in the catalog are not yet known to work. */
const GOOSE_MODELS = [
  "databricks-gpt-6-1-sol",
  "databricks-gpt-6-sol",
  "databricks-gpt-6-luna",
  "databricks-gpt-6-astra",
  "databricks-claude-opus-5-5",
  "databricks-claude-sonnet-5-5",
  "databricks-claude-haiku-5-5",
  "databricks-glm-5-3",
  "databricks-grok-4-7",
];
export const gooseModels = (models: readonly ProviderModel[]) =>
  GOOSE_MODELS.flatMap((id) => models.filter((model) => model.id === id));

export async function sharedProviderEnv(
  provider: string,
  model: string,
  available = true,
) {
  if (provider !== DATABRICKS_ID) return {};
  if (!available)
    throw new Error("Enable the Databricks provider plugin first");
  if (!model.trim()) throw new Error("Choose a Databricks model first");
  const prepared = await invoke<Record<string, string>>("databricks_provider", {
    operation: "goose",
    input: { model },
  });
  return {
    DATABRICKS_TOKEN: null,
    DATABRICKS_HOST: null,
    OPENAI_API_KEY: null,
    ANTHROPIC_API_KEY: null,
    ...prepared,
  };
}
