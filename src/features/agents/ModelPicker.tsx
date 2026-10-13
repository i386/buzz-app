// A type's model choice, shared by agent types for the New agent dialog and
// their settings: a list to pick from, or any model ID typed in.
import { useLayoutEffect, useRef, useState } from "react";
import {
  ClaudeLogoIcon,
  OpenAILogoIcon,
  RobotIcon,
} from "../../shared/design-system/icons";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import styles from "./AgentControls.module.css";

export type ModelChoice = Readonly<{
  /** The model ID saved in the type's config. */
  id: string;
  label: string;
  description?: string | undefined;
}>;

/** Recognizes the vendor from a model's ID or name. */
export function ModelIcon({ model }: { model: string }) {
  const name = model.toLowerCase();
  const Icon = /claude|anthropic|opus|sonnet|haiku/.test(name)
    ? ClaudeLogoIcon
    : /(?:^|[\s/._-])(?:gpt|codex|o[134](?:[\s/._-]|$))|openai/.test(name)
      ? OpenAILogoIcon
      : RobotIcon;
  return <Icon size={18} aria-hidden="true" />;
}

/** `value` is a model ID, or "" for the type's default, `defaultLabel`.
 * `compact` sizes it to its text, for the New agent dialog's corner. */
export function ModelPicker({
  models,
  value,
  defaultLabel,
  onChange,
  loading = false,
  disabled = false,
  compact = false,
  description,
}: {
  models: readonly ModelChoice[];
  value: string;
  defaultLabel: string;
  onChange(value: string): void;
  loading?: boolean;
  disabled?: boolean;
  compact?: boolean;
  description?: string | undefined;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const highlighted = useRef<ModelChoice | null>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const fallback: ModelChoice = { id: "", label: defaultLabel };
  const items: ModelChoice[] = [fallback, ...models];
  if (value && !items.some((model) => model.id === value))
    items.push({ id: value, label: value, description: "Custom model" });
  const custom = query?.trim();
  if (custom && !items.some((m) => m.id === custom || m.label === custom))
    items.push({ id: custom, label: custom, description: "Custom model" });
  const shown =
    query === null
      ? items
      : items.filter((model) =>
          `${model.label} ${model.id}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        );
  const selected = items.find((model) => model.id === value) ?? fallback;
  const text = query ?? selected.label;
  useLayoutEffect(() => {
    const element = measure.current;
    if (!compact || !element) return;
    const update = () => setWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact]);
  const commit = () => {
    if (query === null) return;
    const match = items.find(
      (model) => model.id === query || model.label === query,
    );
    onChange((match?.id ?? query).trim());
    setQuery(null);
  };
  return (
    <div className={compact ? styles.compactModel : undefined}>
      {compact && (
        <span ref={measure} aria-hidden="true" className={styles.measure}>
          {text}
        </span>
      )}
      <Combobox.Root<ModelChoice>
        disabled={disabled}
        items={shown}
        filteredItems={shown}
        value={selected}
        inputValue={text}
        modal={false}
        itemToStringLabel={(model) => model.label}
        isItemEqualToValue={(a, b) => a.id === b.id}
        onItemHighlighted={(model) => {
          highlighted.current = model ?? null;
        }}
        onInputValueChange={(next, details) => {
          if (
            details.reason === "input-change" ||
            details.reason === "input-clear"
          )
            setQuery(next);
        }}
        onOpenChange={(open, details) => {
          if (!open && details.reason === "escape-key") setQuery(null);
        }}
        onValueChange={(model) => {
          if (model) onChange(model.id);
          setQuery(null);
        }}
      >
        <Combobox.Control
          label="Model"
          labelVisibility={compact ? "hidden" : "visible"}
          triggerLabel="Browse models"
          loading={loading}
          description={compact ? undefined : description}
          leading={<ModelIcon model={`${selected.id} ${selected.label}`} />}
          appearance={compact ? "chip" : "field"}
          placeholder="Choose or enter a model"
          style={
            compact
              ? { width: width ? `${Math.ceil(width) + 2}px` : "12ch" }
              : undefined
          }
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery(null);
            if (
              event.key === "Enter" &&
              !highlighted.current &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              commit();
            }
          }}
        />
        <Combobox.Popup
          className={styles.modelOptions}
          empty="Type a model ID to use a custom model."
        >
          <Combobox.List>
            {(model: ModelChoice) => (
              <Combobox.Item
                key={model.id || "default"}
                value={model}
                description={model.description}
              >
                <span className="flex items-center gap-2">
                  <ModelIcon model={`${model.id} ${model.label}`} />
                  {model.label}
                </span>
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Root>
    </div>
  );
}
