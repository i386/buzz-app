// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../features/communities/service";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { CommunityDepartureSettings } from "./CommunityDepartureSettings";

const api = vi.hoisted(() => ({ requestLeave: vi.fn() }));
vi.mock("../features/communities/api", async (actual) => ({
  ...(await actual<typeof import("../features/communities/api")>()),
  requestLeave: api.requestLeave,
}));

const community = { id: "https://acme.example", name: "Acme" };
function harness() {
  let selected: string | null = community.id;
  const leave = vi.fn(async () => {
    selected = null;
    return [];
  });
  return {
    communities: {
      snapshot: () => ({ selected, memberships: [community] }),
      leave,
    } as unknown as Communities,
    leave,
  };
}

function setup() {
  const owner = harness();
  const onRemoved = vi.fn();
  const view = render(
    <ToastProvider>
      <CommunityDepartureSettings
        communities={owner.communities}
        community={community}
        onRemoved={onRemoved}
      />
    </ToastProvider>,
  );
  return { ...owner, ...view, onRemoved, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  api.requestLeave.mockReset();
});

it("removes the community from this device without contacting the relay", async () => {
  const { user, leave, onRemoved } = setup();
  await user.click(
    screen.getByRole("button", { name: "Remove from this device" }),
  );
  const dialog = screen.getByRole("alertdialog", {
    name: "Remove Acme from this device?",
  });
  expect(dialog).toHaveTextContent("without changing your membership");
  await user.click(
    within(dialog).getByRole("button", { name: "Remove from this device" }),
  );
  await screen.findByText(
    "Acme was removed from this device. Your membership wasn’t changed. You can add it again later.",
  );
  expect(api.requestLeave).not.toHaveBeenCalled();
  expect(leave).toHaveBeenCalledWith(community.id, { purge: true });
  expect(onRemoved).toHaveBeenCalledOnce();
});

it("leaves through the relay before removing the local community", async () => {
  api.requestLeave.mockResolvedValue("left");
  const { user, leave, onRemoved } = setup();
  const [openLeave] = screen.getAllByRole("button", {
    name: "Leave community",
  });
  expect(openLeave).toBeDefined();
  if (!openLeave) throw new Error("Leave action is missing");
  await user.click(openLeave);
  const dialog = screen.getByRole("alertdialog", { name: "Leave Acme?" });
  await user.click(
    within(dialog).getByRole("button", { name: "Leave community" }),
  );
  await screen.findByText("Left Acme.");
  expect(api.requestLeave).toHaveBeenCalledWith(community.id);
  expect(leave).toHaveBeenCalledWith(community.id, { purge: true });
  expect(api.requestLeave.mock.invocationCallOrder[0]).toBeLessThan(
    leave.mock.invocationCallOrder[0] ?? 0,
  );
  expect(onRemoved).toHaveBeenCalledOnce();
});

it("keeps both actions available after a relay refusal", async () => {
  api.requestLeave.mockRejectedValue(
    new Error("invalid: relay owner cannot leave"),
  );
  const { user, leave, onRemoved } = setup();
  const [openLeave] = screen.getAllByRole("button", {
    name: "Leave community",
  });
  expect(openLeave).toBeDefined();
  if (!openLeave) throw new Error("Leave action is missing");
  await user.click(openLeave);
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Leave community",
    }),
  );
  await screen.findByText("The relay owner can’t leave Acme.");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(leave).not.toHaveBeenCalled();
  expect(onRemoved).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Remove from this device" }),
  ).toBeEnabled();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("locks confirmation while departure is pending and recovers after failure", async () => {
  const request = deferred<string>();
  api.requestLeave.mockReturnValue(request.promise);
  const { user, leave, onRemoved } = setup();
  await user.click(screen.getByRole("button", { name: "Leave community" }));
  const dialog = screen.getByRole("alertdialog");
  try {
    await user.click(
      within(dialog).getByRole("button", {
        name: "Leave community",
      }),
    );
    await waitFor(() => expect(api.requestLeave).toHaveBeenCalledOnce());
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    expect(leave).not.toHaveBeenCalled();
  } finally {
    await act(async () => request.reject(new Error("offline")));
  }
  await screen.findByText(
    "Couldn’t leave Acme. Check your connection and try again.",
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("button", { name: "Leave community" })).toBeEnabled();
  expect(onRemoved).not.toHaveBeenCalled();
});

it("does not navigate a replacement surface after an in-flight departure", async () => {
  const request = deferred<string>();
  api.requestLeave.mockReturnValue(request.promise);
  const { user, leave, onRemoved, unmount } = setup();
  await user.click(screen.getByRole("button", { name: "Leave community" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Leave community",
    }),
  );
  await waitFor(() => expect(api.requestLeave).toHaveBeenCalledOnce());
  unmount();
  await act(async () => request.resolve("left"));
  expect(leave).toHaveBeenCalledWith(community.id, { purge: true });
  expect(onRemoved).not.toHaveBeenCalled();
});

it("cancels without removing local state or contacting the relay", async () => {
  const { user, leave, onRemoved } = setup();
  await user.click(
    screen.getByRole("button", { name: "Remove from this device" }),
  );
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(api.requestLeave).not.toHaveBeenCalled();
  expect(leave).not.toHaveBeenCalled();
  expect(onRemoved).not.toHaveBeenCalled();
});
