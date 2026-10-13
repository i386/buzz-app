import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "../../shared/design-system/icons";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import styles from "./Profiles.module.css";

export function ProfilePublicMetadata({
  nip05,
}: {
  nip05: string | undefined;
}) {
  return nip05 ? (
    <ProfileCopyField key={`nip05:${nip05}`} label="NIP-05" value={nip05} />
  ) : null;
}

function ProfileCopyField({
  label,
  value,
  display = value,
}: {
  label: string;
  value: string;
  display?: string;
}) {
  const notify = useToastNotification();
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div>
      <button
        tabIndex={0}
        type="button"
        className={styles.copyField}
        aria-label={`Copy ${label}: ${display}`}
        title={`Copy ${label}`}
        onClick={() => {
          const current = ++generation.current;
          setCopied(false);
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(value))
            .then(
              () => {
                if (current !== generation.current) return;
                setCopied(true);
                notify(`Copied ${label.toLowerCase()}`, "success");
              },
              () => {
                if (current === generation.current)
                  notify(`Couldn't copy ${label.toLowerCase()}.`, "error");
              },
            );
        }}
      >
        <span className={styles.fieldText}>
          <span className="text-body">{label}</span>
          <span className={styles.fieldValue} title={display}>
            {display}
          </span>
        </span>
        <span
          className={styles.copyIndicator}
          data-copied={copied}
          aria-hidden="true"
        >
          {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
        </span>
      </button>
    </div>
  );
}
