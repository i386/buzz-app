import { FadingLabel } from "./FadingLabel";
import { useId, useRef, useState, type ReactNode, type Ref } from "react";
import {
  MenuIcon,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  ArrowsDownUpIcon,
  CaretDownIcon,
  CaretUpIcon,
  DotsThreeIcon,
  PlusIcon,
  TextAaIcon,
  TimerIcon,
  TrashIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import type { RelaySession } from "../../features/relay/session";
import { SidebarGroupIcon } from "./SidebarGroupIcon";
import styles from "./Channels.module.css";

export function SidebarSection({
  sectionKey,
  title,
  hideTitle = false,
  icon,
  session,
  open,
  onToggle,
  createChannel,
  newMessage,
  sort,
  dropRef,
  dropTarget = false,
  onRemove,
  channelCount,
  removalFocus,
  children,
}: {
  sectionKey: string;
  title: string;
  hideTitle?: boolean;
  icon?: string | undefined;
  session?: RelaySession | undefined;
  open: boolean;
  onToggle: (open: boolean) => void;
  onRemove?: (() => unknown) | undefined;
  channelCount?: number | undefined;
  removalFocus?: (() => HTMLElement | null | undefined) | undefined;
  createChannel?:
    | { available: boolean; open: (trigger: HTMLButtonElement) => void }
    | undefined;
  newMessage?: (() => void) | undefined;
  sort?:
    | {
        value: "alpha" | "recent";
        change: (mode: "alpha" | "recent") => void;
      }
    | undefined;
  dropRef?: Ref<HTMLDivElement> | undefined;
  dropTarget?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const cancelRemove = useRef<HTMLButtonElement>(null);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const canRemove = !!onRemove && sectionKey.startsWith("group:");
  const remove = async () => {
    if (!onRemove || removing) return;
    setRemoving(true);
    setRemoveError("");
    try {
      await onRemove();
      setRemoveOpen(false);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : String(error));
    } finally {
      setRemoving(false);
    }
  };
  if (hideTitle)
    return (
      <div className={`${styles.channelSection} ${styles.untitledSection}`}>
        <div
          id={id}
          className={`${styles.sectionContent} ${styles.untitledSectionContent}`}
        >
          <div>{children}</div>
        </div>
        <div className={styles.sectionActions}>
          {newMessage && (
            <IconButton
              size="compact"
              aria-label="New message"
              title="New message"
              onClick={newMessage}
              icon={<PlusIcon strokeWidth={2.5} size={15} />}
            />
          )}
        </div>
      </div>
    );
  return (
    <div
      ref={dropRef}
      className={styles.channelSection}
      data-sidebar-section={sectionKey}
      data-drop-target={dropTarget || undefined}
    >
      <div className={styles.sectionHeader}>
        <details open={open}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: summary has native keyboard activation. */}
          <summary
            aria-label={title}
            aria-controls={id}
            onClick={(event) => {
              event.preventDefault();
              onToggle(!open);
            }}
          >
            <span className={styles.sectionLabel}>
              {icon && session && (
                <SidebarGroupIcon icon={icon} session={session} />
              )}
              <FadingLabel className={styles.sectionTitle}>{title}</FadingLabel>
            </span>
            <span className={`${styles.sidebarIcon} ${styles.sectionChevron}`}>
              <CaretDownIcon strokeWidth={2.5} size={15} />
            </span>
          </summary>
        </details>
        <div className={styles.sectionActions}>
          <MenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger
              ref={actionsTrigger}
              render={(props) => (
                <IconButton
                  {...props}
                  size="compact"
                  aria-label={`More actions for ${title}`}
                  icon={<DotsThreeIcon strokeWidth={2.5} size={15} />}
                />
              )}
            />
            <MenuPopup align="end" aria-label={`More actions for ${title}`}>
              {sort && (
                <MenuSubmenu>
                  <MenuSubmenuTrigger>
                    <MenuIcon>
                      <ArrowsDownUpIcon size={14} />
                    </MenuIcon>
                    Sort
                  </MenuSubmenuTrigger>
                  <MenuSubmenuPopup
                    aria-label={`Sort ${title}`}
                    finalFocus={false}
                  >
                    <MenuRadioGroup
                      value={sort.value}
                      onValueChange={(mode) => {
                        sort.change(mode as "alpha" | "recent");
                        setMenuOpen(false);
                      }}
                    >
                      <MenuRadioItem closeOnClick={false} value="recent">
                        <MenuIcon>
                          <TimerIcon size={14} />
                        </MenuIcon>
                        Recent
                      </MenuRadioItem>
                      <MenuRadioItem closeOnClick={false} value="alpha">
                        <MenuIcon>
                          <TextAaIcon size={14} />
                        </MenuIcon>
                        A–Z
                      </MenuRadioItem>
                    </MenuRadioGroup>
                  </MenuSubmenuPopup>
                </MenuSubmenu>
              )}
              <MenuItem
                onClick={() => {
                  onToggle(!open);
                  setMenuOpen(false);
                }}
              >
                <MenuIcon>
                  {open ? (
                    <CaretUpIcon size={14} />
                  ) : (
                    <CaretDownIcon size={14} />
                  )}
                </MenuIcon>
                {open ? "Collapse section" : "Expand section"}
              </MenuItem>
              {canRemove && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    tone="danger"
                    onClick={() => {
                      setRemoveError("");
                      setMenuOpen(false);
                      setRemoveOpen(true);
                    }}
                  >
                    <MenuIcon>
                      <TrashIcon size={14} />
                    </MenuIcon>
                    Remove section
                  </MenuItem>
                </>
              )}
            </MenuPopup>
          </MenuRoot>
          {newMessage && (
            <IconButton
              size="compact"
              aria-label="New message"
              title="New message"
              onClick={newMessage}
              icon={<PlusIcon strokeWidth={2.5} size={15} />}
            />
          )}
          {canRemove && (
            <Dialog
              open={removeOpen}
              onOpenChange={setRemoveOpen}
              dismissOnOutsideClick
              preventClose={removing}
              initialFocus={cancelRemove}
              finalFocus={() =>
                actionsTrigger.current?.isConnected
                  ? actionsTrigger.current
                  : (removalFocus?.() ?? false)
              }
              title={`Remove ${title}?`}
              description={`${channelCount === undefined ? "Assigned channels" : `${channelCount} ${channelCount === 1 ? "channel" : "channels"}`} will move back to Channels. This does not delete any channels.`}
              actions={
                <>
                  <Button
                    ref={cancelRemove}
                    type="button"
                    disabled={removing}
                    onClick={() => setRemoveOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    loading={removing}
                    onClick={() => void remove()}
                  >
                    Remove section
                  </Button>
                </>
              }
            >
              {removeError && <p role="alert">{removeError}</p>}
              {removing && (
                <p role="status" className="sr-only">
                  Removing section and waiting for confirmation…
                </p>
              )}
            </Dialog>
          )}
          {createChannel && (
            <IconButton
              size="compact"
              aria-label="Create channel"
              title={
                createChannel.available
                  ? "Create channel"
                  : "Channel creation unavailable"
              }
              disabled={!createChannel.available}
              onClick={(event) => createChannel.open(event.currentTarget)}
              icon={<PlusIcon strokeWidth={2.5} size={15} />}
            />
          )}
        </div>
      </div>
      <div
        id={id}
        className={styles.sectionContent}
        inert={!open}
        hidden={!open}
      >
        <div>{children}</div>
      </div>
    </div>
  );
}
