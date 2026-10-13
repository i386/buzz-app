import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type { Groups } from "../../features/channel-templates/model";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import styles from "./ChannelTemplates.module.css";

export function ChannelGroupsDialog({
  open,
  onOpenChange,
  kit,
  legacy,
  active,
}: {
  active(): boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  kit: ChannelKit;
  legacy: SidebarPreferences | undefined;
}) {
  const live = useRef(true);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const state = useSyncExternalStore(kit.subscribe, kit.snapshot);
  const entry = state.entries.find(
    (e) =>
      !e.record.deleted &&
      e.record.value.type === "groups" &&
      e.record.value.id === "personal",
  );
  // This editor is mounted per opening. Catalog refreshes must not rebase its draft.
  const [draft, setDraft] = useState<Groups>(() =>
    entry?.record.value.type === "groups"
      ? structuredClone(entry.record.value)
      : { type: "groups", id: "personal", groups: [], assignments: {} },
  );
  const [base] = useState(entry?.eventId);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const save = async () => {
    if (!live.current || !active()) return;
    setBusy(true);
    setError("");
    try {
      await kit.save(draft, base);
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      dismissOnOutsideClick
      open={open}
      onOpenChange={onOpenChange}
      preventClose={busy}
      title="Personal groups"
      closeLabel="Close personal groups"
      actions={
        <Button
          variant="prominent"
          loading={busy}
          disabled={
            state.status !== "ready" || draft.groups.some((g) => !g.name.trim())
          }
          onClick={() => void save()}
        >
          Save groups
        </Button>
      }
    >
      <div className={styles.stack} inert={busy}>
        <p className="text-secondary">
          Personal organization only. Moving channels never changes their
          members or Canvas.
        </p>
        {!entry && (
          <>
            <p>
              This activates separate new-Buzz groups. OG groups remain
              untouched and will no longer be displayed here; later OG edits
              will not sync into this list.
            </p>
            {!!legacy?.sections.length && (
              <Button
                onClick={() => {
                  const groups = legacy.sections.map((g) => ({
                    id: crypto.randomUUID(),
                    name: g.name,
                    defaultTemplateId: "",
                    previousId: g.id,
                  }));
                  const ids = new Map(groups.map((g) => [g.previousId, g.id]));
                  setDraft({
                    type: "groups",
                    id: "personal",
                    groups: groups.map(({ id, name, defaultTemplateId }) => ({
                      id,
                      name,
                      defaultTemplateId,
                    })),
                    assignments: Object.fromEntries(
                      Object.entries(legacy.assignments).flatMap(
                        ([channel, group]) => {
                          const id = ids.get(group);
                          return id ? [[channel, id]] : [];
                        },
                      ),
                    ),
                  });
                }}
              >
                Copy visible OG groups into this draft
              </Button>
            )}
          </>
        )}
        {draft.groups.map((group, index) => (
          <section key={group.id} className={styles.stack}>
            <Field label="Group name">
              <Input
                maxLength={120}
                value={group.name}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    groups: draft.groups.map((g) =>
                      g.id === group.id ? { ...g, name: e.target.value } : g,
                    ),
                  })
                }
              />
            </Field>
            <div className={styles.actions}>
              <Button
                disabled={index === 0}
                onClick={() => {
                  const groups = [...draft.groups];
                  const previous = groups[index - 1];
                  if (!previous) return;
                  groups[index - 1] = group;
                  groups[index] = previous;
                  setDraft({ ...draft, groups });
                }}
              >
                Move up
              </Button>
              <Button
                onClick={() =>
                  setDraft({
                    ...draft,
                    groups: draft.groups.filter((g) => g.id !== group.id),
                    assignments: Object.fromEntries(
                      Object.entries(draft.assignments).filter(
                        ([, id]) => id !== group.id,
                      ),
                    ),
                  })
                }
              >
                Remove group (keep channels)
              </Button>
            </div>
          </section>
        ))}
        <Button
          onClick={() =>
            setDraft({
              ...draft,
              groups: [
                ...draft.groups,
                { id: crypto.randomUUID(), name: "", defaultTemplateId: "" },
              ],
            })
          }
        >
          New group
        </Button>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
