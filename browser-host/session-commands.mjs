import { sessionMetadata } from "../src/features/sessions/metadata.ts";
import { validChannelLabel } from "../src/features/relay/channel-labels.ts";
// Host signing allowlist. No arbitrary kinds, roles or metadata edits.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validChannelCommand(event) {
  if (
    !event ||
    !Number.isSafeInteger(event.created_at) ||
    !Array.isArray(event.tags) ||
    typeof event.content !== "string"
  )
    return false;
  if (
    !event.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((value) => typeof value === "string"),
    )
  )
    return false;
  let tags = event.tags;
  if ([9000, 9007].includes(event.kind) && tags.at(-1)?.[0] === "client-id") {
    const clientId = tags.at(-1);
    if (clientId.length !== 2 || !uuid.test(clientId[1])) return false;
    tags = tags.slice(0, -1);
  }
  const [h, p] = tags;
  if (h?.length !== 2 || h[0] !== "h" || !uuid.test(h[1])) return false;
  if (event.kind === 9007) {
    const expected = ["h", "name", "visibility", "channel_type"];
    // NIP-CL: up to 8 distinct label `t` tags end the command.
    const firstLabel = tags.findIndex(([name]) => name === "t");
    const labels = firstLabel < 0 ? [] : tags.slice(firstLabel);
    if (
      labels.length > 8 ||
      labels.some(
        (tag) =>
          tag.length !== 2 || tag[0] !== "t" || !validChannelLabel(tag[1]),
      ) ||
      new Set(labels.map(([, label]) => label)).size !== labels.length
    )
      return false;
    if (labels.length) tags = tags.slice(0, firstLabel);
    const optional = tags.slice(expected.length);
    const optionalNames = optional.map(([name]) => name);
    const validOptionalOrder = [[], ["about"], ["ttl"], ["about", "ttl"]].some(
      (names) =>
        names.length === optionalNames.length &&
        names.every((name, index) => name === optionalNames[index]),
    );
    const about = optional.find(([name]) => name === "about");
    const ttl = optional.find(([name]) => name === "ttl");
    const aboutValue = about?.[1];
    const ttlValue = ttl?.[1];
    return (
      event.content === "" &&
      tags.length >= expected.length &&
      validOptionalOrder &&
      tags
        .slice(0, expected.length)
        .every(
          (tag, index) => tag.length === 2 && tag[0] === expected[index],
        ) &&
      !!tags[1][1].trim() &&
      [...tags[1][1]].length <= 120 &&
      ["open", "private"].includes(tags[2][1]) &&
      ["stream", "system"].includes(tags[3][1]) &&
      (!about ||
        (about.length === 2 &&
          [...aboutValue].length <= 1000 &&
          (sessionMetadata(aboutValue) !== undefined ||
            !aboutValue.includes("Buzz session (")))) &&
      (!ttl ||
        (ttl.length === 2 &&
          /^(?:[1-9]\d*)$/.test(ttlValue) &&
          Number(ttlValue) <= 2_147_483_647 &&
          sessionMetadata(aboutValue) === undefined))
    );
  }
  if (event.kind === 9000)
    return (
      event.content === "" &&
      tags.length === 2 &&
      p?.length === 2 &&
      p[0] === "p" &&
      /^[0-9a-f]{64}$/.test(p[1])
    );
  return false;
}
