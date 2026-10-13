// A type's model choice, shared by agent types for the New agent dialog and
// their settings. Each type decides whether its catalog accepts custom IDs.
import { useId, useRef, useState, type ComponentProps } from "react";
import {
  ClaudeLogoIcon,
  OpenAILogoIcon,
  RobotIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import { Select } from "../../shared/design-system/ui/Select";

export type ModelChoice = Readonly<{
  /** The model ID saved in the type's config. */
  id: string;
  label: string;
  description?: string | undefined;
}>;

const CUSTOM_MODEL_ACTION: ModelChoice = {
  id: "\0custom-model",
  label: "Custom model",
  description: "Enter a model ID",
};

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

/** The custom-model form. Create hosts it outside its closing menu; Settings
 * renders it beside the field that opened it. */
export function CustomModelDialog({
  initialValue,
  onSubmit,
  onClose,
  finalFocus = false,
}: {
  initialValue: string;
  onSubmit(model: string): void;
  onClose(): void;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
}) {
  const [model, setModel] = useState(initialValue);
  const input = useRef<HTMLInputElement>(null);
  const form = useId();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Custom model"
      headerGap="compact"
      initialFocus={input}
      finalFocus={finalFocus}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            form={form}
            type="submit"
            variant="prominent"
            disabled={!model.trim()}
          >
            Use model
          </Button>
        </>
      }
    >
      <form
        id={form}
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const value = model.trim();
          if (value) onSubmit(value);
        }}
      >
        <Field label="Model ID" labelVisibility="hidden">
          <Input
            ref={input}
            value={model}
            placeholder="Enter a model ID"
            required
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setModel(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/** `value` is a model ID, or "" for the type's default, `defaultLabel`. */
export function ModelPicker({
  models,
  allowCustomModel,
  value,
  defaultLabel,
  defaultDescription,
  onChange,
  loading = false,
  disabled = false,
  presentation = "field",
  description,
  requestCustomModel,
  active = true,
}: {
  models: readonly ModelChoice[];
  /** Whether text absent from `models` may be committed as its model ID. */
  allowCustomModel: boolean;
  value: string;
  defaultLabel: string;
  defaultDescription?: string;
  onChange(value: string): void;
  loading?: boolean;
  disabled?: boolean;
  presentation?: "field" | "menu";
  description?: string | undefined;
  requestCustomModel?: (
    initialValue: string,
    onChange: (model: string) => void,
  ) => void;
  /** Whether this menu belongs to the provider currently selected by its host. */
  active?: boolean;
}) {
  const [customModel, setCustomModel] = useState<string | null>(null);
  const control = useRef<HTMLDivElement>(null);
  const fallback: ModelChoice = {
    id: "",
    label: defaultLabel,
    description: defaultDescription,
  };
  const items: ModelChoice[] = [fallback, ...models];
  if (value && !items.some((model) => model.id === value))
    items.push({
      id: value,
      label: value,
      description: allowCustomModel ? "Custom model" : "Unavailable model",
    });
  const selected = items.find((model) => model.id === value) ?? fallback;
  const choices = allowCustomModel ? [...items, CUSTOM_MODEL_ACTION] : items;
  const openCustomDialog = () => {
    const listed = !value || models.some((model) => model.id === value);
    const initialValue = listed ? "" : value;
    if (requestCustomModel) requestCustomModel(initialValue, onChange);
    else setCustomModel(initialValue);
  };
  return (
    <>
      {presentation === "menu" ? (
        <>
          <MenuRadioGroup
            value={active ? selected.id : "\0inactive-provider"}
            onValueChange={(model) => onChange(model)}
          >
            {items.map((model) => (
              <MenuRadioItem
                key={model.id}
                value={model.id}
                disabled={disabled || loading}
                closeOnClick
              >
                <ChoiceRow
                  label={model.label}
                  description={model.description}
                  leading={<ModelIcon model={`${model.id} ${model.label}`} />}
                />
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {allowCustomModel && (
            <MenuItem
              disabled={disabled || loading}
              closeOnClick={Boolean(requestCustomModel)}
              onClick={openCustomDialog}
            >
              <ChoiceRow
                label={CUSTOM_MODEL_ACTION.label}
                description={CUSTOM_MODEL_ACTION.description}
                leading={<RobotIcon size={18} aria-hidden="true" />}
              />
            </MenuItem>
          )}
        </>
      ) : (
        <div ref={control}>
          <Select
            label="Model"
            value={selected.id}
            valueLabel={selected.label}
            valueTitle={selected.label}
            leading={<ModelIcon model={`${selected.id} ${selected.label}`} />}
            variant="field"
            groups={[
              {
                label: "",
                options: choices.map((model) => ({
                  value: model.id,
                  label: model.label,
                  description: model.description,
                  leading: <ModelIcon model={`${model.id} ${model.label}`} />,
                })),
              },
            ]}
            disabled={disabled || loading}
            description={description}
            onValueChange={(model) => {
              if (model === CUSTOM_MODEL_ACTION.id) openCustomDialog();
              else onChange(model);
            }}
          />
          {loading && <p className="buzz-field-description">Loading models…</p>}
        </div>
      )}
      {allowCustomModel && customModel !== null && (
        <CustomModelDialog
          initialValue={customModel}
          onClose={() => setCustomModel(null)}
          onSubmit={(model) => {
            onChange(model);
            setCustomModel(null);
          }}
          finalFocus={() =>
            presentation === "field"
              ? (control.current?.querySelector<HTMLElement>(
                  "[role=combobox]",
                ) ?? false)
              : false
          }
        />
      )}
    </>
  );
}
