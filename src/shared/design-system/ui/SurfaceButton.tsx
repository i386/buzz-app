import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps } from "react";

/** Proposed artwork control: the caller owns media layout; the shared control
 * owns activation and keyboard focus without adding a text-button wrapper. */
export function SurfaceButton({
  className,
  ...props
}: ComponentProps<typeof BaseButton>) {
  return (
    <BaseButton
      {...props}
      data-buzz-ui=""
      className={(state) =>
        `buzz-surface-button ${typeof className === "function" ? className(state) : (className ?? "")}`
      }
    />
  );
}
