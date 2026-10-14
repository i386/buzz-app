// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { isTauri } from "@tauri-apps/api/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PanelWorkspace } from "../features/panels/PanelWorkspace";
import { ShortcutsService } from "../features/shortcuts/service";
import { forwardTerminalKey } from "../features/shortcuts/terminal-key-event";
import { createAppearance } from "../shared/theme/service";
import { registerAppShortcuts } from "./shortcuts";

const close = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close }),
}));

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  close.mockClear();
  vi.mocked(isTauri).mockReturnValue(true);
});

function harness(platform = "Win32") {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const shortcuts = new ShortcutsService(ctx);
  const appearance = createAppearance(window);
  const remove = registerAppShortcuts(shortcuts, appearance, vi.fn(), true);
  return {
    ctx,
    shortcuts,
    remove,
    async dispose() {
      remove();
      appearance.dispose();
      await ctx.fiber.dispose();
    },
  };
}

function Tabs() {
  const [ids, setIds] = useState(["First", "Second"]);
  const [value, select] = useState("First");
  return ids.length ? (
    <PanelWorkspace
      value={value}
      select={select}
      items={ids.map((id) => ({
        id,
        label: id,
        content: <input aria-label={`${id} draft`} />,
        close() {
          const next = ids.filter((item) => item !== id);
          setIds(next);
          select(next[0] ?? "");
        },
      }))}
    />
  ) : null;
}

function press(
  target: EventTarget = document.body,
  init: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key: "w",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

it.each(["Win32"])(
  "%s closes tabs from the composer, never the window; ignores held repeats",
  async (platform) => {
    const h = harness(platform);
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    try {
      render(
        <>
          <input aria-label="Main composer" />
          <Tabs />
        </>,
      );
      const composer = screen.getByRole("textbox", { name: "Main composer" });
      composer.focus();
      expect(press(composer).defaultPrevented).toBe(true);
      expect(
        screen.queryByRole("tab", { name: "First" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Second" })).toBeInTheDocument();
      expect(close).not.toHaveBeenCalled();
      expect(press(document.body, { repeat: true }).defaultPrevented).toBe(
        true,
      );
      expect(screen.getByRole("tab", { name: "Second" })).toBeInTheDocument();
      press();
      expect(screen.queryByRole("tab")).not.toBeInTheDocument();
      expect(close).not.toHaveBeenCalled();
      press(document.body, { repeat: true });
      expect(close).not.toHaveBeenCalled();
      press();
      expect(close).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  },
);

it.each(["Win32"])(
  "%s preserves terminal Ctrl+W before PTY translation and blocks competing plugins",
  async (platform) => {
    const h = harness(platform);
    const pluginRun = vi.fn();
    await h.ctx
      .extend({ pluginOwner: { id: "example.keys", revision: "one" } })
      .plugin((ctx) => {
        ctx.shortcuts.register({
          id: "steal-close",
          title: "Competing shortcut",
          binding: { key: "w", mod: true },
          allowInEditable: true,
          run: pluginRun,
        });
      })
      .await();
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const input = document.createElement("textarea");
    terminal.append(input);
    document.body.append(terminal);
    const toPty = vi.fn();
    input.addEventListener("keydown", (event) => {
      if (forwardTerminalKey(window, event)) toPty("\u0017");
    });
    const tabClose = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener("buzz:close-active-tab", tabClose);
    try {
      input.focus();
      expect(press(input).defaultPrevented).toBe(false);
      expect(toPty).toHaveBeenCalledWith("\u0017");
      expect(tabClose).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(pluginRun).not.toHaveBeenCalled();
      input.blur();
      press();
      expect(tabClose).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("buzz:close-active-tab", tabClose);
      await h.dispose();
    }
  },
);

it("does nothing behind a modal, with or without a tab consumer", async () => {
  const h = harness();
  const tabClose = vi.fn((event: Event) => event.preventDefault());
  render(
    <dialog open>
      <input aria-label="Modal input" />
    </dialog>,
  );
  const input = screen.getByRole("textbox");
  input.focus();
  try {
    press(input);
    expect(close).not.toHaveBeenCalled();
    window.addEventListener("buzz:close-active-tab", tabClose);
    press(input);
    expect(tabClose).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("buzz:close-active-tab", tabClose);
    await h.dispose();
  }
});

it("leaves hidden tabs intact and keeps the window open", async () => {
  const h = harness();
  try {
    render(
      <div hidden>
        <Tabs />
      </div>,
    );
    press();
    expect(close).not.toHaveBeenCalled();
    expect(screen.getAllByRole("tab", { hidden: true })).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});

it.each([
  [false, "Win32"],
  [true, "MacIntel"],
] as const)(
  "does not register a DOM close shortcut for desktop=%s, platform=%s",
  async (desktop, platform) => {
    vi.mocked(isTauri).mockReturnValue(desktop);
    const h = harness(platform);
    try {
      expect(
        h.shortcuts
          .hostSnapshot()
          .some(({ id }) =>
            ["close-tab", "next-tab", "previous-tab"].includes(id),
          ),
      ).toBe(false);
      expect(press().defaultPrevented).toBe(false);
      expect(
        press(document.body, { ctrlKey: false, metaKey: true })
          .defaultPrevented,
      ).toBe(false);
      expect(close).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  },
);

it("respects IME/editor guards, exact modifiers, Alt+F4 and registration disposal", async () => {
  const h = harness();
  const input = document.createElement("input");
  document.body.append(input);
  input.addEventListener("keydown", (event) => event.preventDefault());
  try {
    press(input);
    for (const init of [
      { isComposing: true },
      { keyCode: 229 },
      { modifierAltGraph: true },
      { altKey: true },
      { shiftKey: true },
      { metaKey: true },
      { ctrlKey: false, key: "F4", altKey: true },
    ]) {
      expect(press(document.body, init).defaultPrevented).toBe(false);
    }
    expect(close).not.toHaveBeenCalled();
    h.remove();
    expect(press().defaultPrevented).toBe(false);
    expect(close).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

it("Win32 Ctrl+Tab and Ctrl+Shift+Tab request the next and previous tab, even while typing", async () => {
  const h = harness();
  const requests: string[] = [];
  const record = (event: Event) => requests.push(event.type);
  window.addEventListener("buzz:next-tab", record);
  window.addEventListener("buzz:previous-tab", record);
  const input = document.createElement("input");
  document.body.append(input);
  try {
    input.focus();
    expect(press(input, { key: "Tab" }).defaultPrevented).toBe(true);
    press(input, { key: "Tab", shiftKey: true });
    press(input, { key: "Tab", repeat: true });
    expect(requests).toEqual([
      "buzz:next-tab",
      "buzz:previous-tab",
      "buzz:next-tab",
    ]);
    expect(press(input, { key: "Tab", ctrlKey: false }).defaultPrevented).toBe(
      false,
    );
    expect(requests).toHaveLength(3);
  } finally {
    window.removeEventListener("buzz:next-tab", record);
    window.removeEventListener("buzz:previous-tab", record);
    await h.dispose();
  }
});
