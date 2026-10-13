import { hasEventProof, type EventData } from "./events";

/** Verified ownership attribution. Callers must enforce recipients and permissions.
 * Authority must be the configured community's explicit NIP-11 self, not its contact key. */
export function workflowOwner(
  event: EventData,
  authority: string | undefined,
): string | undefined {
  if (!authority || event.pubkey !== authority || event.kind !== 9) return;
  const markers = event.tags.filter(([name]) => name === "buzz:workflow");
  const owners = event.tags.filter(([name]) => name === "buzz:workflow-owner");
  const owner = owners[0]?.[1];
  if (
    markers.length !== 1 ||
    markers[0]?.length !== 2 ||
    markers[0][1] !== "true" ||
    owners.length !== 1 ||
    owners[0]?.length !== 2 ||
    !owner ||
    !/^[0-9a-f]{64}$/.test(owner)
  )
    return;
  // Local intent and caller-owned copies cannot inherit admission-time proof.
  // No signature work occurs while refolding retained history.
  return hasEventProof(event) ? owner : undefined;
}

/** Compact surfaces still identify automation, never the owner as the sender. */
export function workflowLabel(ownerName: string): string {
  return `Workflow · owned by ${ownerName}`;
}

/** Delegated mention provenance. Normal `p` tags can originate in template
 * substitutions; only explicit owner-authored targets grant prompt authority. */
export function workflowMentionOwner(
  event: EventData,
  authority: string | undefined,
  agent: string,
): string | undefined {
  const owner = workflowOwner(event, authority);
  if (!owner) return;
  const targets = new Set<string>();
  for (const tag of event.tags.filter(
    ([name]) => name === "buzz:workflow-mention",
  )) {
    const target = tag[1];
    if (
      tag.length !== 2 ||
      !target ||
      !/^[0-9a-f]{64}$/.test(target) ||
      targets.has(target)
    )
      return;
    targets.add(target);
  }
  return targets.has(agent) ? owner : undefined;
}
