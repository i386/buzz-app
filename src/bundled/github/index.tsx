import { Button } from "../../shared/design-system/ui/Button";
import { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowSquareOutIcon,
  GitPullRequestIcon,
  CircleDashedIcon,
  XCircleIcon,
  GitMergeIcon,
  GitHubIssueIcon,
  GitCommitIcon,
  FolderSimpleIcon,
} from "../../shared/design-system/icons/index";
import type { PluginModule } from "../../plugins/api";
import type { PanelProps } from "../../features/panels/service";
import {
  gitHubAnchorUrl,
  parseGitHubReference,
  type GitHubAnchor,
  type GitHubReference,
} from "./references";
import { loadGitHubDetails, type GitHubDetails } from "./data";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { GitHubChecks } from "./GitHubChecks";
import styles from "./GitHub.module.css";
import inlineStyles from "../../shared/InlineReference.module.css";
import { GitHubBody } from "./GitHubBody";
import { GitHubConversation } from "./GitHubConversation";
import { relativeTimestamp } from "../../shared/relative-timestamp";

export const inject = ["panels"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.panels.register({
    id: "object",
    title: "GitHub",
    matches: (target) => !!parseGitHubReference(target),
    component: GitHubPanel,
  });
};
const labels = {
  repository: "Repository",
  pull: "Pull request",
  issue: "Issue",
  commit: "Commit",
};
const icons = {
  repository: FolderSimpleIcon,
  pull: GitPullRequestIcon,
  issue: GitHubIssueIcon,
  commit: GitCommitIcon,
};

const stateIcons = {
  open: GitPullRequestIcon,
  draft: CircleDashedIcon,
  closed: XCircleIcon,
  merged: GitMergeIcon,
};

export function GitHubPanel({ target }: PanelProps) {
  const [attempt, retry] = useState(0);
  const parsed = useMemo(() => parseGitHubReference(target), [target]);
  const identity = parsed?.url;
  // An anchor-only target change keeps the object's reference, request and
  // loaded content; only the revealed comment moves.
  const reference = useMemo(
    () => (identity ? parseGitHubReference(identity) : undefined),
    [identity],
  );
  return reference ? (
    <ObjectPanel
      key={`${reference.url}:${attempt}`}
      reference={reference}
      anchor={parsed?.anchor}
      retry={() => retry(attempt + 1)}
    />
  ) : (
    <p className="notice">Unsupported GitHub link.</p>
  );
}

function ObjectPanel({
  reference,
  anchor,
  retry,
}: {
  reference: GitHubReference;
  anchor: GitHubAnchor | undefined;
  retry(): void;
}) {
  const [result, setResult] = useState<GitHubDetails | string>();
  const link = anchor ? gitHubAnchorUrl(reference.url, anchor) : reference.url;
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    void loadGitHubDetails(
      reference,
      AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    )
      .then((details) => {
        if (!controller.signal.aborted) setResult(details);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [reference]);
  const Icon = icons[reference.kind];
  const state = typeof result === "object" ? result.state.toLowerCase() : "";
  const StateIcon =
    reference.kind === "pull" && Object.hasOwn(stateIcons, state)
      ? stateIcons[state as keyof typeof stateIcons]
      : undefined;
  const [owner, repositoryName] = reference.repository.split("/");
  const title = (
    <h2 className={reference.kind === "pull" ? styles.pullTitle : undefined}>
      {reference.kind === "pull" ? (
        <a
          className={`${inlineStyles.link} ${styles.titleLink}`}
          href={link}
          target="_blank"
          rel="noreferrer"
        >
          {typeof result === "object" ? result.title : labels.pull}{" "}
          <span className={styles.titleNumber}>{reference.label}</span>
        </a>
      ) : (
        typeof result === "object" && result.title
      )}
    </h2>
  );
  return (
    <div className={styles.root}>
      <div className={styles.identity}>
        <span className={styles.icon}>
          <Icon size={22} aria-hidden="true" />
        </span>
        <div>
          {reference.kind === "pull" ? (
            <>
              <div className={styles.repository}>
                <a
                  className={inlineStyles.link}
                  href={`https://github.com/${owner}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {owner}
                </a>
                <span className={styles.repositorySeparator}> / </span>
                <a
                  className={inlineStyles.link}
                  href={`https://github.com/${reference.repository}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {repositoryName}
                </a>
              </div>
              <small>{labels[reference.kind]}</small>
            </>
          ) : (
            <>
              <small>{reference.repository}</small>
              <strong>
                {labels[reference.kind]} {reference.label}
              </strong>
            </>
          )}
        </div>
      </div>
      {reference.kind !== "pull" && (
        <a
          className={styles.external}
          href={reference.url}
          target="_blank"
          rel="noreferrer"
        >
          Open on GitHub <ArrowSquareOutIcon size={14} />
        </a>
      )}
      {reference.kind === "pull" && typeof result !== "object" && title}
      {result === undefined ? (
        <p role="status">Loading from GitHub…</p>
      ) : typeof result === "string" ? (
        <div role="alert">
          <p>{result}</p>
          <div className={styles.errorActions}>
            <Button
              variant="prominent"
              nativeButton={false}
              role="link"
              render={
                <a
                  className={styles.errorExternal}
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              <span className={styles.errorActionLabel}>Open on Github</span>
            </Button>
            <Button type="button" onClick={retry}>
              Retry
            </Button>
          </div>
        </div>
      ) : (
        <>
          {reference.kind === "pull" && title}
          <div className={styles.byline}>
            {result.state && (
              <span
                className={styles.state}
                data-pr-state={
                  reference.kind === "pull"
                    ? result.state.toLowerCase()
                    : undefined
                }
              >
                {StateIcon && <StateIcon size={12} aria-hidden="true" />}
                {result.state}
              </span>
            )}
            {result.author && (
              <span>
                by{" "}
                {result.authorUrl ? (
                  <a
                    className={inlineStyles.link}
                    href={result.authorUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {result.author}
                  </a>
                ) : (
                  result.author
                )}
              </span>
            )}
          </div>
          {reference.kind !== "pull" && title}
          {(!!result.facts.length || reference.kind === "pull") && (
            <dl className={styles.facts}>
              {result.facts.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {typeof value !== "object" ? (
                      value
                    ) : "head" in value ? (
                      <>
                        {value.head.url ? (
                          <a
                            className={styles.branch}
                            href={value.head.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {value.head.label}
                          </a>
                        ) : (
                          <span className={styles.branchLabel}>
                            {value.head.label}
                          </span>
                        )}
                        {" → "}
                        {value.base.url ? (
                          <a
                            className={styles.branch}
                            href={value.base.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {value.base.label}
                          </a>
                        ) : (
                          <span className={styles.branchLabel}>
                            {value.base.label}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <span className={styles.additions}>
                          +{value.additions}
                        </span>
                        {" / "}
                        <span className={styles.deletions}>
                          −{value.deletions}
                        </span>
                      </>
                    )}
                  </dd>
                </div>
              ))}
              {reference.kind === "pull" && (
                <div>
                  <dt>Last updated</dt>
                  <dd>
                    {result.updatedAt ? (
                      <time
                        dateTime={result.updatedAt}
                        title={new Date(result.updatedAt).toLocaleString()}
                      >
                        {relativeTimestamp(Date.parse(result.updatedAt) / 1000)}
                      </time>
                    ) : (
                      "Unavailable"
                    )}
                  </dd>
                </div>
              )}
            </dl>
          )}
          {reference.kind === "pull" ? (
            <PullContent
              details={result}
              reference={reference}
              anchor={anchor}
            />
          ) : (
            result.body && (
              <GitHubBody
                body={result.body}
                bodyHtml={result.bodyHtml}
                url={reference.url}
              />
            )
          )}
        </>
      )}
      <p className={styles.note}>
        Public GitHub data · Open on GitHub for private repositories and
        actions.
      </p>
    </div>
  );
}

function PullContent({
  details,
  reference,
  anchor,
}: {
  details: GitHubDetails;
  reference: GitHubReference;
  anchor: GitHubAnchor | undefined;
}) {
  const id = useId();
  const [tab, setTab] = useState<"discussion" | "checks">("discussion");
  const [checksOpened, setChecksOpened] = useState(false);
  // A newly linked comment lives in Discussion, whichever tab was showing.
  useEffect(() => {
    if (anchor) setTab("discussion");
  }, [anchor]);
  return (
    <>
      <div className={styles.pullTabs}>
        <Tabs
          variant="panel"
          label="Pull request content"
          value={tab}
          items={[
            {
              value: "discussion",
              label: "Discussion",
              panelId: `${id}-discussion`,
            },
            { value: "checks", label: "Checks", panelId: `${id}-checks` },
          ]}
          onValueChange={(next) => {
            setTab(next);
            if (next === "checks") setChecksOpened(true);
          }}
        />
      </div>
      {/* Retain loaded content and disclosures across tab switches, but mount checks only on demand. */}
      <div
        role="tabpanel"
        id={`${id}-discussion`}
        aria-labelledby={`${id}-discussion-tab`}
        hidden={tab !== "discussion"}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: tab panels are keyboard destinations linked by the shared tabs.
        tabIndex={0}
      >
        <GitHubConversation
          details={details}
          url={reference.url}
          anchor={anchor}
        />
      </div>
      <div
        role="tabpanel"
        id={`${id}-checks`}
        aria-labelledby={`${id}-checks-tab`}
        hidden={tab !== "checks"}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: tab panels are keyboard destinations linked by the shared tabs.
        tabIndex={0}
      >
        {checksOpened && (
          <GitHubChecks
            repository={reference.repository}
            sha={details.headSha}
          />
        )}
      </div>
    </>
  );
}
