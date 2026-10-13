// FOUNDATION: Target-based panel contributions, independent of page layout.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import {
  createContributions,
  resolveMatch,
  type Contribution,
  type MatchOrder,
} from "../../plugins/contributions";

export type PanelContext = Readonly<{
  /** Originating conversation, not a claim of thread-level scope or access. */
  channelId: string;
  /** Thread root of the message the panel was opened from, when there is one. */
  rootId?: string;
  canOpen(target: string): boolean;
  /** Replace this panel through its host. False after this opening is retired. */
  open(target: string): boolean;
  /** Drill into a child while the channel host retains the previous view. */
  push?(target: string): boolean;
}>;
/** Public presentation context, not authentication or a live selection service. */
export type ChannelPanelContext = Readonly<{
  scope: string;
  channelId: string;
  channelName: string;
  viewer: string;
  relayUrl: string;
  threadId?: string;
}>;
export type ChannelLauncherProps = {
  context: ChannelPanelContext;
  pressed: boolean;
  /** Toggles this exact contribution in the page-owned channel panel. */
  toggle(target: string): void;
  /** False after this page binding or exact contribution is retired. */
  available(): boolean;
};
export type PanelProps = {
  /** Supplied only by a channel presentation; sessions decide when to capture it. */
  channelContext?: ChannelPanelContext | undefined;
  close(): void;
  target: string;
  context?: PanelContext | undefined;
};
export type Panel = Readonly<{
  id: string;
  title: string;
  matches: (url: string) => boolean;
  /** Claim strength when several panels match a target; see `MatchOrder`. */
  order?: MatchOrder | undefined;
  // Optional host launcher; placement stays with the current page or host fallback.
  launcher?: Readonly<{ icon: string; target: string }>;
  // Optional channel-header launcher. The page supplies context and owns placement.
  channelLauncher?: ComponentType<ChannelLauncherProps>;
  /** Optional Channels menu placement; eligibility is presentation-only, not access. */
  channelMenu?: Readonly<{
    label: string;
    eligible(channel: ChannelSummary, session: RelaySession): boolean;
  }>;
  /** Channel launchers default to the bottom drawer; side reuses the companion column. */
  channelPlacement?: "bottom" | "side";
  component: ComponentType<PanelProps>;
}>;
export type RegisteredPanel = Contribution<Panel>;
export type Panels = {
  register(panel: Panel): void;
  resolve(target: string): RegisteredPanel | undefined;
  snapshot(): readonly RegisteredPanel[];
  subscribe(listener: () => void): () => void;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    panels: Panels;
  }
}
export class PanelsService extends Service implements Panels {
  private readonly panels;
  constructor(ctx: Context) {
    super(ctx, "panels");
    this.panels = createContributions<Panel>(ctx);
  }
  snapshot = () => this.panels.snapshot();
  subscribe = (listener: () => void) => this.panels.subscribe(listener);
  resolve = (target: string) => resolveMatch(this.panels.snapshot(), target);
  register(panel: Panel) {
    if (
      !panel ||
      typeof panel.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(panel.id) ||
      typeof panel.title !== "string" ||
      !panel.title.trim() ||
      typeof panel.matches !== "function" ||
      typeof panel.component !== "function"
    ) {
      throw new Error("A panel needs an id, title, matcher, and component");
    }
    if (
      panel.order !== undefined &&
      typeof panel.order !== "number" &&
      typeof panel.order !== "function"
    )
      throw new Error("A panel order must be a number or function");
    if (
      panel.launcher !== undefined &&
      (!panel.launcher ||
        typeof panel.launcher.icon !== "string" ||
        !panel.launcher.icon.trim() ||
        typeof panel.launcher.target !== "string")
    ) {
      throw new Error("A panel launcher needs an icon and target string");
    }
    if (
      panel.channelLauncher !== undefined &&
      typeof panel.channelLauncher !== "function"
    )
      throw new Error("A channel launcher needs a component");
    if (
      panel.channelMenu !== undefined &&
      (!panel.channelMenu ||
        typeof panel.channelMenu.label !== "string" ||
        !panel.channelMenu.label.trim() ||
        typeof panel.channelMenu.eligible !== "function")
    )
      throw new Error(
        "A channel menu launcher needs a label and eligibility predicate",
      );
    if (
      panel.channelPlacement !== undefined &&
      panel.channelPlacement !== "bottom" &&
      panel.channelPlacement !== "side"
    )
      throw new Error("A channel placement must be bottom or side");
    this.panels.register(this.ctx, {
      ...panel,
      ...(panel.launcher && { launcher: Object.freeze({ ...panel.launcher }) }),
      ...(panel.channelMenu && {
        channelMenu: Object.freeze({ ...panel.channelMenu }),
      }),
    });
  }
}
