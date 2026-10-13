// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { channelTemplates, templateAgents, TEMPLATES_KEY } from "./local";

afterEach(() => localStorage.clear());

it("saves, replaces and removes templates, telling listeners each time", () => {
  const heard = vi.fn();
  const stop = channelTemplates.subscribe(heard);
  const made = channelTemplates.save({
    name: "  Launch ",
    teams: ["t1", "t1"],
    agents: ["a", "a"],
    canvas: "# Goal",
  });
  expect(made).toMatchObject({ name: "Launch", teams: ["t1"], agents: ["a"] });
  expect(channelTemplates.snapshot()).toEqual([made]);
  expect(channelTemplates.snapshot()).toBe(channelTemplates.snapshot());
  channelTemplates.save({ ...made, name: "Ship" });
  expect(channelTemplates.snapshot().map((item) => item.name)).toEqual([
    "Ship",
  ]);
  channelTemplates.remove(made.id);
  expect(channelTemplates.snapshot()).toEqual([]);
  expect(heard).toHaveBeenCalledTimes(3);
  stop();
});

it("rejects an unnamed template, an unknown id and an oversized Canvas", () => {
  expect(() =>
    channelTemplates.save({ name: " ", teams: [], agents: [], canvas: "" }),
  ).toThrow("Name the template");
  expect(() =>
    channelTemplates.save({
      id: "nope",
      name: "A",
      teams: [],
      agents: [],
      canvas: "",
    }),
  ).toThrow("No such template");
  expect(() =>
    channelTemplates.save({
      name: "A",
      teams: [],
      agents: [],
      canvas: "x".repeat(24 * 1024 + 1),
    }),
  ).toThrow("Canvas is too large");
  expect(channelTemplates.snapshot()).toEqual([]);
  expect(
    channelTemplates.save({
      name: "Blank",
      teams: [],
      agents: [],
      canvas: " \n ",
    }).canvas,
  ).toBe("");
});

it("reads what another window saved and skips what is not a template", () => {
  channelTemplates.save({ name: "Here", teams: [], agents: [], canvas: "" });
  localStorage.setItem(
    TEMPLATES_KEY,
    JSON.stringify({
      version: 1,
      templates: [
        {
          id: "x",
          name: "There",
          teams: ["t", 3],
          agents: ["a", 4],
          canvas: "",
        },
        // Saved before templates had agents.
        { id: "z", name: "Older", teams: ["t"], canvas: "" },
        { id: "y", name: "Broken" },
      ],
    }),
  );
  expect(channelTemplates.snapshot()).toEqual([
    { id: "x", name: "There", teams: ["t"], agents: ["a"], canvas: "" },
    { id: "z", name: "Older", teams: ["t"], agents: [], canvas: "" },
  ]);
});

it("adds its agents and each member of its teams once, if one of the given agents", () => {
  const teams = [
    { id: "t1", members: ["a", "b"] },
    { id: "t2", members: ["b", "c"] },
  ];
  expect(
    templateAgents(
      {
        id: "x",
        name: "X",
        teams: ["t2", "t1", "gone"],
        agents: ["elsewhere", "d", "a"],
        canvas: "",
      },
      teams,
      new Set(["a", "b", "d"]),
    ),
  ).toEqual(["d", "a", "b"]);
});
