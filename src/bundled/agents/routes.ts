import type { JsonValue, OpenTarget } from "../../features/navigation/targets";

type PageTarget = Extract<OpenTarget, { kind: "page" }>;
const providerKey = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

export function agentProviderRoute(value: JsonValue | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const keys = Object.keys(value);
  const provider = (value as Readonly<Record<string, JsonValue>>).provider;
  return keys.length === 1 &&
    keys[0] === "provider" &&
    typeof provider === "string" &&
    providerKey.test(provider)
    ? provider
    : undefined;
}

export const availableAgentProviderRoute = (value: JsonValue) =>
  Boolean(agentProviderRoute(value));

export function agentProviderTarget(
  target: PageTarget,
  provider?: string,
): PageTarget {
  const { route: _route, ...page } = target;
  return provider
    ? { ...page, route: { version: 1, params: { provider } } }
    : page;
}
