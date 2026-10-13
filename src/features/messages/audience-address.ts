import type { ChannelMessage } from "../relay/contracts";
import { profilePanelKey } from "../profiles/target";
import type { profileMentionParts } from "./profile-mentions";

/** Who a message opens by addressing — its leading bound mentions — and the
 * message as shown without them. Display only: a message that is nothing but
 * mentions, or opens with prose, is shown as written. */
export function addressedMessage(
  row: ChannelMessage,
  parts: ReturnType<typeof profileMentionParts>,
): Readonly<{ recipients: readonly string[]; body: ChannelMessage }> {
  const recipients: string[] = [];
  let cut = 0;
  for (const part of parts) {
    const key = part.target && profilePanelKey(part.target);
    if (key) {
      if (!recipients.includes(key)) recipients.push(key);
      cut += part.text.length;
      continue;
    }
    if (part.target) break;
    const gap = /^[ \t,:]*/.exec(part.text)?.[0].length ?? 0;
    cut += gap;
    if (gap < part.text.length) break;
  }
  if (!recipients.length || !row.content.slice(cut).trim())
    return { recipients: [], body: row };
  const seams = row.attachmentSeams
    ?.map((seam) => seam - cut)
    .filter((seam) => seam > 0);
  const { attachmentSeams: _, ...rest } = row;
  return {
    recipients,
    body: {
      ...rest,
      content: row.content.slice(cut),
      ...(seams?.length ? { attachmentSeams: seams } : {}),
    },
  };
}
