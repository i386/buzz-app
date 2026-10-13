import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";

export type InputProps = Omit<ComponentProps<typeof BaseInput>, "className"> & {
  controlSize?: "sm" | "md";
  /** `title` sets the value as a page title with no field around it. */
  appearance?: "field" | "title";
};
export function Input({
  controlSize = "md",
  appearance = "field",
  ...props
}: InputProps) {
  return (
    <BaseInput
      {...props}
      data-buzz-ui=""
      data-size={controlSize}
      data-appearance={appearance === "field" ? undefined : appearance}
      className="buzz-input"
    />
  );
}
