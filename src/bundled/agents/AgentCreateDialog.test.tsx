// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { agentAvatars, avatarPacks } from "../../features/agents/avatar-packs";
import type {
  Agent,
  Agents,
  NewAgent,
  RegisteredAgentType,
} from "../../features/agents/service";
import { AgentCreateDialog } from "./AgentCreateDialog";

afterEach(cleanup);

type Echo = { reply: string };
type Notes = { notes: string; instructions: string };

const echo = {
  key: "test/echo",
  pluginId: "test",
  revision: "1",
  id: "echo",
  title: "Echo",
  description: "Says its line.",
  defaults: () => ({ config: { reply: "" } }),
  Create: ({
    config,
    disabled,
    onChange,
  }: {
    config: Echo;
    disabled: boolean;
    onChange(config: Echo): void;
  }) => (
    <input
      aria-label="Reply"
      disabled={disabled}
      value={config.reply}
      onChange={(event) => onChange({ reply: event.target.value })}
    />
  ),
} as unknown as RegisteredAgentType;

const notes = {
  key: "test/notes",
  pluginId: "test",
  revision: "1",
  id: "notes",
  title: "Notes",
  description: "Takes notes.",
  defaults: () => ({ config: { notes: "start", instructions: "Be brief." } }),
  Create: ({
    config,
    disabled,
    onChange,
  }: {
    config: Notes;
    disabled: boolean;
    onChange(config: Notes): void;
  }) => (
    <>
      <input
        aria-label="Notes"
        disabled={disabled}
        value={config.notes}
        onChange={(event) => onChange({ ...config, notes: event.target.value })}
      />
      <AgentInstructions
        value={config.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...config, instructions })}
      />
    </>
  ),
} as unknown as RegisteredAgentType;

const made = {
  pubkey: "3".repeat(64),
  name: "Nova",
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: {},
  skipped: {},
  timers: {},
  attention: {},
} as unknown as Agent;

function setup(
  types: readonly RegisteredAgentType[],
  create: (input: NewAgent) => Promise<Agent> = async () => made,
) {
  const agents = { create: vi.fn(create) } as unknown as Agents & {
    create: ReturnType<typeof vi.fn>;
  };
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <AgentCreateDialog
      agents={agents}
      types={types}
      onCreated={onCreated}
      onClose={onClose}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  return { agents, onCreated, onClose, dialog, user: userEvent.setup() };
}

const createButton = () => screen.getByRole("button", { name: "Create agent" });

it("creates with the name, a pack picture and the config from the type's view", async () => {
  const { agents, onCreated, dialog, user } = setup([echo]);
  await user.type(within(dialog).getByLabelText("Reply"), "Hi there");
  await user.type(within(dialog).getByLabelText("Name"), "  Nova ");

  const pack = avatarPacks[0];
  const avatar = agentAvatars.find((item) => item.collectionId === pack?.id);
  if (!pack || !avatar) throw new Error("The catalog has a pack");
  await user.click(
    within(dialog).getByRole("button", { name: "Choose avatar" }),
  );
  await user.click(
    await within(dialog).findByRole("button", {
      name: new RegExp(pack.label),
    }),
  );
  await user.click(
    await within(dialog).findByRole("button", { name: avatar.label }),
  );
  expect(await within(dialog).findByLabelText("Name")).toHaveValue("  Nova ");

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledExactlyOnceWith({
    type: "test/echo",
    name: "Nova",
    picture: avatar.url,
    config: { reply: "Hi there" },
  });
  expect(avatar.url).toMatch(/^https:\/\//);
  expect(onCreated).toHaveBeenCalledExactlyOnceWith(made);
});

it("opens on the name field", async () => {
  const { dialog } = setup([echo]);
  await waitFor(() =>
    expect(within(dialog).getByLabelText("Name")).toHaveFocus(),
  );
});

it("starts with a pack picture already chosen", async () => {
  const { agents, dialog, user } = setup([echo]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  const [input] = agents.create.mock.calls[0] as [NewAgent];
  expect(input.picture).toMatch(/^https:\/\//);
  expect(agentAvatars.map((avatar) => avatar.url)).toContain(input.picture);
});

it("offers no type menu for a single type, only its title", () => {
  const { dialog } = setup([echo]);
  expect(within(dialog).getByText("Echo")).toBeInTheDocument();
  expect(
    within(dialog).queryByRole("button", { name: /Agent type/ }),
  ).not.toBeInTheDocument();
});

it("disables Create agent with an empty name", async () => {
  const { agents, dialog, user } = setup([echo]);
  expect(createButton()).toBeDisabled();
  await user.type(within(dialog).getByLabelText("Name"), "   ");
  expect(createButton()).toBeDisabled();
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  expect(createButton()).toBeEnabled();
  await user.clear(within(dialog).getByLabelText("Name"));
  expect(createButton()).toBeDisabled();
  await user.type(within(dialog).getByLabelText("Reply"), "x{Enter}");
  expect(agents.create).not.toHaveBeenCalled();
});

it("switches type from the corner menu, resetting the config to the new type's defaults", async () => {
  const { agents, dialog, user } = setup([echo, notes]);
  await user.type(within(dialog).getByLabelText("Reply"), "typed in echo");
  await user.type(within(dialog).getByLabelText("Name"), "Nova");

  await user.click(
    within(dialog).getByRole("button", { name: "Agent type: Echo" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Notes" }));

  expect(
    within(dialog).getByRole("button", { name: "Agent type: Notes" }),
  ).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Reply")).not.toBeInTheDocument();
  expect(within(dialog).getByLabelText("Notes")).toHaveValue("start");
  // The name stays; only the type's own settings start over.
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Nova");

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledExactlyOnceWith({
    type: "test/notes",
    name: "Nova",
    picture: expect.stringMatching(/^https:\/\//),
    config: { notes: "start", instructions: "Be brief." },
  });
});

it("starts over again when switching back to the first type", async () => {
  const { agents, dialog, user } = setup([echo, notes]);
  await user.type(within(dialog).getByLabelText("Reply"), "typed");
  const switchTo = async (from: string, to: string) => {
    // A radio item does not close its menu, so it may still be open.
    if (!screen.queryByRole("menu"))
      await user.click(
        within(dialog).getByRole("button", { name: `Agent type: ${from}` }),
      );
    await user.click(await screen.findByRole("menuitemradio", { name: to }));
  };
  await switchTo("Echo", "Notes");
  await switchTo("Notes", "Echo");
  expect(within(dialog).getByLabelText("Reply")).toHaveValue("");
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({ type: "test/echo", config: { reply: "" } }),
  );
});

const editNotes = async (
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) => {
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(
    within(dialog).getByRole("button", { name: "Edit instructions" }),
  );
  return await within(dialog).findByRole("textbox", {
    name: "Agent instructions",
  });
};

it("takes over the card while instructions are edited, and Back restores the earlier text", async () => {
  const { agents, dialog, user } = setup([notes]);
  expect(within(dialog).getByText("Be brief.")).toBeInTheDocument();
  const editor = await editNotes(user, dialog);
  expect(editor).toHaveValue("Be brief.");
  // The footer is Back and Done editing instead of Create agent.
  expect(
    within(dialog).getByRole("button", { name: "Done editing" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Create agent" }),
  ).not.toBeInTheDocument();

  await user.type(editor, " And kind.");
  expect(editor).toHaveValue("Be brief. And kind.");
  await user.click(within(dialog).getByRole("button", { name: "Back" }));

  expect(
    screen.queryByRole("textbox", { name: "Agent instructions" }),
  ).not.toBeInTheDocument();
  expect(within(dialog).getByText("Be brief.")).toBeInTheDocument();
  expect(
    within(dialog).queryByRole("button", { name: "Done editing" }),
  ).not.toBeInTheDocument();
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      config: { notes: "start", instructions: "Be brief." },
    }),
  );
});

it("keeps the new instructions on Done editing", async () => {
  const { agents, dialog, user } = setup([notes]);
  const editor = await editNotes(user, dialog);
  await user.type(editor, " And kind.");
  await user.click(
    within(dialog).getByRole("button", { name: "Done editing" }),
  );
  expect(within(dialog).getByText("Be brief. And kind.")).toBeInTheDocument();
  expect(
    within(dialog).queryByRole("button", { name: "Back" }),
  ).not.toBeInTheDocument();
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      config: { notes: "start", instructions: "Be brief. And kind." },
    }),
  );
});

it("shows a failed create's error, stays open, and lets it be tried again", async () => {
  let attempts = 0;
  const { agents, onCreated, onClose, dialog, user } = setup(
    [echo],
    async () => {
      if (++attempts === 1) throw new Error("Credential store refused");
      return made;
    },
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Credential store refused",
  );
  expect(screen.getByRole("dialog", { name: "Create agent" })).toBeVisible();
  expect(createButton()).toBeEnabled();
  expect(within(dialog).getByLabelText("Name")).toBeEnabled();
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Nova");
  expect(onCreated).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(made));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("clears a shown error when the name changes", async () => {
  const { dialog, user } = setup([echo], async () => {
    throw new Error("Nope");
  });
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  expect(await screen.findByRole("alert")).toHaveTextContent("Nope");
  await user.type(within(dialog).getByLabelText("Name"), "!");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("blocks a second create while the first is pending", async () => {
  let finish: (agent: Agent) => void = () => {};
  const { agents, dialog, user } = setup(
    [echo],
    () => new Promise<Agent>((resolve) => (finish = resolve)),
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  await vi.waitFor(() => expect(agents.create).toHaveBeenCalledTimes(1));
  expect(within(dialog).getByLabelText("Name")).toBeDisabled();
  expect(within(dialog).getByLabelText("Reply")).toBeDisabled();
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledTimes(1);
  finish(made);
});
