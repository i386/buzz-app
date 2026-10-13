import { Button as BaseButton } from "@base-ui/react/button";
import { CircleNotchIcon } from "../icons/index";
import type { ComponentProps, ReactNode } from "react";
import { Tooltip } from "./Tooltip";

type ButtonVariant =
  | "prominent"
  | "subtle"
  | "ghost"
  | "destructive"
  | "outline"
  | "inverted"
  | "link"
  | "primary"
  | "quiet";
type ButtonSize = "inline" | "xs" | "sm" | "md" | "lg" | "compact" | "default";

export type ButtonProps = Omit<
  ComponentProps<typeof BaseButton>,
  "className"
> & {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: "capsule" | "control";
  loading?: boolean;
};

/** Base UI owns activation. Legacy variant/size names remain during migration. */
export function Button({
  children,
  variant = "subtle",
  size = "md",
  shape = "capsule",
  type = "button",
  loading = false,
  disabled,
  onClick,
  title,
  ...props
}: ButtonProps) {
  const control = (
    <BaseButton
      {...props}
      type={type}
      disabled={disabled || loading}
      focusableWhenDisabled={
        props.focusableWhenDisabled ?? (loading && !disabled)
      }
      aria-busy={loading || props["aria-busy"]}
      onClick={(event) => {
        if (loading || disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      data-buzz-ui=""
      className="buzz-button"
      data-variant={
        variant === "primary"
          ? "prominent"
          : variant === "quiet"
            ? "subtle"
            : variant
      }
      data-size={size === "compact" ? "sm" : size === "default" ? "md" : size}
      data-button-shape={shape}
      data-loading={loading || undefined}
    >
      <span className="buzz-button-label">{children}</span>
      {loading && (
        <CircleNotchIcon
          className="buzz-button-spinner"
          size={18}
          aria-hidden="true"
        />
      )}
    </BaseButton>
  );
  // Keep the native title API at call sites, but share the hint's appearance
  // and dismissal behavior. Content titles on non-controls remain native.
  return title ? (
    <Tooltip content={title} disableHoverablePopup>
      {control}
    </Tooltip>
  ) : (
    control
  );
}
