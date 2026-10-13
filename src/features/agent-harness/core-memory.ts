// An agent's memory as the harness plugins read it and show it to their
// agents, through the reads of the agent's community.
import type { AgentReads, MemoryListing } from "../agents/reads";

/** How long a shared read may take; each caller can stop waiting sooner. */
const READ_TIMEOUT_MS = 10_000;

/** One read per connection and agent at a time, which concurrent turns and
 * tool calls share. A new connection, even to the same community, may read as
 * someone else, so it shares nothing with an old one. */
export class MemoryReads {
  private reads = new WeakMap<object, Map<string, Promise<MemoryListing>>>();

  async read(
    source: Pick<AgentReads, "connection" | "memoryListing">,
    agent: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    let reads = this.reads.get(source.connection);
    if (!reads) {
      reads = new Map();
      this.reads.set(source.connection, reads);
    }
    let read = reads.get(agent);
    if (!read) {
      const started = source.memoryListing(
        AbortSignal.timeout(READ_TIMEOUT_MS),
      );
      const shared = reads;
      const done = () => {
        if (shared.get(agent) === started) shared.delete(agent);
      };
      void started.then(done, done);
      reads.set(agent, started);
      read = started;
    }
    return abortable(read, signal);
  }

  /** After a memory write, a read that may have started before it is not
   * shared with later callers. */
  forget(connection: object, agent: string) {
    this.reads.get(connection)?.delete(agent);
  }
}

/** The `core` memory in a listing: its text, `null` when the agent has none,
 * or undefined when a partial listing may have missed it. */
export function coreOf(listing: MemoryListing) {
  return (
    listing.entries.find((entry) => entry.slug === "core")?.body ??
    (listing.partial ? undefined : null)
  );
}

/** The `core` memory section of a prompt: its text, a prompt to create one
 * when it is `null`, or nothing when it is unread (`undefined`) or blank. */
export function coreMemorySection(memory: string | null | undefined) {
  const body =
    memory === null
      ? "No core memory found. Use `mem_set` with slug `core` to create one (it will hold your identity, rules, and goals across sessions). Ask your user about yourself."
      : memory?.trim();
  return body ? `<core-memory>\n${body}\n</core-memory>` : "";
}

/** Stops waiting when `signal` aborts, even if the read itself does not. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
