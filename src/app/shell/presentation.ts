import {
  AlarmIcon,
  BellIcon,
  BestieIcon,
  BrowserIcon,
  ChatsCircleIcon,
  FolderSimpleIcon,
  GearIcon,
  LightningIcon,
  RobotIcon,
} from "../../shared/design-system/icons/index";
import type { RegisteredPage } from "../../features/pages/service";

// Shell-owned presentation keeps plugin content independent of navigation chrome.
// Add page identities here; unknown plugins inherit a consistent layout default.
export const shellPresentation = {
  settings: { label: "Settings", icon: GearIcon, tone: "lavender" },
  channels: { label: "Messages", icon: ChatsCircleIcon, tone: "lime" },
} as const;

// Navigation order is host policy, never plugin activation timing. Match full
// contribution keys so an external page's local ID cannot claim a bundled slot.
const bundledOrder = [
  "buzz.me/me",
  "buzz.channels/channels",
  "buzz.inbox/inbox",
  "buzz.reminders/reminders",
  "buzz.bestie/bestie",
  "buzz.projects/projects",
];
export function orderPages(pages: readonly RegisteredPage[]) {
  const rank = (page: RegisteredPage) => {
    const slot = bundledOrder.indexOf(page.key);
    return slot === -1 ? bundledOrder.length : slot;
  };
  return [...pages].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      pagePresentation(a).label.localeCompare(
        pagePresentation(b).label,
        "en",
      ) ||
      a.key.localeCompare(b.key, "en"),
  );
}

const bundledIcons = new Map<string, typeof BrowserIcon>([
  ["buzz.inbox/inbox", BellIcon],
  ["buzz.reminders/reminders", AlarmIcon],
  ["buzz.bestie/bestie", BestieIcon],
  ["buzz.projects/projects", FolderSimpleIcon],
  ["buzz.agents/agents", RobotIcon],
  ["buzz.workflows/workflows", LightningIcon],
]);
type PagePresentation = Readonly<{
  label: string;
  icon: typeof BrowserIcon;
  tone: string;
  image?: string;
}>;
export function pagePresentation(page: RegisteredPage): PagePresentation {
  if (page.key === "buzz.channels/channels") return shellPresentation.channels;
  const tone = page.layout === "workspace" ? "lime" : "sky";
  const bundledIcon = bundledIcons.get(page.key);
  if (bundledIcon) return { label: page.title, icon: bundledIcon, tone };
  return {
    label: page.title,
    icon: BrowserIcon,
    tone,
    ...(page.icon === undefined ? {} : { image: page.icon }),
  };
}

// Header selection describes the area; sidebar selection and routes stay exact.
export function headerPageSelection(
  pages: readonly RegisteredPage[],
  selected: string,
): string {
  const page = pages.find((page) => page.key === selected);
  if (
    selected !== "buzz.me/me" &&
    page &&
    // Placement applies only to primary pages.
    (!page.primary ||
      page.placement === undefined ||
      page.placement === "sidebar") &&
    pages.some(
      (page) =>
        page.key === "buzz.channels/channels" &&
        page.primary &&
        page.placement === "topbar",
    )
  )
    return "buzz.channels/channels";
  return selected;
}
