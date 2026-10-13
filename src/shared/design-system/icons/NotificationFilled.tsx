import { forwardRef } from "react";
import type { IconProps } from "./createDecorativeIcon";

/** Designer-requested filled counterpart to Tabler's outline Notification. */
export const NotificationFilledArtwork = forwardRef<SVGSVGElement, IconProps>(
  function NotificationFilledArtwork({ size = "1em", ...props }, ref) {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        {...props}
      >
        <path d="M10 5H7a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-3a1 1 0 0 0-1-1h-1a6 6 0 0 1-6-6V6a1 1 0 0 0-1-1Z" />
        <circle cx="17" cy="7" r="4" />
      </svg>
    );
  },
);
