import { forwardRef } from "react";
import type { IconProps } from "./createDecorativeIcon";

/** Designer-approved Soft & wide mark: fuller canvas with narrow, inward ears. */
export const RobotArtwork = forwardRef<SVGSVGElement, IconProps>(
  function RobotArtwork(
    { size = "1em", color = "currentColor", title, ...props },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        color={color}
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {title && <title>{title}</title>}
        <rect x="4.75" y="7" width="14.5" height="13.25" rx="4.5" />
        <path d="M12 7V2.5M3.25 11.5v4.25M20.75 11.5v4.25" />
        <g fill="currentColor" stroke="none">
          <circle cx="9" cy="13.25" r="1.4" />
          <circle cx="15" cy="13.25" r="1.4" />
        </g>
      </svg>
    );
  },
);
