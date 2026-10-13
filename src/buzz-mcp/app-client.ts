// The Buzz tools' client inside the app: the agent's native-held key signs and
// reads through its Agents handle, files are read by a declared process, and
// memory is read back through the owner's own session, to whom it is
// encrypted.
import type { BuzzClient, Memory } from "./client";
import type { AgentHandle } from "../features/agents/service";
import type { HostProcess, HostProcessOptions } from "../features/host/service";
type Spawn = (id: string, options?: HostProcessOptions) => Promise<HostProcess>;

/** The largest file a tool reads: the community's upload limit. */
const READ_LIMIT = 50 * 1024 * 1024;
const READ_TIMEOUT_MS = 60_000;

export function appClient(
  agent: AgentHandle,
  options: Readonly<{
    spawn: Spawn;
    /** Where relative paths start: the agent's working directory. */
    cwd: string;
    memories(): Promise<readonly Memory[]>;
    /** Forget a read that may have started before a successful memory write. */
    remembered?(): void;
    /** Reject operations after the owning turn or community has ended. */
    check?(): void;
    signal?: AbortSignal;
  }>,
): BuzzClient {
  const check = () => {
    options.signal?.throwIfAborted();
    options.check?.();
  };
  return {
    pubkey: agent.pubkey,
    query: (filters) => {
      check();
      return agent.query(filters);
    },
    publish: (event) => {
      check();
      return agent.publish(event);
    },
    upload: (data, mime) => {
      check();
      return agent.upload(toBase64(data), mime);
    },
    media: (url) => {
      check();
      return agent.media(url);
    },
    read: (path) => {
      check();
      return readFile(options.spawn, options.cwd, path, options.signal);
    },
    memories: () => {
      check();
      return options.memories();
    },
    remember: async (slug, body, after) => {
      check();
      await agent.remember(slug, body, after);
      check();
      options.remembered?.();
    },
  };
}

/** Reads a file with the plugin's declared `read` process (`base64 -i`),
 * which passes binary files through intact. */
export async function readFile(
  spawn: Spawn,
  cwd: string,
  path: string,
  signal?: AbortSignal,
) {
  // `-` would wait on stdin.
  if (path.trim() === "-" || !path.trim())
    throw new Error(`Cannot read ${path}`);
  let output = "";
  let error = "";
  let large = false;
  let child: Awaited<ReturnType<Spawn>> | undefined;
  child = await spawn("read", {
    args: [path],
    cwd,
    onStdout: (data) => {
      output += data;
      if (output.length > (READ_LIMIT / 3) * 4 + 1024 && !large) {
        large = true;
        void child?.kill();
      }
    },
    onStderr: (data) => {
      error += data;
    },
  });
  const abort = () => void child?.kill();
  signal?.addEventListener("abort", abort, { once: true });
  if (large || signal?.aborted) abort();
  const timer = setTimeout(() => void child?.kill(), READ_TIMEOUT_MS);
  let code: number | null;
  try {
    code = await child.exited;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  signal?.throwIfAborted();
  if (large) throw new Error(`${path} is larger than 50 MB`);
  if (code !== 0) throw new Error(error.trim() || `Could not read ${path}`);
  return fromBase64(output.replace(/\s/g, ""));
}

function toBase64(data: Uint8Array) {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000)
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
}
function fromBase64(text: string) {
  const binary = atob(text);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  return data;
}
