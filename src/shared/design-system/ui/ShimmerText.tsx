import type { ReactNode } from "react";
import styles from "./ShimmerText.module.css";

/** Live-work text sheen. The caller decides when work is live; text stays readable and unchanged for assistive tech. */
export function ShimmerText({
  active = true,
  children,
}: {
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={styles.text} data-active={active || undefined}>
      {children}
    </span>
  );
}
