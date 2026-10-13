import { Collapsible } from "@base-ui/react/collapsible";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  usePresenceData,
  useReducedMotion,
} from "motion/react";
import {
  useId,
  useCallback,
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import {
  conversationEvents,
  groupConversationEvents,
  useConversationSource,
  type ConversationEvent,
  type EventRun,
} from "./conversation";
import { MediaAttachment } from "../../features/messages/MediaAttachment";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  CaretDownIcon,
  CaretUpIcon,
  DotsThreeIcon,
  LinkIcon,
  GitMergeIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  XCircleIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { GitHubBody } from "./GitHubBody";
import type { GitHubDetails } from "./data";
import { gitHubAnchorUrl, type GitHubAnchor } from "./references";
import { bodyPreview, isTextBody } from "./preview";
import styles from "./GitHub.module.css";
import inlineStyles from "../../shared/InlineReference.module.css";

export type ConversationMessage = {
  author: string;
  authorUrl?: string | undefined;
  authorAvatar?: string | undefined;
  createdAt?: string | undefined;
  body: string;
  bodyHtml?: string | undefined;
};

function PostedTime({ value }: { value: string | undefined }) {
  return value ? (
    <time dateTime={value} title={new Date(value).toLocaleString()}>
      {relativeTimestamp(Date.parse(value) / 1000)}
    </time>
  ) : (
    <span>Time unavailable</span>
  );
}

function Author({ message }: { message: ConversationMessage }) {
  return (
    <span className={styles.messageAuthor}>
      {message.authorUrl ? (
        <a
          className={inlineStyles.link}
          href={message.authorUrl}
          target="_blank"
          rel="noreferrer"
        >
          {message.author || "Unknown author"}
        </a>
      ) : (
        message.author || "Unknown author"
      )}
    </span>
  );
}

function Thumbnails({ images, label }: { images: string[]; label: string }) {
  const row = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(images.length);
  useLayoutEffect(() => {
    const element = row.current;
    const tile = element?.firstElementChild;
    if (
      !element ||
      !(tile instanceof HTMLElement) ||
      typeof ResizeObserver === "undefined"
    )
      return;
    const update = () => {
      if (!element.clientWidth) return; // A hidden open-message row keeps its last capacity.
      const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
      const width = tile.getBoundingClientRect().width;
      if (width > 0)
        setCapacity(
          Math.max(1, Math.floor((element.clientWidth + gap) / (width + gap))),
        );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(tile);
    update();
    return () => observer.disconnect();
  }, []);
  const visible = images.slice(0, capacity);
  const hidden = images.length - visible.length;
  return (
    <div className={styles.thumbnails} ref={row}>
      {visible.map((src, index) => (
        <div className={styles.thumbnail} key={src}>
          <MediaAttachment
            attachment={{
              url: src,
              kind: "image",
              dimensions: { width: 1, height: 1 },
            }}
            media={(source) => source}
            imageDescription={`Image ${index + 1} in ${label}`}
          />
          {index === visible.length - 1 && hidden > 0 && (
            <span className={styles.thumbnailCount}>+{hidden}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function CommentActions({
  url,
  showCopyAction,
  children,
}: {
  url: string | undefined;
  showCopyAction: boolean;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<"button" | "context">();
  const [anchor, setAnchor] = useState<HTMLElement>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const [copying, setCopying] = useState(false);
  const busy = useRef(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  async function copy() {
    if (!url || busy.current) return;
    busy.current = true;
    setCopying(true);
    setNotice(undefined);
    try {
      await navigator.clipboard.writeText(url);
      setNotice({ text: "Comment link copied", error: false });
    } catch {
      setNotice({
        text: "Couldn’t copy the link. Try again from the comment actions.",
        error: true,
      });
    } finally {
      busy.current = false;
      setCopying(false);
    }
  }
  if (!url) return <div className={styles.messageContent}>{children}</div>;
  const item = (
    <MenuItem disabled={copying} onClick={() => void copy()}>
      <MenuIcon>
        <LinkIcon />
      </MenuIcon>
      Copy link
    </MenuItem>
  );
  return (
    <ContextMenuRoot
      open={menu === "context"}
      onOpenChange={(open) =>
        setMenu((current) =>
          open ? "context" : current === "context" ? undefined : current,
        )
      }
    >
      <ContextMenuTrigger
        render={<div className={styles.messageContent} />}
        onContextMenu={() => {
          setAnchor(undefined);
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onTouchStart={() => {
          setAnchor(undefined);
          returnFocus.current = null;
        }}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            returnFocus.current = event.target as HTMLElement;
            setAnchor(event.currentTarget);
            setMenu("context");
          }
        }}
      >
        {children}
        <div
          className={styles.commentActions}
          data-menu-action={!showCopyAction || undefined}
          data-menu-open={!!menu || undefined}
        >
          {showCopyAction ? (
            <Button
              variant="subtle"
              size="xs"
              loading={copying}
              onClick={() => void copy()}
            >
              <LinkIcon size={14} aria-hidden="true" />
              Copy link
            </Button>
          ) : (
            <MenuRoot
              open={menu === "button"}
              onOpenChange={(open) =>
                setMenu((current) =>
                  open ? "button" : current === "button" ? undefined : current,
                )
              }
            >
              <MenuTrigger
                render={
                  <IconButton
                    aria-label="Comment actions"
                    size="xs"
                    icon={<DotsThreeIcon />}
                  />
                }
              />
              <MenuPopup align="end">{item}</MenuPopup>
            </MenuRoot>
          )}
        </div>
      </ContextMenuTrigger>
      <MenuPopup
        anchor={anchor}
        finalFocus={() =>
          returnFocus.current?.isConnected ? returnFocus.current : false
        }
      >
        {item}
      </MenuPopup>
      {notice && (
        <ToastNotice
          title={notice.text}
          tone={notice.error ? "error" : "success"}
          timeout={notice.error ? 0 : 4000}
          onDismiss={() => setNotice(undefined)}
        />
      )}
    </ContextMenuRoot>
  );
}

function Message({
  message,
  url,
  commentUrl,
  label,
  kind = "comment",
  reviewState,
  fallback = "No message provided",
  eventKey,
  anchored = false,
}: {
  message: ConversationMessage;
  url: string;
  commentUrl?: string | undefined;
  label: string;
  kind?: "description" | "review" | "comment" | "merge";
  reviewState?: string | undefined;
  fallback?: string;
  eventKey?: string | undefined;
  /** The linked comment: read in full, focusable and painted as the anchor. */
  anchored?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (anchored) setOpen(true);
  }, [anchored]);
  const preview = useMemo(
    () => bodyPreview(message.body, message.bodyHtml, url),
    [message.body, message.bodyHtml, url],
  );
  const header = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fitsOnOneLine, setFitsOnOneLine] = useState(false);
  const textBody = useMemo(
    () => isTextBody(message.body, message.bodyHtml, url),
    [message.body, message.bodyHtml, url],
  );
  const hasBody = !!message.body.trim() || !!fallback;
  const canFitOnOneLine = textBody && !preview.images.length;
  useLayoutEffect(() => {
    const content = header.current;
    const probe = measure.current;
    if (
      !content ||
      !probe ||
      !canFitOnOneLine ||
      !hasBody ||
      typeof ResizeObserver === "undefined"
    )
      return;
    const update = () => {
      const lines: DOMRect[] = [];
      const walker = document.createTreeWalker(
        probe,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          lines.push(
            ...Array.from(range.getClientRects()).filter(
              (rect) => rect.width > 0,
            ),
          );
        } else if (node instanceof HTMLBRElement) {
          const range = document.createRange();
          range.selectNode(node);
          lines.push(...range.getClientRects());
        }
      }
      // Inline formatting has different glyph boxes; boxes on one line still overlap vertically.
      setFitsOnOneLine(
        content.clientWidth > 0 &&
          lines.length > 0 &&
          Math.max(...lines.map((line) => line.top)) <
            Math.min(...lines.map((line) => line.bottom)),
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(content);
    observer.observe(probe);
    update();
    return () => observer.disconnect();
  }, [canFitOnOneLine, hasBody]);
  const expandable = !canFitOnOneLine || (hasBody && !fitsOnOneLine);
  const MarkerIcon =
    kind === "merge"
      ? GitMergeIcon
      : kind === "review"
        ? reviewState === "APPROVED"
          ? CheckCircleIcon
          : reviewState === "CHANGES_REQUESTED"
            ? XCircleIcon
            : reviewState === "DISMISSED"
              ? XIcon
              : ChatCircleIcon
        : ChatCircleIcon;
  const marker =
    kind === "description" ? (
      <Avatar src={message.authorAvatar} alt="" fallback={message.author} />
    ) : (
      <span
        className={styles.eventIcon}
        data-review-state={kind === "review" ? reviewState : undefined}
        data-merged={kind === "merge" || undefined}
      >
        <MarkerIcon size={20} aria-hidden="true" />
      </span>
    );
  return (
    <Collapsible.Root
      className={styles.conversationMessage}
      data-buzz-ui=""
      role="group"
      aria-label={label}
      open={open}
      onOpenChange={setOpen}
      data-bodyless={!hasBody || undefined}
      data-single-line={(hasBody && !expandable) || undefined}
      data-event-key={eventKey}
      data-anchored={anchored || undefined}
      tabIndex={anchored ? -1 : undefined}
    >
      <div className={styles.messageMarker}>
        {expandable ? (
          <Collapsible.Trigger
            render={
              <IconButton
                variant="avatar"
                size="sm"
                aria-label={`Toggle ${label}`}
                icon={marker}
              />
            }
          />
        ) : (
          <span aria-hidden="true">{marker}</span>
        )}
      </div>
      <CommentActions
        url={commentUrl}
        showCopyAction={hasBody && expandable && open}
      >
        <div className={styles.messageHeader} ref={header}>
          {canFitOnOneLine && hasBody && (
            <div className={styles.messageMeasure} aria-hidden="true" inert>
              <div
                ref={measure}
                className={`text-body-sm ${styles.messageMeasureText}`}
              >
                {message.body ? (
                  <GitHubBody
                    body={message.body}
                    bodyHtml={message.bodyHtml}
                    url={url}
                  />
                ) : (
                  fallback
                )}
              </div>
            </div>
          )}
          {expandable && (
            <Collapsible.Trigger
              className={`buzz-accordion-trigger text-body-sm ${styles.messageTrigger}`}
              aria-label={`Expand ${label}`}
              title={
                message.createdAt
                  ? new Date(message.createdAt).toLocaleString()
                  : undefined
              }
            >
              <CaretDownIcon size={14} aria-hidden="true" />
            </Collapsible.Trigger>
          )}
          <div className={styles.messageMetadata}>
            <Author message={message} />
            <span
              className={styles.messageLabel}
              title={
                kind === "review"
                  ? "Submitted review event, not the PR’s current approval status"
                  : undefined
              }
            >
              {label}
            </span>
            <span className={styles.messageTime}>
              <PostedTime value={message.createdAt} />
            </span>
          </div>
          {expandable ? (
            <span className={`text-body-sm ${styles.previewText}`}>
              {preview.text || fallback}
            </span>
          ) : hasBody ? (
            <div className={`text-body-sm ${styles.messageBody}`}>
              {message.body ? (
                <GitHubBody
                  body={message.body}
                  bodyHtml={message.bodyHtml}
                  url={url}
                />
              ) : (
                <p>{fallback}</p>
              )}
            </div>
          ) : null}
        </div>
        {!!preview.images.length && (
          <Thumbnails images={preview.images} label={label} />
        )}
        {expandable && (
          <Collapsible.Panel className={`text-body-sm ${styles.messageBody}`}>
            {message.body ? (
              <GitHubBody
                body={message.body}
                bodyHtml={message.bodyHtml}
                url={url}
              />
            ) : (
              <p>{fallback}</p>
            )}
          </Collapsible.Panel>
        )}
      </CommentActions>
    </Collapsible.Root>
  );
}

const reviewLabels: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  COMMENTED: "Review comment",
  DISMISSED: "Review dismissed",
};

function EventMessage({
  event,
  url,
  anchorKey,
}: {
  event: ConversationEvent;
  url: string;
  anchorKey: string | undefined;
}) {
  return (
    <Message
      message={event.message}
      url={url}
      commentUrl={
        event.kind === "merge"
          ? undefined
          : gitHubAnchorUrl(url, {
              kind: event.kind,
              id: String(event.message.id),
            })
      }
      eventKey={event.key}
      anchored={event.key === anchorKey}
      label={
        event.kind === "merge"
          ? "Merged"
          : event.kind === "review"
            ? (reviewLabels[event.message.state ?? ""] ?? "Reviewed")
            : "Comment"
      }
      kind={event.kind === "discussion" ? "comment" : event.kind}
      reviewState={event.message.state}
      fallback={event.kind === "discussion" ? "No message provided" : ""}
    />
  );
}

function HistoryEvents({
  run,
  url,
  id,
  anchorKey,
}: {
  run: EventRun;
  url: string;
  id: string;
  anchorKey: string | undefined;
}) {
  const present = useIsPresent();
  const instant = usePresenceData() === true;
  return (
    <motion.div
      id={id}
      className={styles.historyReveal}
      inert={!present}
      aria-hidden={!present || undefined}
      initial={instant ? false : { height: 0, opacity: 0, overflow: "hidden" }}
      animate={{
        height: "auto",
        opacity: 1,
        overflow: "visible",
      }}
      exit={{ height: 0, opacity: 0, overflow: "hidden" }}
      transition={{
        duration: instant ? 0 : present ? 0.2 : 0.14,
        ease: [0.23, 1, 0.32, 1],
      }}
    >
      <div className={styles.commentRunEvents}>
        {run.events.map((event) => (
          <EventMessage
            key={event.key}
            event={event}
            url={url}
            anchorKey={anchorKey}
          />
        ))}
      </div>
    </motion.div>
  );
}

function History({
  run,
  url,
  anchorKey,
}: {
  run: EventRun;
  url: string;
  anchorKey: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const reduceMotion = useReducedMotion();
  const id = useId();
  const anchored = run.events.some((event) => event.key === anchorKey);
  // The linked comment's run opens in place so the reveal can scroll to a settled row.
  useLayoutEffect(() => {
    if (!anchored) return;
    setOpen(true);
    setInstant(true);
  }, [anchored]);
  const label = run.events.length === 1 ? "message" : "messages";
  const summary = run.afterMerge
    ? `${run.events.length} ${label} after merge`
    : `${run.events.length} earlier ${label}`;
  const hideLabel = run.afterMerge
    ? "Hide messages after merge"
    : "Hide earlier messages";
  const authors = [
    ...new Set(
      run.events.map((event) => event.message.author || "Unknown author"),
    ),
  ].join(", ");
  return (
    <Collapsible.Root
      className={styles.commentRun}
      data-buzz-ui=""
      open={open}
      onOpenChange={setOpen}
    >
      <Collapsible.Trigger
        className={`buzz-accordion-trigger text-body-sm ${styles.commentRunTrigger}`}
        aria-label={`${open ? "Hide" : "Show"} ${summary}`}
        aria-controls={open ? id : undefined}
        onClick={(event) => setInstant(event.detail === 0)}
      >
        <span className={styles.eventIcon} aria-hidden="true">
          {open ? <CaretUpIcon size={20} /> : <DotsThreeIcon size={20} />}
        </span>
        <span className={styles.commentRunSummary}>
          {open ? (
            <span>{hideLabel}</span>
          ) : (
            <>
              {summary} <span>· {authors}</span>
            </>
          )}
        </span>
      </Collapsible.Trigger>
      <AnimatePresence initial={false} custom={!!reduceMotion || instant}>
        {open && (
          <HistoryEvents
            key="events"
            run={run}
            url={url}
            id={id}
            anchorKey={anchorKey}
          />
        )}
      </AnimatePresence>
    </Collapsible.Root>
  );
}

function SourceStatus({
  label,
  source,
  conversation,
}: {
  label: string;
  source: ReturnType<typeof useConversationSource>;
  conversation: RefObject<HTMLElement | null>;
}) {
  const actionRef = useCallback(
    (action: HTMLElement | null) => {
      if (!action) return;
      // Ref cleanup runs before removal, while the focused control still exists.
      return () => {
        if (
          document.activeElement === action &&
          conversation.current?.isConnected
        )
          conversation.current.focus({ preventScroll: true });
      };
    },
    [conversation],
  );
  if (!source.loading && !source.error && !source.next) return null;
  return (
    <section className={styles.sourceStatus} aria-label={label}>
      <span>
        {label} · {source.entries.length} loaded
      </span>
      {source.loading ? (
        <span role="status">Loading {label.toLowerCase()}…</span>
      ) : source.error ? (
        <span role="alert">{source.error}</span>
      ) : null}
      {(source.error || source.next) && (
        <Button
          ref={actionRef}
          size="xs"
          loading={source.loading}
          onClick={source.error ? source.retry : source.loadMore}
        >
          {source.error ? "Retry" : "Load more"} {label.toLowerCase()}
        </Button>
      )}
    </section>
  );
}

/** One reveal per linked comment: scroll to and focus its row once it mounts. */
function useAnchorReveal(
  conversation: RefObject<HTMLElement | null>,
  key: string | undefined,
) {
  useLayoutEffect(() => {
    const container = conversation.current;
    if (!key || !container) return;
    let frame = 0;
    const reveal = () => {
      const row = [
        ...container.querySelectorAll<HTMLElement>("[data-event-key]"),
      ].find((element) => element.dataset.eventKey === key);
      if (!row) return; // A folded run mounts its rows after opening; observe the mount.
      observer.disconnect();
      row.scrollIntoView({ block: "start", behavior: "instant" });
      row.focus({ preventScroll: true });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reveal);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(container, { childList: true, subtree: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [conversation, key]);
}

function Conversation({
  details,
  url,
  anchor,
}: {
  details: GitHubDetails;
  url: string;
  anchor?: GitHubAnchor | undefined;
}) {
  const conversation = useRef<HTMLElement>(null);
  const discussion = useConversationSource(url, "discussion");
  const reviews = useConversationSource(url, "reviews");
  const events = useMemo(
    () => conversationEvents(discussion.entries, reviews.entries, details),
    [discussion.entries, reviews.entries, details],
  );
  const incomplete = [discussion, reviews].some(
    (source) => source.loading || source.error || source.next,
  );
  const anchorKey = anchor && `${anchor.kind}-${anchor.id}`;
  const anchored = events.some((event) => event.key === anchorKey);
  // Later pages or an omitted empty review may hold the linked comment; the
  // notice offers GitHub once its own source has answered.
  const missing =
    anchor &&
    !anchored &&
    !(anchor.kind === "review" ? reviews : discussion).loading;
  useAnchorReveal(conversation, anchored ? anchorKey : undefined);
  return (
    <section
      className={styles.conversation}
      aria-label="Pull request conversation"
      ref={conversation}
      tabIndex={-1}
    >
      {missing && (
        <p className={styles.conversationNotice} role="status">
          The linked comment isn’t in the loaded conversation.{" "}
          <a
            className={inlineStyles.link}
            href={gitHubAnchorUrl(url, anchor)}
            target="_blank"
            rel="noreferrer"
          >
            Open it on GitHub
          </a>
        </p>
      )}
      <div
        className={styles.conversationTimeline}
        data-has-events={!!events.length || undefined}
      >
        <Message
          message={details}
          url={url}
          label="Description"
          kind="description"
          fallback="No description provided"
        />
        {groupConversationEvents(events).map((event) =>
          event.kind === "history" ? (
            <History
              key={event.key}
              run={event}
              url={url}
              anchorKey={anchorKey}
            />
          ) : (
            <EventMessage
              key={event.key}
              event={event}
              url={url}
              anchorKey={anchorKey}
            />
          ),
        )}
      </div>
      {incomplete && (
        <div className={styles.conversationSources}>
          <p className={styles.conversationNotice}>
            Loaded conversation only · some sources are incomplete.
          </p>
          <SourceStatus
            label="Discussion"
            source={discussion}
            conversation={conversation}
          />
          <SourceStatus
            label="Reviews"
            source={reviews}
            conversation={conversation}
          />
        </div>
      )}
    </section>
  );
}

export function GitHubConversation(props: {
  details: GitHubDetails;
  url: string;
  anchor?: GitHubAnchor | undefined;
}) {
  return <Conversation key={props.url} {...props} />;
}
