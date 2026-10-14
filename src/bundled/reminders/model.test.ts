import { describe, expect, it } from "vitest";
import type { Reminder } from "../../features/relay/reminders";
import {
  MAX_DELAY_MS,
  TIME_PRESETS,
  countDue,
  dueLabel,
  dueSince,
  groupReminders,
  isDue,
  navigableTarget,
  nextDelay,
  nowSeconds,
  parseCustomDateTime,
  pendingMessageIds,
  presetHint,
  shiftedFrom,
  todayDateString,
} from "./model";

const reminder = ({
  id = "r",
  notBefore,
  status = "pending",
  target,
}: Partial<Reminder>): Reminder => ({
  id,
  eventId: `${id}-evt`,
  createdAt: 0,
  status,
  ...(notBefore !== undefined ? { notBefore } : {}),
  ...(target ? { target } : {}),
});
const NOW = 1000;
const target = (eventId = "e", channelId = "c") => ({
  eventId,
  channelId,
  preview: "hi",
  authorPubkey: "a",
});

describe("due reminders", () => {
  it("counts only pending reminders at or before now", () => {
    expect(isDue(reminder({ notBefore: NOW }), NOW)).toBe(true);
    expect(isDue(reminder({ notBefore: NOW + 1 }), NOW)).toBe(false);
    expect(isDue(reminder({ notBefore: NOW - 1, status: "done" }), NOW)).toBe(
      false,
    );
    expect(isDue(reminder({}), NOW)).toBe(false);
    const list = [
      reminder({ id: "a", notBefore: NOW - 1 }),
      reminder({ id: "b", notBefore: NOW }),
      reminder({ id: "c", notBefore: NOW + 1 }),
      reminder({ id: "d", notBefore: NOW - 1, status: "done" }),
      reminder({ id: "e", notBefore: NOW - 1, status: "cancelled" }),
    ];
    expect(countDue(list, NOW)).toBe(2);
    expect(countDue([], NOW)).toBe(0);
  });

  it("notifies only reminders that crossed (watermark, now]", () => {
    const list = [
      reminder({ id: "at-watermark", notBefore: 900 }),
      reminder({ id: "inside", notBefore: 950 }),
      reminder({ id: "at-now", notBefore: NOW }),
      reminder({ id: "future", notBefore: NOW + 1 }),
      reminder({ id: "done", notBefore: 950, status: "done" }),
      reminder({ id: "cancelled", notBefore: 950, status: "cancelled" }),
      reminder({ id: "undated" }),
    ];
    expect(dueSince(list, 900, NOW).map((r) => r.id)).toEqual([
      "inside",
      "at-now",
    ]);
    expect(dueSince(list, NOW, NOW)).toEqual([]);
  });

  it("schedules the next pending due time and caps long delays", () => {
    expect(
      nextDelay(
        [
          reminder({ id: "a", notBefore: NOW + 30 }),
          reminder({ id: "b", notBefore: NOW + 10 }),
          reminder({ id: "c", notBefore: NOW + 5, status: "done" }),
          reminder({ id: "d", notBefore: NOW - 5 }),
        ],
        NOW,
      ),
    ).toBe(10_000);
    expect(nextDelay([reminder({ notBefore: NOW + 60 * 86_400 })], NOW)).toBe(
      MAX_DELAY_MS,
    );
    expect(nextDelay([reminder({ notBefore: NOW - 1 })], NOW)).toBeUndefined();
  });
});

describe("reminder grouping", () => {
  it("buckets pending reminders, lists done newest first and hides cancelled", () => {
    const groups = groupReminders(
      [
        reminder({ id: "later", notBefore: 3000 }),
        reminder({ id: "zero", notBefore: 0 }),
        reminder({ id: "overdue", notBefore: 500 }),
        reminder({ id: "today", notBefore: 1500 }),
        { ...reminder({ id: "done", status: "done" }), createdAt: 1 },
        { ...reminder({ id: "done-later", status: "done" }), createdAt: 2 },
        reminder({ id: "cancelled", notBefore: 1500, status: "cancelled" }),
      ],
      NOW,
      2000,
    );
    expect(groups.map((g) => [g.label, g.reminders.map((r) => r.id)])).toEqual([
      ["Overdue", ["zero", "overdue"]],
      ["Today", ["today"]],
      ["Upcoming", ["later"]],
      ["Done", ["done-later", "done"]],
    ]);
    expect(
      groupReminders([reminder({ notBefore: 3000 })], NOW, 2000).map(
        (g) => g.label,
      ),
    ).toEqual(["Upcoming"]);
    expect(groupReminders([], NOW, 2000)).toEqual([]);
  });
});

describe("reminder targets", () => {
  it("opens only targets with a channel and message", () => {
    expect(navigableTarget(reminder({ target: target() }))).toEqual(target());
    expect(navigableTarget(reminder({}))).toBeUndefined();
    expect(
      navigableTarget(reminder({ target: target("e", "") })),
    ).toBeUndefined();
    expect(
      navigableTarget(reminder({ target: target("", "c") })),
    ).toBeUndefined();
  });

  it("marks a message only while its reminder is pending, once per snapshot", () => {
    const state = {
      status: "ready" as const,
      hydrated: true,
      reminders: [
        reminder({ id: "a", target: target("m") }),
        reminder({ id: "b", target: target("d"), status: "done" }),
        reminder({ id: "c" }),
      ],
    };
    expect([...pendingMessageIds(state)]).toEqual(["m"]);
    expect(pendingMessageIds(state)).toBe(pendingMessageIds(state));
  });
});

describe("time presets", () => {
  it("returns strictly future times matching their labels", () => {
    const before = nowSeconds();
    const at = Object.fromEntries(TIME_PRESETS.map((p) => [p.label, p.at()]));
    for (const value of Object.values(at))
      expect(value).toBeGreaterThan(before);
    expect(
      Math.abs((at["In 30 minutes"] ?? 0) - (before + 1800)),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs((at["In 1 hour"] ?? 0) - (before + 3600)),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs((at["In 3 hours"] ?? 0) - (before + 10_800)),
    ).toBeLessThanOrEqual(2);
    for (const label of ["Tomorrow at 9am", "Next Monday at 9am"]) {
      const date = new Date((at[label] ?? 0) * 1000);
      expect([date.getHours(), date.getMinutes()]).toEqual([9, 0]);
    }
    expect(new Date((at["Next Monday at 9am"] ?? 0) * 1000).getDay()).toBe(1);
  });

  it("accepts only well-formed future custom times", () => {
    const day = (offset: number) => {
      const d = new Date(Date.now() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    expect(parseCustomDateTime(day(86_400_000), "14:30")).toBeGreaterThan(
      nowSeconds(),
    );
    expect(parseCustomDateTime(day(-365 * 86_400_000), "09:00")).toBeNull();
    expect(parseCustomDateTime("", "09:00")).toBeNull();
    expect(parseCustomDateTime("2099-01-01", "")).toBeNull();
    expect(parseCustomDateTime("not-a-date", "09:00")).toBeNull();
    expect(parseCustomDateTime("2099-01-01", "99:99")).toBeNull();
    expect(todayDateString()).toBe(day(0));
  });

  it("reports a custom time moved by the spring-forward gap", () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const skipped = parseCustomDateTime("2099-03-08", "02:30");
      expect(skipped).not.toBeNull();
      expect(shiftedFrom("02:30", skipped ?? 0)).toBe(true);
      const ordinary = parseCustomDateTime("2099-03-08", "04:30");
      expect(shiftedFrom("04:30", ordinary ?? 0)).toBe(false);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});

describe("dueLabel", () => {
  const at = (date: Date) => Math.floor(date.getTime() / 1000);
  const base = new Date(2026, 9, 13, 12, 0);
  const time = (date: Date) =>
    date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  it("counts overdue reminders back from now", () => {
    expect(dueLabel(at(base) - 2 * 3600, at(base))).toBe(
      "Overdue · 2 hours ago",
    );
  });

  it("names today, tomorrow, this week and later dates", () => {
    const later = (days: number, hours: number) => {
      const date = new Date(base);
      date.setDate(date.getDate() + days);
      date.setHours(hours, 0, 0, 0);
      return date;
    };
    const today = later(0, 15);
    const tomorrow = later(1, 9);
    const friday = later(3, 9);
    const nextMonth = later(20, 9);
    expect(dueLabel(at(today), at(base))).toBe(`Today at ${time(today)}`);
    expect(dueLabel(at(tomorrow), at(base))).toBe(
      `Tomorrow at ${time(tomorrow)}`,
    );
    expect(dueLabel(at(friday), at(base))).toBe(
      `${friday.toLocaleDateString([], { weekday: "long" })} at ${time(friday)}`,
    );
    expect(dueLabel(at(nextMonth), at(base))).toBe(
      `${nextMonth.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time(nextMonth)}`,
    );
  });

  it("labels a later year's date with its year", () => {
    const december = new Date(2026, 11, 28, 12, 0);
    const january = new Date(2027, 0, 10, 9, 0);
    expect(dueLabel(at(january), at(december))).toBe(
      `${january.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })} at ${time(january)}`,
    );
  });

  it("hints a preset's time, with its weekday once past midnight", () => {
    const late = new Date(2026, 9, 13, 22, 0);
    const soon = new Date(late.getTime() + 3600_000);
    const afterMidnight = new Date(late.getTime() + 3 * 3600_000);
    expect(presetHint(at(soon), at(late))).toBe(time(soon));
    expect(presetHint(at(afterMidnight), at(late))).toBe(
      `${afterMidnight.toLocaleDateString([], { weekday: "short" })} ${time(afterMidnight)}`,
    );
  });
});
