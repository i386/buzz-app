import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AvatarStack } from "./AvatarStack";

it("renders nothing for an empty group", () => {
  expect(renderToStaticMarkup(<AvatarStack items={[]} />)).toBe("");
});
it("caps artwork at three, retains identity shapes and counts overflow", () => {
  const html = renderToStaticMarkup(
    <AvatarStack
      items={[
        { id: "1", name: "Alex", shape: "circle" },
        { id: "2", name: "Brain", shape: "squircle" },
        { id: "3", name: "Casey", shape: "circle" },
        { id: "4", name: "Fourth", shape: "squircle" },
        { id: "5", name: "Fifth", shape: "circle" },
      ]}
    />,
  );
  expect(html.match(/class="buzz-avatar"/g)).toHaveLength(3);
  expect(html).toContain('data-avatar-shape="circle"');
  expect(html).toContain('data-avatar-shape="squircle"');
  expect(html).toContain('title="Brain"');
  expect(html).toContain(">+2</span>");
  expect(html).not.toContain('role="img"');
  expect(html).not.toContain("aria-label=");
});
it("does not add a count when all avatars fit", () => {
  const html = renderToStaticMarkup(
    <AvatarStack
      size="small"
      items={[{ id: "1", name: "Alex", shape: "circle" }]}
    />,
  );
  expect(html).toContain('data-size="small"');
  expect(html).not.toContain(">+");
});
