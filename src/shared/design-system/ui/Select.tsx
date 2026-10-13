import { useId, type ReactNode } from "react";
import { Field } from "./Field";
import { Select as BaseSelect } from "@base-ui/react/select";
import { CheckIcon, CaretDownIcon } from "../icons/index";
import { Button } from "./Button";

export type SelectGroup = {
  label: string;
  options: readonly {
    value: string;
    label: string;
    description?: ReactNode;
    /** Decorative identity artwork shown before the option's text. */
    leading?: ReactNode;
    disabled?: boolean;
  }[];
};

/** A compact, labelled single-choice control with accessible option groups. */
export function Select({
  label,
  value,
  groups,
  onValueChange,
  variant = "inline",
  disabled = false,
  description,
  error,
  name,
  required,
  readOnly,
  placeholder,
  valueLabel,
  valueTitle,
  leading,
  align = "start",
}: {
  label: string;
  description?: ReactNode;
  error?: ReactNode;
  name?: string;
  required?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  /** Compact display text; option labels retain their full meaning. */
  valueLabel?: string;
  valueTitle?: string;
  /** Decorative identity artwork shown before the selected value. */
  leading?: ReactNode;
  /** Anchor the popup to the corresponding trigger edge. */
  align?: "start" | "center" | "end";
  variant?: "inline" | "field" | "compact";
  disabled?: boolean;
  value: string;
  groups: readonly SelectGroup[];
  onValueChange: (value: string) => void;
}) {
  const optionDescriptionId = useId();
  const items = groups.flatMap((group) => group.options);
  const selectedValue =
    value === "" && !items.some((option) => option.value === "") ? null : value;
  const control = (
    <div
      data-buzz-ui=""
      className="buzz-select text-body"
      data-variant={variant}
    >
      <BaseSelect.Root
        disabled={disabled}
        name={name}
        required={required}
        readOnly={readOnly}
        value={selectedValue}
        items={items}
        onValueChange={(next) => {
          if (next !== null) onValueChange(next);
        }}
      >
        {variant !== "field" && (
          <BaseSelect.Label
            className={variant === "compact" ? "sr-only" : "text-primary"}
          >
            {label}
          </BaseSelect.Label>
        )}
        {variant === "field" ? (
          <BaseSelect.Trigger
            data-buzz-ui=""
            className="buzz-input buzz-select-trigger"
          >
            <span className="buzz-select-value-content">
              {leading && (
                <span className="buzz-select-leading" aria-hidden="true">
                  {leading}
                </span>
              )}
              <BaseSelect.Value
                className="buzz-select-value"
                placeholder={selectedValue === null ? placeholder : undefined}
                data-placeholder={selectedValue === null ? "" : undefined}
              >
                {valueLabel}
              </BaseSelect.Value>
            </span>
            <BaseSelect.Icon>
              <CaretDownIcon
                size={16}
                className="buzz-dropdown-chevron"
                aria-hidden="true"
              />
            </BaseSelect.Icon>
          </BaseSelect.Trigger>
        ) : (
          <BaseSelect.Trigger
            // Base UI adds aria-labelledby after the commit that inserts the
            // trigger, so it can be unnamed until a later task. Name it now.
            aria-label={label}
            render={(props) => (
              <Button
                {...props}
                variant={variant === "compact" ? "outline" : "ghost"}
                size={variant === "compact" ? "sm" : "md"}
              >
                <span className="buzz-select-value-content">
                  {leading && (
                    <span className="buzz-select-leading" aria-hidden="true">
                      {leading}
                    </span>
                  )}
                  <BaseSelect.Value
                    className={
                      variant === "compact" ? "buzz-select-value" : undefined
                    }
                    title={
                      variant === "compact"
                        ? (valueTitle ??
                          items.find((item) => item.value === value)?.label)
                        : undefined
                    }
                    placeholder={
                      selectedValue === null ? placeholder : undefined
                    }
                    data-placeholder={selectedValue === null ? "" : undefined}
                  >
                    {valueLabel}
                  </BaseSelect.Value>
                </span>
                <BaseSelect.Icon>
                  <CaretDownIcon
                    size={14}
                    className="buzz-dropdown-chevron"
                    aria-hidden="true"
                  />
                </BaseSelect.Icon>
              </Button>
            )}
          />
        )}
        <BaseSelect.Portal>
          <BaseSelect.Positioner
            className="buzz-select-positioner"
            sideOffset={4}
            align={align}
            alignItemWithTrigger={false}
          >
            <BaseSelect.Popup
              data-buzz-ui=""
              className="buzz-select-popup text-body"
              data-variant={variant}
            >
              <BaseSelect.List>
                {groups.map((group, groupIndex) => (
                  <BaseSelect.Group key={group.label}>
                    {group.label && (
                      <BaseSelect.GroupLabel className="buzz-select-group-label text-secondary">
                        {group.label}
                      </BaseSelect.GroupLabel>
                    )}
                    {group.options.map((option, optionIndex) => {
                      const descriptionId = `${optionDescriptionId}-${groupIndex}-${optionIndex}`;
                      return (
                        <BaseSelect.Item
                          key={option.value}
                          value={option.value}
                          disabled={option.disabled}
                          aria-label={option.label}
                          aria-describedby={
                            option.description ? descriptionId : undefined
                          }
                          className="buzz-select-option"
                        >
                          <span className="buzz-select-option-main">
                            {option.leading && (
                              <span
                                className="buzz-select-leading"
                                aria-hidden="true"
                              >
                                {option.leading}
                              </span>
                            )}
                            <span className="buzz-select-option-content">
                              <BaseSelect.ItemText>
                                {option.label}
                              </BaseSelect.ItemText>
                              {option.description && (
                                <span
                                  id={descriptionId}
                                  className="buzz-select-option-description text-body-sm text-subtle"
                                >
                                  {option.description}
                                </span>
                              )}
                            </span>
                          </span>
                          <BaseSelect.ItemIndicator
                            className="buzz-select-indicator"
                            keepMounted={variant === "compact"}
                          >
                            <CheckIcon size={14} aria-hidden="true" />
                          </BaseSelect.ItemIndicator>
                        </BaseSelect.Item>
                      );
                    })}
                  </BaseSelect.Group>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </div>
  );
  return variant === "field" ? (
    <Field
      nativeLabel={false}
      label={label}
      description={description}
      error={error}
      disabled={disabled}
    >
      {control}
    </Field>
  ) : (
    control
  );
}
