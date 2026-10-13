// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelPicker, type ModelChoice } from "./ModelPicker";

beforeEach(() => {
  // jsdom has no layout observers; the compact picker sizes itself with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const models: ModelChoice[] = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus", description: "Most capable" },
];

function setup(value = "", props: { compact?: boolean } = {}) {
  const onChange = vi.fn();
  const view = render(
    <ModelPicker
      models={models}
      value={value}
      defaultLabel="Default model"
      onChange={onChange}
      {...props}
    />,
  );
  return { onChange, view, user: userEvent.setup() };
}

const input = () => screen.getByRole("combobox", { name: "Model" });

it("shows the default's label when no model is chosen", () => {
  setup("");
  expect(input()).toHaveValue("Default model");
});

it("shows the chosen model's label", () => {
  setup("opus");
  expect(input()).toHaveValue("Opus");
});

it("picks a listed model", async () => {
  const { onChange, user } = setup("");
  await user.click(input());
  await user.click(await screen.findByRole("option", { name: /Sonnet/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("sonnet");
});

it("picks the default as an empty value", async () => {
  const { onChange, user } = setup("opus");
  await user.click(input());
  await user.click(
    await screen.findByRole("option", { name: /Default model/ }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("");
});

it("commits a typed custom ID on Enter", async () => {
  const { onChange, user } = setup("");
  await user.clear(input());
  await user.type(input(), "my-model-1{Enter}");
  expect(onChange).toHaveBeenLastCalledWith("my-model-1");
});

it("commits a typed custom ID when focus leaves", async () => {
  const { onChange, user } = setup("");
  await user.clear(input());
  await user.type(input(), "  my-model-2  ");
  await user.tab();
  expect(onChange).toHaveBeenLastCalledWith("my-model-2");
});

it("commits a typed label as that model's ID", async () => {
  const { onChange, user } = setup("");
  await user.clear(input());
  await user.type(input(), "Opus");
  await user.keyboard("{Enter}");
  expect(onChange).toHaveBeenLastCalledWith("opus");
});

it("shows a saved value that is not listed as a custom model", async () => {
  const { user } = setup("claude-old-1");
  expect(input()).toHaveValue("claude-old-1");
  await user.click(input());
  const option = await screen.findByRole("option", { name: /claude-old-1/ });
  expect(option).toHaveTextContent("Custom model");
  expect(option).toHaveAttribute("aria-selected", "true");
});

it("offers a typed ID that matches nothing as a custom model", async () => {
  const { user } = setup("");
  await user.clear(input());
  await user.type(input(), "zzz-unlisted");
  const option = await screen.findByRole("option", { name: /zzz-unlisted/ });
  expect(option).toHaveTextContent("Custom model");
});

it("is disabled as a whole", () => {
  render(
    <ModelPicker
      models={models}
      value=""
      defaultLabel="Default model"
      onChange={vi.fn()}
      disabled
    />,
  );
  expect(input()).toBeDisabled();
});

it("works compact, in the dialog's corner", async () => {
  const { onChange, user } = setup("sonnet", { compact: true });
  expect(input()).toHaveValue("Sonnet");
  await user.click(input());
  await user.click(await screen.findByRole("option", { name: /Opus/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("opus");
});
