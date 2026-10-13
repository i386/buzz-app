import { expect, it } from "vitest";
import { activityPresentation } from "./activity-presentation";
import type { ToolItem } from "../../features/agents/activity-transcript";
const entry = (
  toolName: string,
  input: unknown = {},
  output = "",
): ToolItem => ({
  id: "tool",
  type: "tool",
  kind: "other",
  toolCallId: "tool",
  at: 0,
  diffs: [],
  paths: [],
  truncated: false,
  title: toolName,
  input: JSON.stringify(input),
  output,
  status: "completed",
});
it("maps only exact tools and structured paths; commands remain indivisible", () => {
  expect(
    activityPresentation(
      entry("buzz-dev-mcp__read_file", { path: "/work/src/Composer.tsx" }),
    ),
  ).toMatchObject({ title: "Read file", target: "Composer.tsx" });
  expect(
    activityPresentation(
      entry("buzz-dev-mcp__str_replace", { path: "C:\\work\\Composer.tsx" }),
    ),
  ).toMatchObject({ title: "Edit file", target: "Composer.tsx" });
  expect(
    activityPresentation(
      entry("buzz-dev-mcp__shell", {
        workdir: "/work/project",
        command: "read file; send message",
      }),
    ),
  ).toMatchObject({ title: "Run command", target: "read file; send message" });
  expect(
    activityPresentation(entry("unknown_shell", { path: "/work/secret" })),
  ).toMatchObject({ title: "unknown_shell", target: undefined });
});
it("never invents a file target from malformed or directory paths", () => {
  for (const path of [
    "",
    "/",
    "/work/",
    "C:\\",
    "..",
    12,
    { path: "file" },
    "a\nb",
  ]) {
    expect(
      activityPresentation(entry("buzz-dev-mcp__read_file", { path })),
    ).toMatchObject({ title: "buzz-dev-mcp__read_file", target: undefined });
  }
});
it("preserves stderr, empty output and wrapper warnings without interpreting markup", () => {
  const result = {
    stdout: "<script>inert</script>",
    stderr: "warning",
    exit_code: 2,
    timed_out: false,
    stdout_truncated: true,
    stderr_truncated: false,
  };
  expect(
    activityPresentation(
      entry("buzz-dev-mcp__shell", {}, JSON.stringify(result)),
    ).shellOutput,
  ).toEqual({
    stdout: "<script>inert</script>",
    stderr: "warning",
    failed: true,
    note: "Exit code 2 · Output was truncated by the tool",
  });
  expect(
    activityPresentation(
      entry(
        "buzz-dev-mcp__shell",
        {},
        JSON.stringify({ ...result, stdout: "", stderr: "" }),
      ),
    ).shellOutput?.stdout,
  ).toBe("");
  expect(
    activityPresentation(entry("other", {}, JSON.stringify(result)))
      .shellOutput,
  ).toBeUndefined();
  for (const output of [
    "broken",
    JSON.stringify({ ...result, stderr: null }),
    JSON.stringify({ stdout: "hi" }),
  ])
    expect(
      activityPresentation(entry("buzz-dev-mcp__shell", {}, output))
        .shellOutput,
    ).toBeUndefined();
});
it("previews distinct command text rather than repeated working directories", () => {
  const first = activityPresentation(
    entry("buzz-dev-mcp__shell", {
      command: "\ncat > REPORT.md <<'EOF'\nprivate text",
      workdir: ".buzz",
    }),
  );
  const second = activityPresentation(
    entry("buzz-dev-mcp__shell", {
      command: "wc -w REPORT.md",
      workdir: ".buzz",
    }),
  );
  expect(first.target).toBe("cat > REPORT.md <<'EOF'");
  expect(second.target).toBe("wc -w REPORT.md");
  expect(first.target).not.toContain("private text");
  expect(
    activityPresentation(
      entry("buzz-dev-mcp__shell", { command: "x".repeat(120) }),
    ).target,
  ).toBe(`${"x".repeat(90)}…`);
  expect(
    activityPresentation(
      entry("buzz-dev-mcp__shell", { command: "\t\u001bwc -w file" }),
    ).target,
  ).toBe("wc -w file");
});
