/** A conversation comment or submitted review the PR Discussion tab can reveal. */
export type GitHubAnchor = Readonly<{
  kind: "discussion" | "review";
  id: string;
}>;
export type GitHubReference = Readonly<{
  /** Hash-less identity: an anchor changes what is revealed, not which object. */
  url: string;
  repository: string;
  kind: "repository" | "pull" | "issue" | "commit";
  label: string;
  anchor?: GitHubAnchor | undefined;
}>;
const fragmentKinds = {
  issuecomment: "discussion",
  pullrequestreview: "review",
} as const;
/**
 * Fragments the pane can show. The PR Discussion tab lists conversation
 * comments and submitted reviews; review-thread (`discussion_r…`), timeline
 * event and other anchors fall through to the browser instead of opening a
 * pane that cannot show them. Issues render only their body, so no fragment
 * qualifies.
 */
function parseGitHubAnchor(hash: string): GitHubAnchor | undefined {
  const match = /^#(issuecomment|pullrequestreview)-(\d+)$/.exec(hash);
  const fragment = match?.[1] as keyof typeof fragmentKinds | undefined;
  const id = match?.[2];
  return fragment && id ? { kind: fragmentKinds[fragment], id } : undefined;
}
export function gitHubAnchorUrl(url: string, anchor: GitHubAnchor) {
  const fragment =
    anchor.kind === "review" ? "pullrequestreview" : "issuecomment";
  return `${url}#${fragment}-${anchor.id}`;
}
/** Exact host parsing: a lookalike domain or credentials can never become a GitHub card. */
export function parseGitHubReference(
  value: string,
): GitHubReference | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password
    )
      return;
    const parts = url.pathname.split("/").filter(Boolean);
    const [owner, repo, surface, ...rest] = parts;
    if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo))
      return;
    const repository = `${owner}/${repo}`;
    const base = `https://github.com/${repository}`;
    if (!surface)
      return { url: base, repository, kind: "repository", label: repo };
    const target = rest.join("/");
    if (
      (surface === "pull" || surface === "issues") &&
      rest.length === 1 &&
      /^[1-9]\d*$/.test(target)
    ) {
      const anchor = parseGitHubAnchor(url.hash);
      if (url.hash && (surface === "issues" || !anchor)) return;
      return {
        url: `${base}/${surface}/${target}`,
        repository,
        kind: surface === "pull" ? "pull" : "issue",
        label: `#${target}`,
        anchor,
      };
    }
    if (
      surface === "commit" &&
      rest.length === 1 &&
      /^[a-f0-9]{7,40}$/i.test(target)
    )
      return {
        url: `${base}/commit/${target}`,
        repository,
        kind: "commit",
        label: target.slice(0, 7),
      };
  } catch {
    /* Authored prose is not necessarily a URL. */
  }
}
