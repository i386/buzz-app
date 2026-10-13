// An agent's instructions, shared by agent types. In the New agent dialog's
// card it is a short preview that opens into an editor over the card; in a
// settings tab it is a plain field.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import styles from "./AgentControls.module.css";
import { useCreateCard } from "./create-card";

const EXAMPLES = [
  "Help me plan my week and prioritize tasks.",
  "Review my writing and suggest clearer wording.",
  "Research a topic and summarize the key ideas.",
  "Help me brainstorm ideas and next steps.",
];
const PLACEHOLDER = "Describe what I should do…";

export function AgentInstructions({
  value,
  disabled,
  onChange,
  description,
}: {
  value: string;
  disabled: boolean;
  onChange(value: string): void;
  description?: string | undefined;
}) {
  const card = useCreateCard();
  if (!card)
    return (
      <Field label="Instructions" description={description}>
        <Textarea
          rows={8}
          value={value}
          disabled={disabled}
          placeholder={PLACEHOLDER}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    );
  return <CardInstructions {...{ value, disabled, onChange }} />;
}

function CardInstructions({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const card = useCreateCard();
  const [editing, setEditing] = useState(false);
  // Back restores what the instructions were when editing began.
  const before = useRef(value);
  const change = useRef(onChange);
  change.current = onChange;
  const edit = card?.edit;
  // Leaving the editor returns focus to the button that opened it.
  const opener = useRef<HTMLButtonElement>(null);
  const returning = useRef(false);
  useEffect(() => {
    if (editing || !returning.current) return;
    returning.current = false;
    opener.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (!editing || !edit) return;
    const leave = () => {
      returning.current = true;
      setEditing(false);
    };
    edit({
      back: () => {
        change.current(before.current);
        leave();
      },
      done: leave,
    });
    return () => edit(null);
  }, [editing, edit]);
  if (editing)
    return (
      <div className={styles.instructionEditor}>
        <Field label="Agent instructions" labelVisibility="hidden">
          <Textarea
            autoFocus
            value={value}
            disabled={disabled}
            placeholder={PLACEHOLDER}
            onChange={(event) => onChange(event.target.value)}
          />
        </Field>
      </div>
    );
  return (
    <div className={styles.instructionEntry}>
      <span className={styles.instructionCopy}>
        {value.trim() ? (
          <span className={styles.instructionPreview}>{value}</span>
        ) : (
          <Examples />
        )}
      </span>
      <div className={styles.instructionAction}>
        <Button
          ref={opener}
          variant="primary"
          disabled={disabled}
          onClick={() => {
            before.current = value;
            setEditing(true);
          }}
        >
          {value.trim() ? "Edit instructions" : "Add instructions"}
        </Button>
      </div>
    </div>
  );
}

function Examples() {
  const [index, setIndex] = useState(0);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % EXAMPLES.length),
      5000,
    );
    return () => window.clearInterval(timer);
  }, [reducedMotion]);
  return (
    <span className={`${styles.example} text-body-sm`} aria-hidden="true">
      <AnimatePresence initial={false} mode="wait">
        <motion.span
          key={index}
          initial={{ opacity: 0, y: reducedMotion ? 0 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reducedMotion ? 0 : -4 }}
          transition={{ duration: reducedMotion ? 0 : 0.2, ease: "easeOut" }}
        >
          {EXAMPLES[index]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
