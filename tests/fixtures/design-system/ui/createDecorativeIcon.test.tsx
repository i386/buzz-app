// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  PlusIcon,
  RobotIcon,
} from "../../../../src/shared/design-system/icons/index";

afterEach(cleanup);

it.each([
  ["Tabler", PlusIcon],
  ["custom agent", RobotIcon],
])(
  "preserves %s SVG refs, accessibility, and styling across rerenders",
  (_, Icon) => {
    const ref = createRef<SVGSVGElement>();
    const { rerender } = render(
      <Icon ref={ref} size={15} strokeWidth={2.5} color="red" />,
    );
    expect(ref.current).toHaveAttribute("aria-hidden", "true");
    expect(ref.current).toHaveAttribute("width", "0.9375rem");
    expect(ref.current).toHaveAttribute("height", "0.9375rem");
    expect(ref.current).toHaveAttribute("stroke-width", "2.5");
    expect(ref.current).toHaveAttribute("stroke", "red");

    rerender(
      <Icon
        ref={ref}
        aria-hidden={false}
        role="img"
        aria-label="Add item"
        title="Add item"
        className="custom-icon"
        size={20}
      />,
    );
    expect(screen.getByRole("img", { name: "Add item" })).toBe(ref.current);
    expect(ref.current).toHaveAttribute("aria-hidden", "false");
    expect(ref.current).toHaveAttribute("width", "1.25rem");
    expect(ref.current).toHaveAttribute("stroke-width", "2");
    expect(ref.current).toHaveClass("custom-icon");
    expect(ref.current?.querySelector("title")).toHaveTextContent("Add item");
  },
);
