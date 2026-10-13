import { expect, it } from "vitest";
import type {
  StaffFailure,
  StaffOutcome,
  StaffRequest,
} from "../../features/relay-staff/contract";
import { createWrites } from "./writes";

const unclear: StaffFailure = {
  category: "ambiguous",
  status: 502,
  bodyComplete: true,
  bodyEmpty: false,
  code: null,
  notSent: false,
  authLost: false,
  message: "",
};
const ambiguous: StaffOutcome<unknown> = { ok: false, failure: unclear };
const lift = (pubkey: string): StaffRequest => ({
  route: "liftRestriction",
  communityHost: "team.example.com",
  kind: "ban",
  pubkey,
});

function deferred() {
  let resolve!: (outcome: StaffOutcome<unknown>) => void;
  const promise = new Promise<StaffOutcome<unknown>>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A sender that records each request and leaves it uncertain. */
const record = (sent: StaffRequest[]) => async (request: StaffRequest) => {
  sent.push(request);
  return ambiguous;
};

it("a write without a request id can't overlap and is replaced by a new one", async () => {
  const writes = createWrites();
  const sent: StaffRequest[] = [];
  const reply = deferred();
  const send = (request: StaffRequest) => {
    sent.push(request);
    return reply.promise;
  };
  const first = writes.run("lift", send, lift("a"));
  expect(await writes.run("lift", send, lift("b"))).toBeNull();
  writes.discard("lift");
  expect(writes.get("lift")?.sending).toBe(true);
  reply.resolve(ambiguous);
  await first;
  await writes.run("lift", record(sent), lift("b"));
  expect(sent).toEqual([lift("a"), lift("b")]);
});

it("a held write with a request id is resent unchanged, whatever the form says", async () => {
  const writes = createWrites();
  const sent: StaffRequest[] = [];
  const send = record(sent);
  const reopen = (requestId: string): StaffRequest => ({
    route: "reopenReport",
    id: "r1",
    requestId,
  });
  await writes.run("reopen", send, reopen("one"));
  await writes.run("reopen", send, reopen("two"));
  expect(sent).toEqual([reopen("one"), reopen("one")]);
});

it("an empty 404 on a retry keeps an uncertain write and its request id", async () => {
  const writes = createWrites();
  const sent: StaffRequest[] = [];
  const reopen: StaffRequest = {
    route: "reopenReport",
    id: "r1",
    requestId: "one",
  };
  await writes.run("reopen", record(sent), reopen);
  const missing: StaffOutcome<unknown> = {
    ok: false,
    failure: {
      ...unclear,
      category: "unsupported",
      status: 404,
      bodyEmpty: true,
    },
  };
  await writes.run("reopen", async (request) => {
    sent.push(request);
    return missing;
  });
  expect(writes.get("reopen")).toMatchObject({
    request: reopen,
    uncertain: true,
  });
  await writes.run("reopen", record(sent), { ...reopen, requestId: "two" });
  expect(sent).toEqual([reopen, reopen, reopen]);
});
