import { npubEncode } from "nostr-tools/nip19";

/** The full npub of a hex public key, or undefined for anything else. */
export function canonicalPublicKey(pubkey: string): string | undefined {
  return /^[0-9a-f]{64}$/i.test(pubkey)
    ? npubEncode(pubkey.toLowerCase())
    : undefined;
}

/** Display only: never use this abbreviation for copying, storage or routing. */
export function formatPublicKey(
  pubkey: string,
  suffixLength = 3,
): string | undefined {
  const npub = canonicalPublicKey(pubkey);
  if (!npub) return undefined;
  const length = Number.isInteger(suffixLength)
    ? Math.max(3, Math.min(suffixLength, npub.length - 5))
    : 3;
  return `npub…${npub.slice(-length)}`;
}

/** Distinct public identities share the shortest unambiguous suffix, starting at three. */
export function publicKeyLabels(
  pubkeys: Iterable<string>,
): ReadonlyMap<string, string> {
  const encoded = new Map<string, string>();
  for (const pubkey of pubkeys) {
    const npub = canonicalPublicKey(pubkey);
    if (npub) encoded.set(pubkey.toLowerCase(), npub);
  }
  let length = 3;
  const values = [...encoded.values()];
  while (
    length < 58 &&
    new Set(values.map((npub) => npub.slice(-length))).size < values.length
  )
    length++;
  return new Map(
    [...encoded].map(([pubkey, npub]) => [
      pubkey,
      `npub…${npub.slice(-length)}`,
    ]),
  );
}
