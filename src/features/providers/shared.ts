// A configured inference connection. Harnesses consume its catalog and auth;
// each harness integration owns how that connection becomes API requests.
import type { ComponentType } from "react";
export const DATABRICKS_ID = "buzz.databricks";

export type ProviderModel = Readonly<{
  id: string;
  label: string;
  api: "openai-responses";
  /** A discovery fact; each harness decides which families it can use. */
  family: string;
}>;
export type SharedProvider = Readonly<{
  id: string;
  name: string;
  connected(): Promise<boolean>;
  models(): Promise<readonly ProviderModel[]>;
  Connection: ComponentType<{ onChange(): void; disabled?: boolean }>;
}>;
