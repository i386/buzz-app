// Goose maps a shared connection to its own command-auth provider. Request
// formatting and streaming remain in Goose, and no refresh token leaves Buzz.
import { invoke } from "@tauri-apps/api/core";
import { DATABRICKS_ID } from "../../features/providers/shared";

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
