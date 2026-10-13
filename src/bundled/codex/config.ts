export type Config = {
  model: string;
  effort: string;
  instructions: string;
  workspace: string;
  scope: "thread" | "channel";
};
export type Model = {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
};
export const defaults: Config = {
  model: "",
  effort: "",
  instructions: "",
  workspace: "~/.buzz",
  scope: "thread",
};
export function config(raw: unknown): Config {
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    model: typeof value.model === "string" ? value.model : "",
    effort: typeof value.effort === "string" ? value.effort : "",
    instructions:
      typeof value.instructions === "string" ? value.instructions : "",
    workspace:
      typeof value.workspace === "string" && value.workspace.trim()
        ? value.workspace.trim()
        : defaults.workspace,
    scope: value.scope === "channel" ? "channel" : "thread",
  };
}
export const effortName = (effort: string) =>
  ({ xhigh: "Extra high", max: "Maximum", ultra: "Ultra" })[effort] ??
  `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;

export const absoluteWorkspace = (path: string) =>
  path.trim().startsWith("/") || /^[A-Za-z]:[\\/]/.test(path.trim());

export const validWorkspace = (path: string) =>
  path.trim() === defaults.workspace || absoluteWorkspace(path);
