import { Avatar } from "./Avatar";
import styles from "./AvatarStack.module.css";

type StackAvatar = {
  id: string;
  name: string;
  src?: string | undefined;
  shape: "circle" | "squircle";
};

/** Compact identity artwork. The enclosing control supplies its accessible name. */
export function AvatarStack({
  items,
  size = "compact",
}: {
  items: readonly StackAvatar[];
  size?: "compact" | "small";
}) {
  if (!items.length) return null;
  return (
    <span
      className={`${styles.root} text-caption`}
      aria-hidden="true"
      data-avatar-stack=""
      data-size={size}
    >
      {items.slice(0, 3).map((item) => (
        <span
          key={item.id}
          className={styles.item}
          data-avatar-shape={item.shape}
          title={item.name}
        >
          <Avatar
            src={item.src}
            alt=""
            fallback={item.name}
            shape={item.shape}
            size="fill"
          />
        </span>
      ))}
      {items.length > 3 && (
        <span className={styles.count}>+{items.length - 3}</span>
      )}
    </span>
  );
}
