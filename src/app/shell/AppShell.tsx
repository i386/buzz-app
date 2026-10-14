import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { SidebarIcon, DotsThreeIcon } from "../../shared/design-system/icons";
import { Panel } from "../../shared/design-system/ui/Panel";
import { isTauri } from "@tauri-apps/api/core";
import type { SettingsCards } from "../../features/settings/service";
import type { RegisteredPage } from "../../features/pages/service";
import type { AccountActionsService } from "../../features/account-actions/service";
import type { Communities } from "../../features/communities/service";
import type { InviteLink } from "../../features/communities/invite-link";
import type { OpenTarget } from "../../features/navigation/targets";
import { CommunityRail } from "../../features/communities/CommunityRail";
import { ProfileButton } from "./ProfileButton";
import { PageSearch, type SearchServices } from "./PageSearch";
import { headerPageSelection, orderPages } from "./presentation";
import { PageNavigation } from "./PageNavigation";
import type { NavigationOpenOptions } from "../../features/navigation/controller";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { macTitleBarDragHandlers } from "./title-bar";
import { WindowControls } from "./WindowControls";

const macDesktop = isTauri() && /Mac/i.test(navigator.platform);
const titleBarDragProps = macDesktop ? macTitleBarDragHandlers : {};

export function AppShell({
  pages,
  selected,
  navigationAttempt,
  onSelect,
  tone,
  workspace,
  sidebar,
  communities,
  invite,
  onInviteClose,
  settingsCards,
  accountActions,
  onProfile,
  searchServices,
  navigationControls,
  onCommunitySelect,
  onOpenTarget,
  launchers,
  companion,
  children,
}: {
  pages: readonly RegisteredPage[];
  selected: string;
  navigationAttempt: string;
  onSelect: (
    key: string,
    options?: Pick<NavigationOpenOptions, "focus">,
  ) => void;
  tone: string;
  workspace?: boolean;
  sidebar?: (pages: ReactNode) => ReactNode;
  communities: Communities;
  invite?: (InviteLink & { requestId: number }) | undefined;
  onInviteClose?: ((requestId: number) => void) | undefined;
  settingsCards?: SettingsCards | undefined;
  accountActions: AccountActionsService;
  onProfile?: ((trigger: HTMLButtonElement) => void) | undefined;
  searchServices?: SearchServices;
  navigationControls?: ReactNode;
  onCommunitySelect?: (id: string | null) => void;
  /** Community menu destinations, opened through the host's navigation. */
  onOpenTarget?: (target: OpenTarget) => void;
  launchers?: ReactNode;
  companion?: ReactNode;
  children: ReactNode;
}) {
  const fillsWorkspace = workspace || selected === "settings";
  const channelsNavigation =
    selected === "buzz.channels/channels" || selected === "buzz.agents/agents";
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 650px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 650px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const meNavigation = selected === "buzz.me/me";
  const collapsibleSidebar =
    channelsNavigation ||
    meNavigation ||
    selected === "settings" ||
    pages.some((page) => page.key === selected && page.primary);
  const sidebarLabel = meNavigation
    ? "Me sidebar"
    : channelsNavigation
      ? "Channel sidebar"
      : "sidebar";
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const visibleSidebar = narrow ? navigationOpen : sidebarOpen;
  const toggleLabel = narrow
    ? navigationOpen
      ? "Hide navigation"
      : "Show navigation"
    : `${sidebarOpen ? "Hide" : "Show"} ${sidebarLabel}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a navigation attempt closes the drawer.
  useEffect(() => {
    if (navigationOpen && navigationToggle.current?.getClientRects().length) {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    }
    setNavigationOpen(false);
  }, [navigationAttempt]);
  // Toggling the sidebar changes only this shell's own state. Keep the
  // navigation element stable across those renders so React skips the whole
  // sidebar subtree instead of re-rendering every row on each click.
  const navigation = useMemo(() => {
    const sidebarPages = orderPages(
      pages.filter(
        (page) =>
          page.primary &&
          (page.placement === undefined || page.placement === "sidebar"),
      ),
    );
    const pageNavigation = sidebarPages.length ? (
      <nav aria-label="Pages" className="shell-pages">
        <PageNavigation
          pages={sidebarPages}
          selected={selected}
          onSelect={onSelect}
        />
      </nav>
    ) : null;
    return sidebar ? (
      sidebar(pageNavigation)
    ) : (
      <div className="shell-sidebar-default">
        <Panel as="aside" aria-label="Page sidebar">
          <div className="p-2">{pageNavigation}</div>
        </Panel>
      </div>
    );
  }, [pages, selected, onSelect, sidebar]);
  const headerPages = useMemo(
    () =>
      orderPages(
        pages.filter(
          (page) =>
            page.primary &&
            (page.placement === "topbar" || page.placement === "toolbar"),
        ),
      ),
    [pages],
  );
  const topbarPages = headerPages.filter((page) => page.placement === "topbar");
  const selectedHeader = headerPageSelection(pages, selected);
  const selectedTopbarPage = topbarPages.some(
    (page) => page.key === selectedHeader,
  );
  const panelKey = selectedTopbarPage ? selectedHeader : selected;
  const toolbarPages = headerPages.filter(
    (page) => page.placement === "toolbar",
  );
  const headerRef = useRef<HTMLElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLElement>(null);
  const overflowTrigger = useRef<HTMLButtonElement>(null);
  const overflowPages = useRef<HTMLElement>(null);
  const movingFocus = useRef(false);
  const [compactPages, setCompactPages] = useState(narrow);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Measure the real controls, including native insets and text scaling. Hidden
  // header groups retain intrinsic size, but are inert and absent from the a11y tree.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Registrations can mount new nav elements; observe their refs after every contribution change.
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const measure = () => {
      const style = getComputedStyle(header);
      const gap = parseFloat(style.columnGap) || 0;
      const left =
        (historyRef.current?.offsetWidth ?? 0) + parseFloat(style.paddingLeft);
      const right =
        (actionsRef.current?.offsetWidth ?? 0) +
        (toolbarRef.current?.offsetWidth ?? 0) +
        parseFloat(style.paddingRight) +
        gap;
      const center = topbarRef.current?.offsetWidth ?? 0;
      const compact =
        narrow ||
        2 * (Math.max(left, right) + gap) + center > header.clientWidth;
      // Do not strand keyboard focus inside a newly hidden group.
      if (
        compact &&
        !compactPages &&
        (topbarRef.current?.contains(document.activeElement) ||
          toolbarRef.current?.contains(document.activeElement))
      ) {
        movingFocus.current = true;
      }
      setCompactPages(compact);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [
      header,
      historyRef.current,
      actionsRef.current,
      topbarRef.current,
      toolbarRef.current,
    ]) {
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [narrow, compactPages, headerPages]);
  useLayoutEffect(() => {
    if (movingFocus.current) {
      movingFocus.current = false;
      overflowTrigger.current?.focus();
    }
    if (!compactPages) {
      if (
        document.activeElement === overflowTrigger.current ||
        overflowPages.current?.contains(document.activeElement)
      ) {
        (topbarRef.current ?? toolbarRef.current)
          ?.querySelector<HTMLButtonElement>("button")
          ?.focus();
      }
      setOverflowOpen(false);
    }
  }, [compactPages]);
  return (
    <div
      data-shell-tone={tone}
      className="shell-background flex h-dvh min-h-0 flex-col overflow-hidden bg-shell text-ink"
    >
      {/* biome-ignore lint/a11y/useValidAnchor: A skip link navigates to a real fragment; enhance focus without replacing the app route hash. */}
      <a
        href="#main-content"
        onClick={(event) => {
          // Focus intent is not a navigation visit and must not replace the route hash.
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-surface focus:p-3"
      >
        Skip to content
      </a>
      <header
        ref={headerRef}
        data-compact-pages={compactPages || undefined}
        data-tauri-drag-region={macDesktop ? undefined : true}
        {...titleBarDragProps}
        className={`shell-header ${macDesktop ? "shell-header-mac" : ""}`}
      >
        <div
          ref={historyRef}
          className="shell-communities"
          data-tauri-drag-region={macDesktop ? undefined : true}
          {...titleBarDragProps}
        >
          {(collapsibleSidebar || narrow) && (
            <IconButton
              ref={navigationToggle}
              data-shell-sidebar-toggle=""
              data-highlight-expanded="false"
              type="button"
              variant="ghost"
              aria-label={toggleLabel}
              aria-expanded={visibleSidebar}
              aria-controls="shell-navigation"
              title={toggleLabel}
              onClick={() => {
                if (narrow) setNavigationOpen((open) => !open);
                else setSidebarOpen((open) => !open);
              }}
              icon={<SidebarIcon aria-hidden="true" size={16} />}
            />
          )}
          {navigationControls}
        </div>
        {topbarPages.length > 0 && (
          <nav
            ref={topbarRef}
            aria-label="Topbar pages"
            className="shell-topbar-pages"
            aria-hidden={compactPages}
            inert={compactPages}
          >
            <PageNavigation
              pages={topbarPages}
              selected={selectedHeader}
              currentPage={selected}
              onSelect={onSelect}
              placement="topbar"
            />
          </nav>
        )}
        <div
          className="shell-actions"
          data-tauri-drag-region={macDesktop ? undefined : true}
          {...titleBarDragProps}
        >
          {toolbarPages.length > 0 && (
            <nav
              ref={toolbarRef}
              aria-label="Toolbar pages"
              className="shell-toolbar-pages"
              aria-hidden={compactPages}
              inert={compactPages}
            >
              <PageNavigation
                pages={toolbarPages}
                selected={selected}
                onSelect={onSelect}
                placement="toolbar"
              />
            </nav>
          )}
          {headerPages.length > 0 && (
            <PopoverRoot
              open={overflowOpen && compactPages}
              onOpenChange={setOverflowOpen}
            >
              <PopoverTrigger
                render={
                  <IconButton
                    ref={overflowTrigger}
                    data-shell-pages-overflow=""
                    aria-label="More pages"
                    title="More pages"
                    variant="ghost"
                    icon={<DotsThreeIcon size={16} aria-hidden="true" />}
                  />
                }
              />
              <PopoverPopup
                size="compact"
                padding="list"
                align="end"
                aria-label="More pages"
                finalFocus={() =>
                  compactPages
                    ? overflowTrigger.current
                    : ((
                        topbarRef.current ?? toolbarRef.current
                      )?.querySelector<HTMLButtonElement>("button") ??
                      document.getElementById("main-content"))
                }
              >
                <nav
                  ref={overflowPages}
                  aria-label="Header pages"
                  className="shell-pages"
                >
                  <PageNavigation
                    pages={headerPages}
                    selected={selectedHeader}
                    currentPage={selected}
                    onSelect={(key) => {
                      setOverflowOpen(false);
                      onSelect(key);
                    }}
                  />
                </nav>
              </PopoverPopup>
            </PopoverRoot>
          )}
          <div ref={actionsRef} className="shell-actions-fixed">
            {launchers}
            <PageSearch
              pages={pages}
              onSelect={onSelect}
              services={searchServices}
            />
            <ProfileButton
              communities={communities}
              accountActions={accountActions}
              settingsSelected={selected === "settings"}
              onSettings={() => onSelect("settings")}
              onProfile={onProfile}
            />
            <WindowControls />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <CommunityRail
          communities={communities}
          invite={invite}
          onInviteClose={onInviteClose}
          settingsCards={settingsCards}
          onSelect={onCommunitySelect}
          onOpenTarget={onOpenTarget}
        />
        <div
          className={`shell-body ${selected === "settings" ? "shell-body-settings" : ""}`}
        >
          <div className="shell-content">
            <div
              id="shell-navigation"
              className="shell-navigation"
              data-sidebar-collapsible={
                (collapsibleSidebar && !narrow) || undefined
              }
              data-sidebar-open={visibleSidebar || undefined}
              aria-hidden={(collapsibleSidebar || narrow) && !visibleSidebar}
              inert={(collapsibleSidebar || narrow) && !visibleSidebar}
              data-expanded={navigationOpen}
              onKeyDown={(event) => {
                if (
                  event.key === "Escape" &&
                  navigationOpen &&
                  !event.defaultPrevented
                ) {
                  setNavigationOpen(false);
                  navigationToggle.current?.focus();
                }
              }}
            >
              <div className="shell-navigation-content">{navigation}</div>
            </div>
            <main
              id="main-content"
              tabIndex={-1}
              className="min-h-0 min-w-0 flex-1"
            >
              <Panel as="div" joined>
                <PanelFrame companion={companion}>
                  <div
                    id={`shell-page-${panelKey}`}
                    {...(!compactPages && selectedTopbarPage
                      ? {
                          role: "tabpanel",
                          "aria-labelledby": `shell-page-${panelKey}-tab`,
                          tabIndex: 0,
                          "data-focus-inset": "",
                        }
                      : {})}
                    className={
                      fillsWorkspace
                        ? "buzz-tabs-panel h-full min-h-0"
                        : "buzz-tabs-panel h-full min-h-0 overflow-y-auto px-2 pt-10 pb-8 sm:px-4 sm:pt-14 sm:pb-10"
                    }
                  >
                    <div
                      className={
                        fillsWorkspace
                          ? "h-full min-h-0"
                          : "mx-auto w-full max-w-4xl"
                      }
                    >
                      {children}
                    </div>
                  </div>
                </PanelFrame>
              </Panel>
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
