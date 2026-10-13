import { expect, it, vi } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import { AppServer, type Wire } from "./rpc";
function fixture() {
  let options: HostProcessOptions | undefined;
  let exit!: (code: number) => void;
  const sent: Wire[] = [];
  const process = {
    write: async (text: string) => {
      const wire: Wire = JSON.parse(text);
      sent.push(wire);
      if (wire.method === "initialize" && wire.id != null)
        emit({ id: wire.id, result: {} });
    },
    end: vi.fn(async () => {
      exit(0);
    }),
    kill: vi.fn(async () => {
      exit(1);
    }),
    exited: new Promise<number>((resolve) => {
      exit = resolve;
    }),
  };
  const raw = (text: string) => options?.onStdout?.(text);
  const emit = (wire: Wire) => raw(`${JSON.stringify(wire)}\n`);
  const rpc = new AppServer();
  const open = () =>
    rpc.open(async (_id, value) => {
      options = value;
      return process;
    });
  return { rpc, open, raw, emit, sent, process };
}
it("correlates out-of-order JSONL responses across chunk boundaries and rejects interactive requests once", async () => {
  const f = fixture();
  await f.open();
  const first = f.rpc.request("first");
  const second = f.rpc.request("second");
  const a = f.sent.find((w) => w.method === "first");
  const b = f.sent.find((w) => w.method === "second");
  const text = `${JSON.stringify({ id: b?.id, result: "second result" })}\n${JSON.stringify({ id: a?.id, result: "first result" })}\n`;
  f.raw(text.slice(0, 11));
  f.raw(text.slice(11));
  await expect(first).resolves.toBe("first result");
  await expect(second).resolves.toBe("second result");
  const one = vi.fn();
  const two = vi.fn();
  f.rpc.onMessage(one);
  f.rpc.onMessage(two);
  f.emit({
    id: "interactive",
    method: "item/tool/requestUserInput",
    params: {},
  });
  expect(f.sent.filter((w) => w.id === "interactive")).toEqual([
    { id: "interactive", error: { code: -32601, message: expect.any(String) } },
  ]);
  expect(one).not.toHaveBeenCalled();
  expect(two).not.toHaveBeenCalled();
  await f.rpc.close();
});
it("contains consumer exceptions and closes malformed output while rejecting pending work", async () => {
  const f = fixture();
  await f.open();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const listener = vi.fn();
  f.rpc.onMessage(() => {
    throw new Error("consumer failure");
  });
  f.rpc.onMessage(listener);
  try {
    expect(() => f.emit({ method: "turn/started", params: {} })).not.toThrow();
    expect(listener).toHaveBeenCalledWith({
      method: "turn/started",
      params: {},
    });
    const request = f.rpc.request("waiting");
    const rejected = expect(request).rejects.toThrow();
    expect(() => f.raw("invalid json\n")).not.toThrow();
    await rejected;
    await f.rpc.close();
    expect(f.process.end).toHaveBeenCalledTimes(1);
  } finally {
    consoleError.mockRestore();
  }
});
