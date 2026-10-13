import { useId, type Ref } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuGroupLabel,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import {
  CaretDownIcon,
  NotificationIcon,
  NotificationFilledIcon,
} from "../../shared/design-system/icons";

export type ActivityFilter = "all" | "threads" | "mentions" | "dms";
export type SenderFilter = "everyone" | "humans" | "agents";
const views = [
  { value: "all", label: "All" },
  { value: "threads", label: "Threads" },
  { value: "mentions", label: "Mentions" },
  { value: "dms", label: "DMs" },
  { value: "drafts", label: "Drafts" },
] as const;

export function InboxFilters({
  view,
  sender,
  unreadOnly,
  triggerRef,
  onViewChange,
  onSenderChange,
  onUnreadChange,
}: {
  view: ActivityFilter | "drafts";
  sender: SenderFilter;
  unreadOnly: boolean;
  triggerRef: Ref<HTMLButtonElement>;
  onViewChange(view: ActivityFilter | "drafts"): void;
  onSenderChange(sender: SenderFilter): void;
  onUnreadChange(checked: boolean): void;
}) {
  const selectionId = useId();
  const drafts = view === "drafts";
  const label = views.find((item) => item.value === view)?.label;
  const summary = `${label}${!drafts && sender !== "everyone" ? ` · ${sender === "humans" ? "People" : "Agents"}` : ""}`;
  return (
    <>
      <MenuRoot>
        <MenuTrigger
          ref={triggerRef}
          aria-label="Inbox filters"
          aria-describedby={selectionId}
          render={
            <Button size="sm" variant="ghost">
              <span id={selectionId}>{summary}</span>
              <CaretDownIcon size="1rem" />
            </Button>
          }
        />
        <MenuPopup aria-label="Inbox filters">
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">From</MenuGroupLabel>
            <MenuCheckboxItem
              checked={sender !== "agents"}
              disabled={drafts || sender === "humans"}
              closeOnClick={false}
              onCheckedChange={(checked) => {
                if (!drafts && (checked || sender === "everyone"))
                  onSenderChange(checked ? "everyone" : "agents");
              }}
            >
              People
            </MenuCheckboxItem>
            <MenuCheckboxItem
              checked={sender !== "humans"}
              disabled={drafts || sender === "agents"}
              closeOnClick={false}
              onCheckedChange={(checked) => {
                if (!drafts && (checked || sender === "everyone"))
                  onSenderChange(checked ? "everyone" : "humans");
              }}
            >
              Agents
            </MenuCheckboxItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">Show</MenuGroupLabel>
            <MenuRadioGroup value={view} onValueChange={onViewChange}>
              {views.map((item) => (
                <MenuRadioItem
                  key={item.value}
                  value={item.value}
                  selection="highlight"
                  closeOnClick
                >
                  {item.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </MenuRoot>
      {!drafts && (
        <IconButton
          size="sm"
          variant="bare"
          aria-label="Unread only"
          aria-pressed={unreadOnly}
          title="Show unread only"
          onClick={() => onUnreadChange(!unreadOnly)}
          icon={
            unreadOnly ? (
              <NotificationFilledIcon size="1.25rem" />
            ) : (
              <NotificationIcon size="1.25rem" />
            )
          }
        />
      )}
    </>
  );
}
