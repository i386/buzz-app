import { invoke, isTauri } from "@tauri-apps/api/core";
import { eventsDto, type RelayEvent } from "../relay/events";

/** A plugin agent's identity as native custody reports it; never the key. The
 * saved identities are the agent list. */
export type AgentIdentity = Readonly<{
  pubkey: string;
  /** The canonical `wss://` community origin it was created for. */
  relay: string;
  owner: string;
  /** The agent type's key, `pluginId/typeId`, fixed at create. */
  type: string;
  name: string;
  /** Its profile picture, an HTTPS image URL. */
  picture?: string;
  /** Its key is gone; its community still has to drop it from its channels and
   * archive it, after which `forget` removes it. */
  deleted: boolean;
}>;
/** Where an earlier agent system saved an identity on this machine: this app's
 * harness agents, or the installed or development build of old Buzz. */
export type PortSource = "harness" | "installed" | "development";
/** An identity an earlier agent system saved, which Agents can take over. */
export type PortableAgent = Readonly<{
  source: PortSource;
  pubkey: string;
  name: string;
  picture?: string;
  /** The community it was saved for there, if valid. */
  relay: string;
}>;
/** What an agent kept in an earlier system that its new type may adopt. */
export type Carry = Readonly<{
  instructions?: string;
  /** Its working directory, absolute or `~/…`. */
  workspace?: string;
}>;
export type PortableAgents = Readonly<{
  agents: readonly PortableAgent[];
  /** A store that could not be read; the others are still listed. */
  warnings: readonly string[];
}>;
export type AgentEventTemplate = Readonly<{
  kind: number;
  content: string;
  tags?: readonly (readonly string[])[];
}>;
/** The community's description of an uploaded blob. */
export type AgentUpload = Readonly<{
  url: string;
  sha256: string;
  size: number;
  type: string;
  dim?: string;
  blurhash?: string;
  thumb?: string;
  duration?: number;
}>;
export type AgentsNative = {
  list(): Promise<readonly AgentIdentity[]>;
  /** Generates a key, has the signed-in owner attest it, and saves both. */
  create(
    destination: string,
    owner: string,
    type: string,
    name: string,
  ): Promise<AgentIdentity>;
  /** Earlier agent systems' identities on this machine. */
  portable(): Promise<PortableAgents>;
  /** Takes one over with its key, name and picture, as `create` does, with
   * what it kept there for its new type. */
  port(
    source: PortSource,
    pubkey: string,
    destination: string,
    owner: string,
    type: string,
  ): Promise<Readonly<{ agent: AgentIdentity; carry: Carry }>>;
  rename(pubkey: string, name: string): Promise<void>;
  /** Sets its profile picture, an HTTPS image URL, or with `null` clears it. */
  setPicture(pubkey: string, picture: string | null): Promise<void>;
  /** Makes it an agent of another type, keeping its identity and profile. */
  setType(pubkey: string, type: string): Promise<void>;
  /** Deletes the key and marks the identity deleted. */
  remove(pubkey: string): Promise<void>;
  /** Drops a deleted identity. */
  forget(pubkey: string): Promise<void>;
  /** Signs one event as the agent (deletions, reactions, messages, edits,
   * canvases and DM opens only) with its owner attestation and posts it to the
   * agent's community. */
  publish(pubkey: string, event: AgentEventTemplate): Promise<RelayEvent>;
  /** Reads the agent's community as the agent: one to eight filters. */
  query(pubkey: string, filters: readonly object[]): Promise<RelayEvent[]>;
  /** Uploads base64 `data` (an image or MP4) as the agent. */
  upload(pubkey: string, data: string, mime: string): Promise<AgentUpload>;
  /** Downloads one of its community's media blobs as the agent, as base64. */
  media(pubkey: string, url: string): Promise<string>;
  /** Writes memory entry `slug`, encrypted to the owner, newer than `after`. */
  remember(
    pubkey: string,
    slug: string,
    body: string,
    after: number,
  ): Promise<RelayEvent>;
  /** Publishes its name as its profile unless the community already has it. */
  publishProfile(pubkey: string): Promise<void>;
  /** Whether this app runs the agent: every copy of the app on this machine
   * shares the agent list, and one runs each agent. The installed app always
   * runs what it can; a dev build lets go while it does. */
  claim(pubkey: string): Promise<boolean>;
  /** Lets another copy run it. */
  release(pubkey: string): Promise<void>;
};

export const nativeAgents = (): AgentsNative | undefined =>
  isTauri()
    ? {
        list: () => invoke("app_agent_list"),
        create: (destination, owner, agentType, name) =>
          invoke("app_agent_create", { destination, owner, agentType, name }),
        portable: () => invoke("app_agent_portable"),
        port: (source, pubkey, destination, owner, agentType) =>
          invoke("app_agent_port", {
            source,
            pubkey,
            destination,
            owner,
            agentType,
          }),
        rename: (pubkey, name) => invoke("app_agent_rename", { pubkey, name }),
        setPicture: (pubkey, picture) =>
          invoke("app_agent_set_picture", { pubkey, picture }),
        setType: (pubkey, agentType) =>
          invoke("app_agent_set_type", { pubkey, agentType }),
        remove: (pubkey) => invoke("app_agent_delete", { pubkey }),
        forget: (pubkey) => invoke("app_agent_forget", { pubkey }),
        publish: (pubkey, event) =>
          invoke("app_agent_publish", {
            pubkey,
            event: {
              kind: event.kind,
              content: event.content,
              tags: event.tags ?? [],
            },
          }),
        query: async (pubkey, filters) =>
          eventsDto(await invoke("app_agent_query", { pubkey, filters })),
        upload: (pubkey, data, mime) =>
          invoke("app_agent_upload", { pubkey, data, mime }),
        media: (pubkey, url) => invoke("app_agent_media", { pubkey, url }),
        remember: (pubkey, slug, body, after) =>
          invoke("app_agent_remember", { pubkey, slug, body, after }),
        publishProfile: (pubkey) =>
          invoke("app_agent_publish_profile", { pubkey }),
        claim: (pubkey) => invoke("app_agent_claim", { pubkey }),
        release: (pubkey) => invoke("app_agent_release", { pubkey }),
      }
    : undefined;
