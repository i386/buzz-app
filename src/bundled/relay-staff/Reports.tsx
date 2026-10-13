import { useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { Select } from "../../shared/design-system/ui/Select";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import {
  ArrowLeftIcon,
  CircleNotchIcon,
} from "../../shared/design-system/icons";
import type {
  ActionRecordDto,
  ReportAction,
  ReportDetailDto,
  ReportDto,
  ReportResolution,
  StaffRequest,
} from "../../features/relay-staff/contract";
import {
  NamesSource,
  Person,
  PeopleScope,
  PersonName,
  usePeople,
} from "./people";
import { describe, useWrite, useRead, useSession } from "./session";
import {
  CommunityBadge,
  containsSecretKey,
  GroupedList,
  listButton,
  Loaded,
  NotConnected,
  Row,
  time,
} from "./ui";

const LABELS: Record<ReportAction, string> = {
  delete: "Delete",
  kick: "Kick",
  ban: "Ban",
  timeout: "Timeout",
  dismiss: "Dismiss",
  escalate: "Escalate",
};

export const SECRET_REASON =
  "That looks like a private key. Never paste it here.";

/** Where a reason is delivered, so staff know who reads it. */
export function reasonAudience(action: ReportAction) {
  if (action === "delete")
    return "Sent verbatim to the affected user and posted publicly in the room.";
  if (action === "dismiss" || action === "escalate")
    return "Sent verbatim to the reporter.";
  return "Sent verbatim to the affected user.";
}

/** Kick needs the report's channel; a blob can only be dismissed or escalated. */
function allowedActions(report: ReportDto): ReportAction[] {
  switch (report.targetKind.toLowerCase()) {
    case "event":
      return ["delete", "kick", "ban", "timeout", "dismiss", "escalate"].filter(
        (action) => action !== "kick" || report.channelId != null,
      ) as ReportAction[];
    case "pubkey":
      return ["ban", "timeout", "dismiss", "escalate"];
    default:
      return ["dismiss", "escalate"];
  }
}

function resolutionLabel(resolution: ReportResolution) {
  if (resolution.activeAction) return LABELS[resolution.activeAction.action];
  if (resolution.status === "dismissed") return LABELS.dismiss;
  if (resolution.status === "escalated") return LABELS.escalate;
  return resolution.status;
}

function Target({ report }: { report: ReportDto }) {
  const kind = report.targetKind.toLowerCase();
  if (kind === "event")
    return report.targetAuthorPubkey ? (
      <>
        message by <PersonName pubkey={report.targetAuthorPubkey} />
      </>
    ) : (
      <>message {report.target.slice(0, 12)}…</>
    );
  return kind === "pubkey" ? (
    <PersonName pubkey={report.target} />
  ) : (
    report.target
  );
}

/** The relay's maximum page; it returns no total and the list isn't paged. */
export const REPORT_LIMIT = 200;

const STATUSES = ["open", "processing", "resolved", "dismissed", "escalated"];

export function Reports({ communityId }: { communityId?: string }) {
  const { context } = useSession();
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [list, reload] = useRead(
    {
      route: "listReports",
      // The relay's default is escalated-only; the console works the whole queue.
      query: {
        scope: "all",
        limit: REPORT_LIMIT,
        ...(communityId ? { communityId } : {}),
        ...(status ? { status: status as ReportDto["status"] } : {}),
      },
    },
    [context, communityId, status],
  );
  const people = usePeople(
    list.state === "ok"
      ? list.value.flatMap((report) => [
          report.reporterPubkey,
          report.targetKind.toLowerCase() === "pubkey" ? report.target : null,
          report.targetAuthorPubkey,
        ])
      : [],
  );

  if (selected)
    return (
      <ReportDetail
        id={selected}
        onBack={() => {
          // Returning to the list shows fresh statuses.
          setSelected(null);
          reload();
        }}
        onChanged={reload}
      />
    );
  return (
    <div className="flex flex-col gap-3">
      <Select
        label="Status"
        variant="compact"
        value={status}
        groups={[
          {
            label: "",
            options: [
              { value: "", label: "All statuses" },
              ...STATUSES.map((value) => ({ value, label: value })),
            ],
          },
        ]}
        onValueChange={setStatus}
      />
      <Loaded read={list} onRetry={reload}>
        {(reports) =>
          reports.length === 0 ? (
            <p className="text-body-sm text-secondary">No reports found.</p>
          ) : (
            <PeopleScope people={people}>
              <NamesSource />
              <GroupedList
                items={reports}
                limit={REPORT_LIMIT}
                headings={!communityId}
                render={(report) => (
                  <li key={report.id}>
                    <button
                      type="button"
                      className={listButton}
                      onClick={() => setSelected(report.id)}
                    >
                      <span className="block font-medium">
                        {report.reportType || "Report"}
                      </span>
                      <span className="block truncate text-caption text-secondary">
                        reporter: <PersonName pubkey={report.reporterPubkey} />{" "}
                        · target: <Target report={report} />
                      </span>
                      <span className="flex items-center gap-1.5 text-caption text-secondary">
                        {report.status}
                        {report.status === "processing" && (
                          <CircleNotchIcon className="animate-spin" />
                        )}
                      </span>
                      <span className="block text-caption text-secondary">
                        {time(report.createdAt)}
                      </span>
                    </button>
                  </li>
                )}
              />
            </PeopleScope>
          )
        }
      </Loaded>
    </div>
  );
}

type ResolveRequest = Extract<StaffRequest, { route: "resolveReport" }>;
type ReopenRequest = Extract<StaffRequest, { route: "reopenReport" }>;
type CancelRequest = Extract<StaffRequest, { route: "cancelReport" }>;

function ReportDetail({
  id,
  onBack,
  onChanged,
}: {
  id: string;
  onBack(): void;
  onChanged(): void;
}) {
  const { context, canMutate } = useSession();
  const [detail, reload] = useRead({ route: "getReport", id }, [context, id]);
  const notify = useToastNotification();
  const changed = () => {
    reload();
    onChanged();
  };
  // The detail, not the action forms, handles finished writes: a form is
  // gone once its action changes the report's status.
  const resolve = useWrite<ResolveRequest>(`resolve ${id}`, (outcome) => {
    if (outcome.ok) {
      notify(`Report resolved: ${resolutionLabel(outcome.value)}`, "success");
      return changed();
    }
    notify(describe(outcome.failure), "error");
    // The relay records a failed enforcement before answering.
    if (outcome.failure.code === "enforcement_failed") changed();
  });
  useWrite<ReopenRequest>(`reopen ${id}`, (outcome) => {
    notify(
      outcome.ok ? "Report reopened" : describe(outcome.failure),
      outcome.ok ? "success" : "error",
    );
    if (outcome.ok) changed();
  });
  useWrite<CancelRequest>(`cancel ${id}`, (outcome) => {
    notify(
      outcome.ok
        ? "Enforcement cancelled. The report is open again."
        : `Cancel rejected: ${describe(outcome.failure)}`,
      outcome.ok ? "success" : "error",
    );
    changed();
  });
  // A held resolve whose report has moved on can only conflict: release it so
  // a reopened report offers a fresh choice. While processing, the relay still
  // replays the same request id, so the held write stays.
  const status = detail.state === "ok" ? detail.value.status : null;
  const { frozen, busy, discard } = resolve;
  useEffect(() => {
    if (
      frozen &&
      !busy &&
      status &&
      status !== "open" &&
      status !== "processing"
    )
      discard();
  }, [frozen, busy, status, discard]);
  return (
    <div className="flex flex-col gap-4">
      <Button size="sm" variant="ghost" onClick={onBack}>
        <ArrowLeftIcon /> Back to reports
      </Button>
      <Loaded read={detail} onRetry={reload}>
        {(report) => (
          <>
            <ReportFields report={report} />
            {report.activeAction && (
              <Enforcement reportId={report.id} action={report.activeAction} />
            )}
            {/* A reopened report may carry succeeded history and still be open. */}
            {canMutate && report.status === "open" && (
              <Resolve key={report.id} report={report} />
            )}
            {canMutate &&
              ["resolved", "dismissed", "escalated"].includes(
                report.status,
              ) && <Reopen report={report} />}
          </>
        )}
      </Loaded>
    </div>
  );
}

function ReportFields({ report }: { report: ReportDetailDto }) {
  const people = usePeople([
    report.reporterPubkey,
    report.targetKind.toLowerCase() === "pubkey" ? report.target : null,
    report.targetAuthorPubkey,
    report.resolvedBy,
    report.message?.authorPubkey,
  ]);
  return (
    <PeopleScope people={people}>
      <div className="flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
        <p className="mb-2 text-body-sm font-medium">
          {report.reportType} · {report.status}
        </p>
        <Row label="ID" mono>
          {report.id}
        </Row>
        <Row label="Community">
          <CommunityBadge id={report.communityId} host={report.communityHost} />
        </Row>
        <Row label="Event ID" mono>
          {report.reportEventId}
        </Row>
        <Row label="Reporter">
          <Person pubkey={report.reporterPubkey} />
        </Row>
        <Row label="Target kind">{report.targetKind}</Row>
        {report.targetKind.toLowerCase() === "pubkey" ? (
          <Row label="Target">
            <Person pubkey={report.target} />
          </Row>
        ) : (
          <Row label="Target" mono>
            {report.target}
          </Row>
        )}
        <Row label="Channel" mono>
          {report.channelId}
        </Row>
        <Row label="Note">{report.note}</Row>
        <Row label="Resolved by">
          {report.resolvedBy && <Person pubkey={report.resolvedBy} />}
        </Row>
        <Row label="Resolved at">{time(report.resolvedAt)}</Row>
        <Row label="Action ID" mono>
          {report.actionId}
        </Row>
        <Row label="Created">{time(report.createdAt)}</Row>
        {report.message && (
          <div className="mt-3 flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
            <p className="text-caption font-semibold text-secondary">
              Reported message
              {report.message.deletedAt && (
                <span className="ml-1.5 text-danger">(deleted)</span>
              )}
            </p>
            <Row label="Author">
              <Person pubkey={report.message.authorPubkey} />
            </Row>
            <Row label="Content">{report.message.content}</Row>
            <Row label="Sent">{time(report.message.createdAt)}</Row>
          </div>
        )}
        <NamesSource />
      </div>
    </PeopleScope>
  );
}

const ENFORCEMENT: Record<ActionRecordDto["status"], string> = {
  pending: "Enforcement pending…",
  enforcing: "Enforcing…",
  succeeded: "Enforcement succeeded",
  failed: "Enforcement failed",
  cancelled: "Enforcement cancelled",
};

/**
 * Only a failed action can be cancelled, which reopens the report. Pending
 * and enforcing actions belong to the relay's recovery worker.
 */
function Enforcement({
  reportId,
  action,
}: {
  reportId: string;
  action: ActionRecordDto;
}) {
  const { canMutate } = useSession();
  const write = useWrite<CancelRequest>(`cancel ${reportId}`);
  const cancel = () =>
    write.run({ route: "cancelReport", id: reportId, actionId: action.id });
  const message = action.errorMessage?.includes(
    "kick target was already absent",
  )
    ? "No channel membership to remove. Use Timeout or Ban for open channels."
    : action.errorMessage;
  return (
    <div className="flex flex-col gap-2 rounded-md border px-3 py-2.5 text-body-sm">
      <p className="flex items-center gap-2">
        {(action.status === "pending" || action.status === "enforcing") && (
          <CircleNotchIcon className="animate-spin" />
        )}
        {ENFORCEMENT[action.status]}
        <span className="font-mono text-caption text-secondary">
          {action.action}
        </span>
      </p>
      {message && <p className="text-caption text-secondary">{message}</p>}
      {action.status === "failed" && canMutate && (
        <Button size="sm" loading={write.busy} onClick={() => cancel()}>
          Cancel and reopen
        </Button>
      )}
    </div>
  );
}

function Resolve({ report }: { report: ReportDto }) {
  const write = useWrite<ResolveRequest>(`resolve ${report.id}`);
  const [action, setAction] = useState<ReportAction | null>(null);
  const [reason, setReason] = useState("");
  const [secs, setSecs] = useState("");
  const locked = write.frozen !== null || write.busy;
  const shown = write.frozen?.action ?? action;
  const secret = containsSecretKey(reason);
  const duration = Number(secs);
  const validDuration =
    action !== "timeout" || (Number.isInteger(duration) && duration > 0);

  const submit = () =>
    // A frozen request is resent as is; only a new action reads the form.
    write.run(
      action
        ? {
            route: "resolveReport",
            id: report.id,
            action,
            requestId: crypto.randomUUID(),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
            ...(action === "timeout" ? { expirationSecs: duration } : {}),
          }
        : undefined,
    );

  return (
    <div className="flex flex-col gap-3 rounded-md border px-3 py-2.5">
      <Field label="Resolve report" nativeLabel={false}>
        <RadioGroup<ReportAction | null>
          name={`resolve-${report.id}`}
          value={shown}
          disabled={locked}
          onValueChange={setAction}
        >
          {allowedActions(report).map((option) => (
            <Radio key={option} value={option} label={LABELS[option]} />
          ))}
        </RadioGroup>
      </Field>
      {shown === "timeout" && (
        <Field label="Duration (seconds)">
          <Input
            placeholder="e.g. 3600"
            type="number"
            min={1}
            disabled={locked}
            value={write.frozen?.expirationSecs?.toString() ?? secs}
            onChange={(event) => setSecs(event.target.value)}
          />
        </Field>
      )}
      <Field
        label="Reason (optional)"
        description={shown ? reasonAudience(shown) : undefined}
        error={secret ? SECRET_REASON : undefined}
      >
        <Input
          disabled={locked}
          value={write.frozen?.reason ?? reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      {shown && (
        <>
          <p className="flex flex-wrap items-center gap-1.5 text-caption text-secondary">
            In{" "}
            <CommunityBadge
              id={report.communityId}
              host={report.communityHost}
            />
            <NotConnected host={report.communityHost} />
          </p>
          <Button
            size="sm"
            variant="prominent"
            loading={write.busy}
            disabled={!write.frozen && (secret || !validDuration)}
            onClick={() => submit()}
          >
            {write.frozen ? "Retry" : "Confirm"}: {LABELS[shown]} in{" "}
            {report.communityHost}
          </Button>
          {write.frozen && !write.busy && (
            <Button size="sm" variant="ghost" onClick={write.discard}>
              Discard
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/** Re-triage only: reopening never reverses enforcement already taken. */
function Reopen({ report }: { report: ReportDto }) {
  const write = useWrite<ReopenRequest>(`reopen ${report.id}`);
  const [reason, setReason] = useState("");
  const secret = containsSecretKey(reason);
  const submit = () =>
    write.run({
      route: "reopenReport",
      id: report.id,
      requestId: crypto.randomUUID(),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
  return (
    <div className="flex flex-col gap-3 rounded-md border px-3 py-2.5">
      <p className="text-caption font-medium text-secondary">Reopen report</p>
      <p className="text-caption text-secondary">
        Moves this report back to the open queue for re-triage.{" "}
        {report.actionId
          ? "The enforcement action already taken is not reversed: reopening does not un-ban, un-timeout, or restore a deleted message."
          : "Reopening does not reverse any enforcement action."}
      </p>
      <Field
        label="Reopen reason (optional)"
        error={secret ? SECRET_REASON : undefined}
      >
        <Input
          disabled={write.frozen !== null}
          value={write.frozen?.reason ?? reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <Button
        size="sm"
        loading={write.busy}
        disabled={!write.frozen && secret}
        onClick={() => submit()}
      >
        {write.frozen ? "Retry reopen" : "Reopen report"}
      </Button>
    </div>
  );
}
