import { useEffect, useState } from "react";
import type { DraftAttachment } from "./attachment-draft";

/** Each mounted preview owns its local URL; uploaded metadata is authoritative. */
export function useDraftAttachmentSource(
  item: DraftAttachment,
  media: (url: string) => string | undefined,
) {
  const { type, image, video } = draftAttachmentMedia(item);
  const [local, setLocal] = useState<{ file: File; url: string }>();
  const uploaded = !!item.uploaded;
  const localPreview =
    image || video || type.startsWith("audio/") || !!item.voice;
  useEffect(() => {
    if (uploaded || !localPreview) return;
    const url = URL.createObjectURL(item.file);
    setLocal({ file: item.file, url });
    return () => URL.revokeObjectURL(url);
  }, [item.file, uploaded, localPreview]);
  const source = item.uploaded
    ? media(item.uploaded.url)
    : local?.file === item.file
      ? local.url
      : undefined;
  return { source, type, image, video };
}

export function draftAttachmentMedia(item: DraftAttachment) {
  const type = item.uploaded?.type || item.file.type || "";
  const image =
    /^image\/(png|jpeg|gif|webp)$/.test(type) ||
    (!item.uploaded && /\.(png|jpe?g|gif|webp)$/i.test(item.file.name));
  const video =
    type.startsWith("video/") ||
    (!item.uploaded && /\.(mp4|mov|webm|m4v)$/i.test(item.file.name));
  return { type, image, video };
}
