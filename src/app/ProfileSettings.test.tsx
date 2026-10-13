// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { npubEncode } from "nostr-tools/nip19";
import { afterEach, expect, it, vi } from "vitest";
import type {
  PersonalProfile,
  Communities,
} from "../features/communities/service";
import * as communityApi from "../features/communities/api";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { ProfileSettings } from "./ProfileSettings";
import { stubAvatarBrowserApis } from "../features/agents/avatar-testing";

stubAvatarBrowserApis();

const viewer = "ab".repeat(32);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function communities(): Communities {
  const state = {
    status: "ready" as const,
    relayAvailable: true,
    viewer,
    profile: { name: "Buzz User", picture: "" },
    memberships: [],
    selected: null,
  };
  const snapshot = () => state;
  return {
    snapshot,
    subscribe: () => () => {},
    relay: { snapshot: () => ({ status: "unavailable" }) },
    saveProfile: vi.fn(),
  } as unknown as Communities;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("loads and publishes the selected community profile before updating the local seed", async () => {
  const service = communities();
  const inspect = vi.spyOn(communityApi, "inspectProfile").mockResolvedValue({
    exists: true,
    existing: { website: "https://example.test", name: "legacy" },
    profile: {
      name: "Community name",
      picture: "",
      about: "Community bio",
    },
  });
  const publish = vi
    .spyOn(communityApi, "publishProfile")
    .mockImplementation(async (_id, profile, existing) => {
      inspect.mockResolvedValue({ exists: true, existing, profile });
    });
  const user = userEvent.setup();
  render(
    <ProfileSettings
      communities={service}
      community={{ id: "community-id", name: "Acme" }}
    />,
    { wrapper: ToastProvider },
  );

  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading your profile in Acme",
  );
  const name = await screen.findByLabelText("Display name");
  expect(name).toHaveValue("Community name");
  expect(screen.getByLabelText("Profile description (optional)")).toHaveValue(
    "Community bio",
  );
  await user.clear(name);
  await user.type(name, "Updated community name");
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(publish).toHaveBeenCalledWith(
      "community-id",
      {
        name: "Updated community name",
        picture: "",
        about: "Community bio",
      },
      { website: "https://example.test", name: "legacy" },
    ),
  );
  expect(service.saveProfile).toHaveBeenCalledWith({
    name: "Updated community name",
    picture: "",
    about: "Community bio",
  });
  expect(await screen.findByText("Profile updated")).toBeVisible();
  expect(inspect).toHaveBeenCalledWith("community-id");
});

it("keeps a newer profile seed when an older community publication finishes last", async () => {
  const service = communities();
  const olderPublication = deferred();
  const saved = new Map<
    string,
    Parameters<typeof communityApi.publishProfile>[1]
  >();
  vi.spyOn(communityApi, "inspectProfile").mockImplementation(async (id) => ({
    exists: true,
    existing: { name: id },
    profile: saved.get(id) ?? {
      name: id === "older" ? "Older" : "Newer",
      picture: "",
    },
  }));
  const publish = vi
    .spyOn(communityApi, "publishProfile")
    .mockImplementation(async (id, profile) => {
      if (id === "older") await olderPublication.promise;
      saved.set(id, profile);
    });
  const user = userEvent.setup();
  const older = render(
    <ProfileSettings
      communities={service}
      community={{ id: "older", name: "Older community" }}
    />,
    { wrapper: ToastProvider },
  );
  const olderName = await within(older.container).findByLabelText(
    "Display name",
  );
  await user.clear(olderName);
  await user.type(olderName, "Older save");
  await user.click(
    within(older.container).getByRole("button", { name: "Save" }),
  );
  await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

  const newer = render(
    <ProfileSettings
      communities={service}
      community={{ id: "newer", name: "Newer community" }}
    />,
    { wrapper: ToastProvider },
  );
  const newerName = await within(newer.container).findByLabelText(
    "Display name",
  );
  await user.clear(newerName);
  await user.type(newerName, "Newer save");
  await user.click(
    within(newer.container).getByRole("button", { name: "Save" }),
  );
  await waitFor(() =>
    expect(service.saveProfile).toHaveBeenCalledWith({
      name: "Newer save",
      picture: "",
      about: "",
    }),
  );

  olderPublication.resolve();
  await olderPublication.promise;
  await waitFor(() => expect(olderName).not.toBeDisabled());
  expect(publish).toHaveBeenCalledTimes(2);
  expect(service.saveProfile).toHaveBeenCalledTimes(1);
});

it("keeps a community draft when publication fails and retries a failed read", async () => {
  const service = communities();
  const inspect = vi
    .spyOn(communityApi, "inspectProfile")
    .mockRejectedValueOnce(new Error("read unavailable"))
    .mockResolvedValue({
      exists: false,
      existing: {},
      profile: { name: "", picture: "", about: "" },
    });
  const publish = vi
    .spyOn(communityApi, "publishProfile")
    .mockRejectedValue(new Error("publish unavailable"));
  const user = userEvent.setup();
  render(
    <ProfileSettings
      communities={service}
      community={{ id: "community-id", name: "Acme" }}
    />,
    { wrapper: ToastProvider },
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "read unavailable",
  );
  await user.click(
    screen.getByRole("button", { name: "Retry loading profile" }),
  );
  const name = await screen.findByLabelText("Display name");
  expect(name).toHaveValue("Buzz User");
  await user.clear(name);
  await user.type(name, "Keep this draft");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "publish unavailable",
  );
  expect(name).toHaveValue("Keep this draft");
  expect(service.saveProfile).not.toHaveBeenCalled();
  // Failed initial load, explicit retry, then fresh preflight; no confirmation.
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("shows profile actions for description-only edits and hides them on cancellation", async () => {
  const service = communities();
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />, { wrapper: ToastProvider });
  const description = screen.getByLabelText("Profile description (optional)");
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Cancel" }),
  ).not.toBeInTheDocument();
  await user.type(description, "Draft");
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  await user.clear(description);
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await user.type(description, "Discard me");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(description).toHaveValue("");
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(service.saveProfile).not.toHaveBeenCalled();
});

it("previews draft profile content and the shared avatar crop before saving", async () => {
  const service = communities();
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />, { wrapper: ToastProvider });

  const preview = screen.getByRole("region", { name: "Profile preview" });
  expect(preview).toHaveTextContent("Buzz User");
  expect(preview.querySelector('[data-avatar-shape="circle"]')).toBeVisible();

  await user.clear(screen.getByLabelText("Display name"));
  await user.type(screen.getByLabelText("Display name"), "Clay");
  await user.type(
    screen.getByLabelText("Profile description (optional)"),
    "Building with Buzz",
  );
  await user.click(screen.getByRole("button", { name: "Edit avatar" }));
  await user.type(
    await screen.findByLabelText("Picture URL (optional)"),
    "https://example.test/profile.png",
  );
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(preview).toHaveTextContent("Clay");
  expect(preview).toHaveTextContent("Building with Buzz");
  expect(preview.querySelector("img")).toHaveAttribute(
    "src",
    "https://example.test/profile.png",
  );
});

it("edits and trims the profile description with a visible limit", async () => {
  const service = communities();
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />, { wrapper: ToastProvider });

  const description = screen.getByLabelText("Profile description (optional)");
  expect(screen.getByText("0 of 500 characters")).toBeVisible();
  await user.type(description, "  Building with Buzz  ");
  expect(screen.getByText("22 of 500 characters")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(service.saveProfile).toHaveBeenCalledWith({
    name: "Buzz User",
    picture: "",
    about: "Building with Buzz",
  });
  expect(await screen.findByText("Profile updated")).toBeVisible();
});

it("preserves an over-limit remote description and blocks unrelated saves", async () => {
  const service = communities();
  const about = "a".repeat(800);
  vi.spyOn(communityApi, "inspectProfile").mockResolvedValue({
    exists: true,
    existing: { name: "Remote", about },
    profile: { name: "Remote", picture: "", about },
  });
  const publish = vi.spyOn(communityApi, "publishProfile").mockResolvedValue();
  const user = userEvent.setup();
  render(
    <ProfileSettings
      communities={service}
      community={{ id: "community-id", name: "Acme" }}
    />,
    { wrapper: ToastProvider },
  );

  const description = await screen.findByLabelText(
    "Profile description (optional)",
  );
  expect(description).toHaveValue(about);
  expect(
    screen.getByText(
      "Shorten the description to 500 characters before saving.",
    ),
  ).toBeVisible();
  const name = screen.getByLabelText("Display name");
  await user.clear(name);
  await user.type(name, "Renamed");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(publish).not.toHaveBeenCalled();
});

it("rejects profile image URLs with embedded credentials", async () => {
  const service = communities();
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />, { wrapper: ToastProvider });

  await user.click(screen.getByRole("button", { name: "Edit avatar" }));
  await user.type(
    await screen.findByLabelText("Picture URL (optional)"),
    "https://user:secret@example.test/profile.png",
  );

  expect(
    screen.getByLabelText("Picture URL (optional)"),
  ).toHaveAccessibleDescription(/Use an HTTPS image URL without credentials/);
  expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(service.saveProfile).not.toHaveBeenCalled();
});

it("shows exact public identity formats and copies either value", async () => {
  const writeText = vi.fn(async () => {});
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<ProfileSettings communities={communities()} />, {
    wrapper: ToastProvider,
  });

  expect(screen.getByText(viewer, { exact: true })).toHaveTextContent(viewer);
  expect(
    screen.getByText(npubEncode(viewer), { exact: true }),
  ).toHaveTextContent(npubEncode(viewer));

  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  expect(writeText).toHaveBeenLastCalledWith(viewer);
  expect(screen.getByText("Public key copied.")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Copy nostr address" }));
  expect(writeText).toHaveBeenLastCalledWith(npubEncode(viewer));
  expect(screen.getByText("Nostr address copied.")).toBeVisible();
});

it("keeps copy feedback bound to the latest identity action", async () => {
  let finishPublicKey: (() => void) | undefined;
  const publicKeyWrite = new Promise<void>((resolve) => {
    finishPublicKey = resolve;
  });
  const writeText = vi
    .fn()
    .mockReturnValueOnce(publicKeyWrite)
    .mockResolvedValueOnce(undefined);
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<ProfileSettings communities={communities()} />, {
    wrapper: ToastProvider,
  });

  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  await user.click(screen.getByRole("button", { name: "Copy nostr address" }));
  expect(screen.getByText("Nostr address copied.")).toBeVisible();

  finishPublicKey?.();
  await publicKeyWrite;
  expect(screen.getByText("Nostr address copied.")).toBeVisible();
  expect(screen.queryByText("Public key copied.")).not.toBeInTheDocument();
});

it("keeps the identity selectable and explains manual recovery when copy fails", async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async () => Promise.reject(new Error("denied"))),
    },
  });
  render(<ProfileSettings communities={communities()} />, {
    wrapper: ToastProvider,
  });

  const publicKey = screen.getByText(viewer, { exact: true });
  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  expect(screen.getByText(/Select it and copy manually\./)).toBeVisible();

  // Native text selection is exercised in both browser engines.
  expect(publicKey.tagName).toBe("CODE");
  expect(publicKey).toHaveTextContent(viewer);
  expect(
    screen.queryByRole("textbox", { name: "Public key (hex)" }),
  ).toBeNull();
});

function setup() {
  let state = { status: "ready", profile: { name: "Arjun", picture: "" } };
  const listeners = new Set<() => void>();
  const saveProfile = vi.fn((profile: PersonalProfile) => {
    state = { ...state, profile };
    for (const listener of listeners) listener();
  });
  const communities = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    saveProfile,
    relay: { snapshot: () => ({ status: "unavailable" }) },
  } as unknown as Communities;
  render(<ProfileSettings communities={communities} />, {
    wrapper: ToastProvider,
  });
  return {
    saveProfile,
    name: screen.getByRole("textbox", { name: "Display name" }),
  };
}

it("shows Cancel then Save only for edits, including picture edits, and restores on cancel", () => {
  const { name, saveProfile } = setup();
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  fireEvent.change(name, { target: { value: "Updated" } });
  const form = name.closest("form");
  if (!form) throw new Error("Profile form missing");
  expect(
    within(form)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Cancel", "Save"]);
  fireEvent.change(name, { target: { value: "Arjun" } });
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit avatar" }));
  const picture = screen.getByRole("textbox", {
    name: "Picture URL (optional)",
  });
  fireEvent.change(picture, {
    target: { value: "https://example.com/avatar.png" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit avatar" }));
  expect(
    screen.getByRole("textbox", { name: "Picture URL (optional)" }),
  ).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(saveProfile).not.toHaveBeenCalled();
});

it("retains edits on failure and hides actions after a successful retry", async () => {
  const { name, saveProfile } = setup();
  fireEvent.change(name, { target: { value: "Updated" } });
  saveProfile.mockImplementationOnce(() => {
    throw new Error("Could not save");
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
  expect(name).toHaveValue("Updated");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(await screen.findByText("Profile updated")).toBeVisible();
});

it("keeps cancel available for invalid edits and refuses unchanged form submission", () => {
  const { name, saveProfile } = setup();
  const form = name.closest("form");
  if (!form) throw new Error("Profile form missing");
  fireEvent.submit(form);
  expect(saveProfile).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
});

it.each(["Cancel", "Save"])(
  "returns focused %s to Display name when actions retire",
  async (action) => {
    const user = userEvent.setup();
    const { name } = setup();
    await user.type(name, " updated");
    screen.getByRole("button", { name: action }).focus();
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("button", { name: action }),
    ).not.toBeInTheDocument();
    expect(name).toHaveFocus();
  },
);

it("keeps the focused Save on failure and hands focus off after retry", async () => {
  const user = userEvent.setup();
  const { name, saveProfile } = setup();
  await user.type(name, " updated");
  const save = screen.getByRole("button", { name: "Save" });
  save.focus();
  saveProfile.mockImplementationOnce(() => {
    throw new Error("Could not save");
  });
  await user.keyboard("{Enter}");
  expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
  expect(save).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(name).toHaveFocus();
});

it("preserves input focus on implicit submit and external profile updates", async () => {
  const user = userEvent.setup();
  const { name, saveProfile } = setup();
  await user.type(name, " updated");
  await user.keyboard("{Enter}");
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(name).toHaveFocus();
  await user.type(name, " again");
  const description = screen.getByRole("textbox", {
    name: "Profile description (optional)",
  });
  description.focus();
  act(() => saveProfile({ name: "Arjun updated again", picture: "" }));
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(description).toHaveFocus();
});

it("keeps identity backup available despite a failed community profile and clears on leaving Profile", async () => {
  vi.spyOn(communityApi, "inspectProfile").mockRejectedValue(
    new Error("Offline"),
  );
  const exportKey = vi.fn().mockResolvedValue("nsec-public-test-fixture");
  const identity = {
    exportKey,
  } as unknown as import("../features/identity/service").Identity;
  const service = communities();
  const community = { id: "primary", name: "Offline community" };
  const user = userEvent.setup();
  const view = render(
    <ProfileSettings
      communities={service}
      community={community}
      identity={identity}
      active
    />,
    { wrapper: ToastProvider },
  );
  await screen.findByText(
    /Your profile in Offline community couldn’t be loaded/,
  );
  expect(exportKey).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "nsec-public-test-fixture",
  );
  view.rerender(
    <ProfileSettings
      communities={service}
      community={community}
      identity={identity}
      active={false}
    />,
  );
  expect(screen.queryByLabelText("Private key (nsec)")).toBeNull();
  view.rerender(
    <ProfileSettings
      communities={service}
      community={community}
      identity={identity}
      active
    />,
  );
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  expect(exportKey).toHaveBeenCalledTimes(1);
});

it("keeps identity details available without requesting a community profile when transport is absent", async () => {
  const service = communities();
  service.snapshot().relayAvailable = false;
  const inspect = vi.spyOn(communityApi, "inspectProfile");
  render(
    <ProfileSettings
      communities={service}
      community={{ id: "https://saved.example", name: "Saved" }}
    />,
    { wrapper: ToastProvider },
  );
  expect(
    screen.getByText("Community profiles are not available in this build yet."),
  ).toBeVisible();
  expect(
    screen.getByText(npubEncode(viewer), { exact: true }),
  ).toHaveTextContent(npubEncode(viewer));
  expect(
    screen.getByText(/identity is shared across communities/),
  ).toBeVisible();
  expect(inspect).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});
