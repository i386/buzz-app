// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ToastSpecimens } from "./ToastSpecimens";

afterEach(cleanup);

it("hides portaled notices in Code and restores unresolved recovery in Preview", async () => {
  render(createElement(ToastSpecimens));
  fireEvent.click(screen.getByRole("button", { name: "Show recovery" }));
  expect(
    await screen.findByRole("dialog", { name: "Changes weren’t saved" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Code" }));
  expect(screen.getByRole("tabpanel", { name: "Code" })).toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "App notifications" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry saving" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
  expect(
    await screen.findByRole("dialog", { name: "Changes weren’t saved" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
  expect(
    screen.queryByRole("dialog", { name: "Changes weren’t saved" }),
  ).not.toBeInTheDocument();
});
