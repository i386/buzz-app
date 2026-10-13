// What the Buzz tools need from whoever holds the agent's key: the app's native
// custody in Buzz Desktop, or a key in the environment of a standalone server.
// The tools never see the key itself.

export type BuzzEvent = Readonly<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: readonly (readonly string[])[];
  content: string;
  sig: string;
}>;
export type Template = Readonly<{
  kind: number;
  content: string;
  tags: readonly (readonly string[])[];
}>;
export type Filter = Readonly<Record<string, unknown>>;
/** The community's description of an uploaded blob. */
export type Upload = Readonly<{
  url: string;
  sha256: string;
  size: number;
  type: string;
  dim?: string;
  blurhash?: string;
  thumb?: string;
  duration?: number;
}>;
export type Memory = Readonly<{
  slug: string;
  body: string;
  createdAt: number;
}>;

export interface BuzzClient {
  readonly pubkey: string;
  /** Reads the community as the agent. Every filter names its kinds. */
  query(filters: readonly Filter[]): Promise<readonly BuzzEvent[]>;
  /** Signs `event` as the agent and posts it. */
  publish(event: Template): Promise<BuzzEvent>;
  upload(data: Uint8Array, mime: string): Promise<Upload>;
  /** Downloads a community media blob, by its URL or `sha256[.ext]`, as
   * base64. */
  media(url: string): Promise<string>;
  /** A local file's bytes, for tools that take a `path`. */
  read(path: string): Promise<Uint8Array>;
  /** The agent's memory entries, decrypted. */
  memories(): Promise<readonly Memory[]>;
  /** Writes entry `slug`, newer than the one it replaces (`after`, or 0). */
  remember(slug: string, body: string, after: number): Promise<void>;
}

/** Where the agent is working, so tools can default to it. */
export type Context = Readonly<{ channel?: string; root?: string }>;
