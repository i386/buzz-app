import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { CloudUploadIcon } from "../../shared/design-system/icons";
import styles from "./Messages.module.css";

/** The existing nearest-pane drop owner also owns its visible affordance. */
export function FileDropOverlay({
  composer,
}: {
  composer: RefObject<HTMLFormElement | null>;
}) {
  const zone =
    composer.current?.closest<HTMLElement>("[data-attachment-drop-zone]") ??
    composer.current;
  return zone
    ? createPortal(
        <div className={styles.fileDropOverlay} role="status">
          <CloudUploadIcon size={32} />
          <span>Drop files into this conversation</span>
        </div>,
        zone,
      )
    : null;
}
