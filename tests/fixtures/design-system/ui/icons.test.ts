import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import * as gatewayIcons from "../../../../src/shared/design-system/icons/index";
import {
  createIconInventory,
  CUSTOM_ICONS,
  TABLER_ICONS,
} from "../../../../src/shared/design-system/icons/inventory";

it("derives the complete categorized inventory from the public gateway", () => {
  const tablerNames = TABLER_ICONS.map(({ name }) => name);
  const customNames = CUSTOM_ICONS.map(({ name }) => name);

  expect(customNames).toEqual([
    "BestieIcon",
    "ClaudeLogoIcon",
    "CodexLogoIcon",
    "GitHubIssueIcon",
    "GooseLogoIcon",
    "HashArrowInIcon",
    "HermesLogoIcon",
    "NotificationFilledIcon",
    "OneDriveLogoIcon",
    "PiLogoIcon",
  ]);
  expect([...tablerNames, ...customNames].sort()).toEqual(
    Object.keys(gatewayIcons).sort(),
  );
  expect(tablerNames).toEqual(
    [...tablerNames].sort((a, b) => a.localeCompare(b)),
  );
  expect(CUSTOM_ICONS).toEqual([
    expect.objectContaining({
      name: "BestieIcon",
      category: "Product mark",
      intendedSizes: [
        { width: 15, height: 15 },
        { width: 17, height: 17 },
      ],
    }),
    expect.objectContaining({
      name: "ClaudeLogoIcon",
      category: "Custom brand mark",
      intendedSizes: [{ width: 32, height: 32 }],
    }),
    expect.objectContaining({
      name: "CodexLogoIcon",
      category: "Custom brand mark",
      intendedSizes: [{ width: 32, height: 32 }],
    }),
    expect.objectContaining({
      name: "GitHubIssueIcon",
      category: "Product mark",
      intendedSizes: [{ width: 22, height: 22 }],
    }),
    expect.objectContaining({
      name: "GooseLogoIcon",
      category: "Custom brand mark",
      intendedSizes: [{ width: 32, height: 32 }],
    }),
    expect.objectContaining({
      name: "HashArrowInIcon",
      category: "messaging",
      intendedSizes: [{ width: 16, height: 16 }],
    }),
    expect.objectContaining({
      name: "HermesLogoIcon",
      category: "Custom brand mark",
      intendedSizes: [
        { width: 24, height: 24 },
        { width: 32, height: 32 },
        { width: 48, height: 48 },
      ],
    }),
    expect.objectContaining({
      name: "NotificationFilledIcon",
      category: "State indicator",
      intendedSizes: [{ width: 20, height: 20 }],
    }),
    expect.objectContaining({
      name: "OneDriveLogoIcon",
      category: "Custom brand mark",
      intendedSizes: [{ width: 14, height: 14 }],
    }),
    expect.objectContaining({
      name: "PiLogoIcon",
      category: "Custom brand mark",
      intendedSizes: [{ width: 32, height: 32 }],
    }),
  ]);
});

it("fails loudly rather than classifying an unapproved gateway export", () => {
  const UnclassifiedIcon = () => createElement("svg", { role: "img" });

  expect(() =>
    createIconInventory({ ...gatewayIcons, UnclassifiedIcon }),
  ).toThrowError("Unclassified icon gateway export: UnclassifiedIcon");
  expect(renderToStaticMarkup(createElement(UnclassifiedIcon))).not.toContain(
    'aria-hidden="true"',
  );
});

it("keeps every classified gateway icon decorative by default", () => {
  for (const Icon of Object.values(gatewayIcons)) {
    expect(renderToStaticMarkup(createElement(Icon))).toContain(
      'aria-hidden="true"',
    );
  }
});

it("renders every Tabler glyph with the existing size and color contract", () => {
  for (const { component: Icon } of TABLER_ICONS) {
    const markup = renderToStaticMarkup(
      createElement(Icon, { size: 18, color: "red", className: "test-icon" }),
    );
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('width="1.125rem"');
    expect(markup).toContain('height="1.125rem"');
    expect(markup).toContain("test-icon");
    expect(markup).toMatch(
      /<(path|circle|rect|line|polyline|polygon|ellipse)\b/,
    );
    expect(markup).toMatch(/(?:stroke|fill)="red"/);
  }
  expect(renderToStaticMarkup(createElement(gatewayIcons.PlusIcon))).toContain(
    'width="1em"',
  );
  expect(
    renderToStaticMarkup(
      createElement(gatewayIcons.PlusIcon, { strokeWidth: 2.5 }),
    ),
  ).toContain('stroke-width="2.5"');
  for (const Icon of [
    gatewayIcons.PlayFilledIcon,
    gatewayIcons.PauseFilledIcon,
  ]) {
    const markup = renderToStaticMarkup(createElement(Icon));
    expect(markup).toContain('fill="currentColor"');
    expect(markup).not.toContain("weight=");
  }
});

it("renders the formatting icon as Tabler letter-case Aa", () => {
  expect(
    renderToStaticMarkup(createElement(gatewayIcons.TextAaIcon)),
  ).toContain("tabler-icon-letter-case");
});
