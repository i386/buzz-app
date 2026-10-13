import styles from "./TypingDots.module.css";

/** Shared activity motion. Callers own receipt/work evidence and accessible labels. */
export function TypingDots({
  state = "working",
}: {
  state?: "waiting" | "working";
}) {
  return (
    <span className={styles.dots} data-state={state} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
