// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import closeRequest from "../../../src-tauri/src/close-request.js?raw";
import switchTabRequest from "../../../src-tauri/src/switch-tab-request.js?raw";
import { PanelWorkspace, usePanelTabTitle } from "./PanelWorkspace";
import { PanelSubview } from "./PanelSubview";
import { PanelDock } from "./PanelDock";

afterEach(() => {
  delete document.documentElement.dataset.keyboardNavigation;
  cleanup();
  vi.restoreAllMocks();
});
function Profile({ authorized }: { authorized: boolean }) {
  usePanelTabTitle("Ada");
  const [log, setLog] = useState(false);
  return (
    <>
      <input aria-label="Profile draft" />
      <button type="button" onClick={() => setLog(true)}>
        Open log
      </button>
      {log && authorized && (
        <PanelSubview
          title="Harness log"
          backLabel="Back to profile"
          onBack={() => setLog(false)}
        >
          <input aria-label="Log filter" />
        </PanelSubview>
      )}
    </>
  );
}
function Fixture({
  authorized = true,
  focusOnMount = true,
}: {
  authorized?: boolean;
  focusOnMount?: boolean;
}) {
  const [ids, setIds] = useState(["Thread", "Profile"]);
  const [value, select] = useState("Thread");
  return ids.length ? (
    <PanelWorkspace
      focusOnMount={focusOnMount}
      value={value}
      select={select}
      items={ids.map((id) => ({
        id,
        label: id,
        close() {
          const next = ids.filter((item) => item !== id);
          setIds(next);
          if (id === value) select(next[0] ?? "");
        },
        content:
          id === "Thread" ? (
            <input aria-label="Thread draft" />
          ) : (
            <Profile authorized={authorized} />
          ),
      }))}
    />
  ) : (
    <p>No open panels</p>
  );
}
const tabs = () => screen.getByRole("tablist", { name: "Panel tabs" });
const tab = (name: string) => within(tabs()).getByRole("tab", { name });

test("switches retained panels, associates their tabs, and closes inactive or active tabs with focus recovery", async () => {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  const draft = screen.getByRole("textbox", { name: "Thread draft" });
  await user.type(draft, "Keep this draft");
  expect(screen.getByRole("tabpanel", { name: "Thread" })).toContainElement(
    draft,
  );
  await user.click(tab("Ada"));
  expect(screen.queryByRole("textbox", { name: "Thread draft" })).toBeNull();
  expect(draft).toBeInTheDocument();
  await user.click(tab("Thread"));
  expect(screen.getByRole("textbox", { name: "Thread draft" })).toBe(draft);
  expect(draft).toHaveValue("Keep this draft");
  await user.click(screen.getByRole("button", { name: "Close Ada tab" }));
  expect(tab("Thread")).toHaveFocus();
  await user.keyboard("{Delete}");
  expect(screen.getByText("No open panels")).toBeVisible();
});

test("local details are retained sibling tabs and close without dismissing the profile", async () => {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(tab("Ada"));
  await user.click(screen.getByRole("button", { name: "Open log" }));
  expect(tab("Harness log")).toHaveFocus();
  const filter = screen.getByRole("textbox", { name: "Log filter" });
  await user.type(filter, "warning");
  await user.click(tab("Ada"));
  expect(screen.getByRole("textbox", { name: "Profile draft" })).toBeVisible();
  expect(filter).toBeInTheDocument();
  await user.click(tab("Harness log"));
  expect(screen.getByRole("textbox", { name: "Log filter" })).toBe(filter);
  expect(filter).toHaveValue("warning");
  await user.keyboard("{Escape}");
  expect(within(tabs()).queryByRole("tab", { name: "Harness log" })).toBeNull();
  expect(tab("Ada")).toHaveFocus();
  expect(filter).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Open log" }));
  await user.click(tab("Ada"));
  await user.click(
    screen.getByRole("button", { name: "Close Harness log tab" }),
  );
  expect(tab("Ada")).toHaveFocus();
  expect(within(tabs()).queryByRole("tab", { name: "Harness log" })).toBeNull();
});

test("revoking access removes the local tab; closing its owner also removes retained local content", async () => {
  const user = userEvent.setup();
  const view = render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(tab("Ada"));
  await user.click(screen.getByRole("button", { name: "Open log" }));
  view.rerender(
    <StrictMode>
      <Fixture authorized={false} />
    </StrictMode>,
  );
  expect(
    screen.queryByRole("textbox", { name: "Log filter", hidden: true }),
  ).toBeNull();
  expect(tab("Ada")).toHaveFocus();
  view.rerender(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(tab("Thread"));
  await user.click(screen.getByRole("button", { name: "Close Ada tab" }));
  expect(
    screen.queryByRole("textbox", { name: "Log filter", hidden: true }),
  ).toBeNull();
  expect(within(tabs()).getAllByRole("tab")).toHaveLength(1);
  expect(tab("Thread")).toHaveFocus();
});

for (const action of ["close", "escape"]) {
  test(`reopening the last tab during its ${action} exit restores focus`, async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const original = HTMLElement.prototype.getAnimations;
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      writable: true,
      value: () => [{ finished }],
    });
    function Host() {
      const [opening, setOpening] = useState<object | null>(null);
      const open = !!opening;
      const trigger = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={trigger} type="button" onClick={() => setOpening({})}>
            Open profile
          </button>
          <PanelDock open={open} className="">
            {opening && (
              <PanelWorkspace
                value="profile"
                select={() => {}}
                items={[
                  {
                    id: "profile",
                    instance: opening,
                    label: "Profile",
                    content: <input aria-label="Profile draft" />,
                    close() {
                      setOpening(null);
                      trigger.current?.focus();
                    },
                  },
                ]}
              />
            )}
          </PanelDock>
        </>
      );
    }
    try {
      render(<Host />);
      const trigger = screen.getByRole("button", { name: "Open profile" });
      fireEvent.click(trigger);
      expect(tab("Profile")).toHaveFocus();
      if (action === "close")
        fireEvent.click(
          screen.getByRole("button", { name: "Close Profile tab" }),
        );
      else fireEvent.keyDown(tab("Profile"), { key: "Escape" });
      expect(trigger).toHaveFocus();
      expect(
        screen
          .getByRole("textbox", { name: "Profile draft", hidden: true })
          .closest("[inert]"),
      ).not.toBeNull();
      fireEvent.click(trigger);
      expect(tab("Profile")).toHaveFocus();
      await act(async () => finish());
      expect(tab("Profile")).toHaveFocus();
    } finally {
      finish();
      if (original) HTMLElement.prototype.getAnimations = original;
      else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    }
  });
}

test("a restored workspace leaves existing focus alone but fresh selections and local details take focus", async () => {
  const user = userEvent.setup();
  const view = render(<input aria-label="Main draft" />);
  const main = screen.getByRole("textbox", { name: "Main draft" });
  main.focus();
  view.rerender(
    <>
      <input aria-label="Main draft" />
      <StrictMode>
        <Fixture focusOnMount={false} />
      </StrictMode>
    </>,
  );
  expect(main).toHaveFocus();
  await user.click(tab("Ada"));
  expect(tab("Ada")).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Open log" }));
  expect(tab("Harness log")).toHaveFocus();
});

test("choosing a tab with the pointer resumes its composer; the keyboard stays in the tabs", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [value, select] = useState("One");
    return (
      <PanelWorkspace
        value={value}
        select={select}
        items={["One", "Two"].map((id) => ({
          id,
          label: id,
          content: (
            <>
              <button type="button">{`${id} action`}</button>
              <input aria-label={`${id} reply`} data-tab-focus="" />
            </>
          ),
        }))}
      />
    );
  }
  render(<Harness />);
  await user.click(tab("Two"));
  expect(screen.getByRole("textbox", { name: "Two reply" })).toHaveFocus();
  await user.click(tab("One"));
  expect(screen.getByRole("textbox", { name: "One reply" })).toHaveFocus();
  act(() => tab("One").focus());
  await user.keyboard("{ArrowRight}{Enter}");
  expect(tab("Two")).toHaveFocus();
});

test("Escape cancelling IME composition does not close the tab", () => {
  render(<Fixture />);
  const draft = screen.getByRole("textbox", { name: "Thread draft" });
  draft.focus();
  fireEvent.keyDown(draft, { key: "Escape", isComposing: true });
  expect(draft).toHaveFocus();
  fireEvent.keyDown(draft, { key: "Escape", keyCode: 229 });
  expect(draft).toHaveFocus();
  fireEvent.keyDown(draft, { key: "Escape" });
  expect(draft).not.toBeInTheDocument();
  expect(tab("Ada")).toHaveFocus();
});

// Exercise the exact script evaluated by the native menu, not a second shortcut
// implementation. Geometry is the only browser-only boundary stubbed in jsdom.
const requestClose = () =>
  new Function(
    "window",
    "document",
    "Event",
    `return eval(${JSON.stringify(closeRequest)})`,
  )(window, document, Event) as "handled" | "unhandled";
const visibleWorkspace = () =>
  vi
    .spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue([{ width: 500, height: 500 }] as unknown as DOMRectList);

test("native Close closes the active tab from outside the pane, commits each request, and reports when no tab is left", () => {
  visibleWorkspace();
  render(
    <StrictMode>
      <input aria-label="Main composer" />
      <Fixture />
    </StrictMode>,
  );
  screen.getByRole("textbox", { name: "Main composer" }).focus();
  act(() => {
    expect(requestClose()).toBe("handled");
    expect(within(tabs()).queryByRole("tab", { name: "Thread" })).toBeNull();
    expect(tab("Ada")).toHaveFocus();
    // No async yield: a held native accelerator must see the next selection.
    expect(requestClose()).toBe("handled");
    expect(screen.getByText("No open panels")).toBeVisible();
    expect(requestClose()).toBe("unhandled");
  });
});

test("native Close uses the selected local detail, not its parent tab", async () => {
  visibleWorkspace();
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(tab("Ada"));
  await user.click(screen.getByRole("button", { name: "Open log" }));
  screen.getByRole("textbox", { name: "Log filter" }).focus();
  act(() => expect(requestClose()).toBe("handled"));
  expect(within(tabs()).queryByRole("tab", { name: "Harness log" })).toBeNull();
  expect(tab("Ada")).toHaveFocus();
  expect(tab("Thread")).toBeInTheDocument();
});

for (const hiddenProps of [
  { hidden: true },
  { inert: true },
  { "aria-hidden": true as const },
]) {
  test(`native Close preserves retained tabs under ${Object.keys(hiddenProps)[0]}`, () => {
    visibleWorkspace();
    const view = render(
      <div {...hiddenProps}>
        <Fixture />
      </div>,
    );
    act(() => expect(requestClose()).toBe("unhandled"));
    view.rerender(
      <div>
        <Fixture />
      </div>,
    );
    expect(tab("Thread")).toBeInTheDocument();
    expect(tab("Ada")).toBeInTheDocument();
  });
}

test("native Close ignores a CSS-hidden workspace and disposes its consumer on unmount", () => {
  const rects = visibleWorkspace();
  const view = render(<Fixture />);
  rects.mockReturnValue([] as unknown as DOMRectList);
  act(() => expect(requestClose()).toBe("unhandled"));
  expect(tab("Thread")).toBeInTheDocument();
  view.unmount();
  act(() => expect(requestClose()).toBe("unhandled"));
});

test("native Close is consumed by a modal even without tabs, and never closes behind it", () => {
  visibleWorkspace();
  const view = render(
    <>
      <dialog open aria-label="Dialog" />
      <Fixture />
    </>,
  );
  act(() => expect(requestClose()).toBe("handled"));
  expect(tab("Thread")).toBeInTheDocument();
  view.rerender(<div role="dialog" aria-modal="true" />);
  act(() => expect(requestClose()).toBe("handled"));
  view.unmount();
  expect(requestClose()).toBe("unhandled");
});

test("a consumed native Close request cannot close another workspace", () => {
  visibleWorkspace();
  render(
    <>
      <Fixture />
      <Fixture />
    </>,
  );
  act(() => expect(requestClose()).toBe("handled"));
  expect(screen.getAllByRole("tab", { name: "Thread" })).toHaveLength(1);
  expect(screen.getAllByRole("tab", { name: "Ada" })).toHaveLength(2);
});

// The exact script the native Show Next/Previous Tab items evaluate; Windows
// and Linux shortcuts dispatch the same events.
const switchTab = (tabEvent: "buzz:next-tab" | "buzz:previous-tab") =>
  new Function(
    "window",
    "document",
    "Event",
    "tabEvent",
    `return eval(${JSON.stringify(switchTabRequest)})`,
  )(window, document, Event, tabEvent);
const selectedTab = () =>
  within(tabs()).getByRole("tab", { selected: true }).textContent;

test("next and previous tab requests cycle tabs, wrapping, including local details", async () => {
  visibleWorkspace();
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(tab("Ada"));
  await user.click(screen.getByRole("button", { name: "Open log" }));
  await user.click(tab("Thread"));
  expect(selectedTab()).toBe("Thread");
  expect(document.documentElement.dataset.keyboardNavigation).toBeUndefined();
  act(() => {
    // No async yield: a held accelerator must see the previous selection.
    switchTab("buzz:next-tab");
    expect(selectedTab()).toBe("Ada");
    switchTab("buzz:next-tab");
    expect(selectedTab()).toBe("Harness log");
    switchTab("buzz:next-tab");
    expect(selectedTab()).toBe("Thread");
    switchTab("buzz:previous-tab");
    expect(selectedTab()).toBe("Harness log");
    switchTab("buzz:previous-tab");
    expect(selectedTab()).toBe("Ada");
  });
  // Without a main-document keydown, the request itself marks keyboard
  // navigation so the focused fallback tab shows its ring.
  expect(document.documentElement.dataset.keyboardNavigation).toBe("");
});

test("tab switching does nothing behind a modal or with a single tab", () => {
  visibleWorkspace();
  const view = render(
    <>
      <dialog open aria-label="Dialog" />
      <Fixture />
    </>,
  );
  act(() => switchTab("buzz:next-tab"));
  expect(tab("Thread")).toHaveAttribute("aria-selected", "true");
  expect(document.documentElement.dataset.keyboardNavigation).toBeUndefined();
  view.rerender(
    <PanelWorkspace
      value="one"
      select={() => {}}
      items={[{ id: "one", label: "One", content: null }]}
    />,
  );
  const request = new Event("buzz:next-tab", { cancelable: true });
  act(() => {
    window.dispatchEvent(request);
  });
  expect(request.defaultPrevented).toBe(false);
});

test("a consumed tab switch request cannot switch another workspace", () => {
  visibleWorkspace();
  render(
    <>
      <Fixture />
      <Fixture />
    </>,
  );
  act(() => switchTab("buzz:next-tab"));
  expect(
    screen
      .getAllByRole("tab", { name: "Thread" })
      .map((tab) => tab.getAttribute("aria-selected"))
      .sort(),
  ).toEqual(["false", "true"]);
});

test("background tab selection does not take focus from a modal", () => {
  const view = render(
    <>
      <div role="dialog" aria-modal="true">
        <input aria-label="Modal search" />
      </div>
      <PanelWorkspace
        value="one"
        select={() => {}}
        focusOnMount={false}
        items={["one", "two"].map((id) => ({
          id,
          label: id,
          content: <p>{id} body</p>,
        }))}
      />
    </>,
  );
  const search = screen.getByRole("textbox", { name: "Modal search" });
  act(() => search.focus());
  view.rerender(
    <>
      <div role="dialog" aria-modal="true">
        <input aria-label="Modal search" />
      </div>
      <PanelWorkspace
        value="two"
        select={() => {}}
        focusOnMount={false}
        items={["one", "two"].map((id) => ({
          id,
          label: id,
          content: <p>{id} body</p>,
        }))}
      />
    </>,
  );
  expect(search).toHaveFocus();
  expect(tab("two")).toHaveAttribute("aria-selected", "true");
});
