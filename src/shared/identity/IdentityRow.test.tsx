// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { ToastProvider } from "../design-system/ui/Toast";
import { IdentityRow } from "./IdentityRow";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const pubkey = "ab".repeat(32);

it("previews on hover and copies the full npub", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(
    <ToastProvider>
      <IdentityRow pubkey={pubkey} name="Agent" isAgent />
    </ToastProvider>,
  );
  const trigger = screen.getByRole("button", {
    name: "Preview Agent identity",
  });
  expect(trigger).toHaveAccessibleDescription(
    /Identity preview opens on focus/,
  );
  expect(trigger).not.toHaveAttribute("aria-details");
  await user.hover(trigger);
  const card = await screen.findByRole("dialog", { name: "Agent identity" });
  expect(card).toHaveTextContent(npubEncode(pubkey));
  expect(trigger).toHaveAttribute("aria-details", card.id);
  await user.click(screen.getByRole("button", { name: "Copy npub" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith(npubEncode(pubkey)));
  expect(await screen.findByText("Copied npub")).toBeVisible();
});

it("reports clipboard denial and leaves the full key available for manual copy", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error("denied"),
  );
  render(
    <ToastProvider>
      <IdentityRow pubkey={pubkey} name="Morgan" />
    </ToastProvider>,
  );
  const trigger = screen.getByRole("button", {
    name: "Preview Morgan identity",
  });
  expect(trigger).toHaveAccessibleDescription(/Tab to reach Copy npub/);
  expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await user.tab();
  expect(trigger).toHaveFocus();
  const card = await screen.findByRole("dialog", { name: "Morgan identity" });
  expect(trigger).toHaveAttribute("aria-details", card.id);
  expect(trigger).toHaveAttribute("aria-controls", card.id);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  await user.click(screen.getByRole("button", { name: "Copy npub" }));
  expect(
    await screen.findByText("Couldn’t copy npub. Select the text to copy it."),
  ).toBeVisible();
  expect(card).toHaveTextContent(npubEncode(pubkey));
  expect(screen.queryByText("Copied npub")).not.toBeInTheDocument();
});

beforeEach(() => {
  // jsdom hides [popover] but has no native top layer. Browser tests own paint.
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
});
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
});
