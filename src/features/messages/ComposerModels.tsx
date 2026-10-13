import { Popover } from "@base-ui/react/popover";
import { Slider } from "@base-ui/react/slider";
import {
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { useMentionModels } from "../agents/react";
import type { MentionModelChoice } from "../agents/react";
import type { Effort } from "../agents/service";
import type { MentionPicks, RunPick } from "../relay/messages";
import {
  CaretDownIcon,
  GaugeIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import styles from "./ComposerModels.module.css";

/** Model and effort for the next run of each mentioned agent of the viewer's
 * that offers a choice. Unpicked agents run with their own. */
export function ComposerModels({
  pubkeys,
  value,
  disabled,
  onChange,
}: {
  pubkeys: readonly string[];
  value: MentionPicks;
  disabled: boolean;
  onChange(value: MentionPicks): void;
}) {
  const [open, setOpen] = useState(false);
  const choices = useMentionModels(pubkeys);
  const thumb = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!choices.length) return null;
  const picked = choices.flatMap((choice) => {
    const { model, effort } = value[choice.pubkey] ?? {};
    const runs = runModel(choice, model);
    const text = [
      model !== undefined && runs.label,
      runs.efforts.find((item) => item.id === effort)?.label,
    ]
      .filter(Boolean)
      .join(" · ");
    return text ? [choices.length > 1 ? `${choice.name}: ${text}` : text] : [];
  });
  const pick = (pubkey: string, next: RunPick) => {
    const { [pubkey]: _, ...rest } = value;
    onChange(next.model || next.effort ? { ...rest, [pubkey]: next } : rest);
  };
  return (
    <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
      <Popover.Trigger
        disabled={disabled}
        render={
          <IconButton
            ref={trigger}
            size="toolbar"
            type="button"
            disabled={disabled}
            data-selected={picked.length ? "" : undefined}
            aria-label="Model and effort for the next run"
            title={
              picked.length
                ? `Next run: ${picked.join(", ")}`
                : "Model and effort for the next run"
            }
            icon={<GaugeIcon size={18} aria-hidden="true" />}
          />
        }
      />
      <Popover.Portal>
        {/* The controls are the whole popup: it has no surface of its own. */}
        <Popover.Positioner
          className="buzz-popover-positioner"
          side="top"
          align="end"
          sideOffset={8}
          anchor={() => trigger.current?.closest("form") ?? trigger.current}
          collisionPadding={8}
        >
          <Popover.Popup
            className={styles.popup}
            aria-label="Model and effort for the next run"
            initialFocus={thumb}
          >
            {choices.map((choice, index) => (
              <AgentChoice
                key={choice.pubkey}
                choice={choice}
                named={choices.length > 1}
                value={value[choice.pubkey] ?? {}}
                disabled={disabled}
                pick={(next) => pick(choice.pubkey, next)}
                {...(index === 0 ? { thumb } : {})}
              />
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The model a run uses: the picked one, or else the agent's own. */
const runModel = (choice: MentionModelChoice, picked: string | undefined) =>
  choice.models.find((item) => item.id === picked) ??
  choice.models.find((item) => item.id === choice.current) ??
  choice.models[0] ?? { id: "", label: "", efforts: [] };

function AgentChoice({
  choice,
  named,
  value,
  disabled,
  pick,
  thumb,
}: {
  choice: MentionModelChoice;
  named: boolean;
  value: RunPick;
  disabled: boolean;
  pick(next: RunPick): void;
  thumb?: Ref<HTMLInputElement>;
}) {
  if (choice.loading)
    return (
      <div className={styles.loading} role="status" aria-busy="true">
        {named && <span>{choice.name}</span>}
        <span>Loading model and effort…</span>
      </div>
    );
  const runs = runModel(choice, value.model);
  const several = choice.models.length > 1;
  // Picking the agent's own model is no pick; an effort the new model lacks
  // falls back to its default.
  const chooseModel = (id: string) => {
    const next = choice.models.find((item) => item.id === id);
    const effort = next?.efforts.some((item) => item.id === value.effort)
      ? value.effort
      : undefined;
    pick({
      ...(id !== choice.current ? { model: id } : {}),
      ...(effort ? { effort } : {}),
    });
  };
  const model = several ? (
    <div className={styles.model}>
      <MenuRoot>
        <MenuTrigger
          disabled={disabled}
          aria-label={`Model for ${choice.name}'s next run`}
          render={
            <Button variant="ghost" size="inline">
              <span className={styles.about}>{runs.label}</span>
              <CaretDownIcon aria-hidden="true" />
            </Button>
          }
        />
        <MenuPopup size="compact" side="top" align="end">
          <MenuRadioGroup value={runs.id} onValueChange={chooseModel}>
            {choice.models.map((item) => (
              <MenuRadioItem key={item.id} value={item.id} closeOnClick>
                {item.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </MenuRoot>
    </div>
  ) : (
    <span className={styles.about}>{runs.label}</span>
  );
  return (
    <div className={styles.agent}>
      {named && <span className={styles.about}>{choice.name}</span>}
      {runs.efforts.length > 0 ? (
        <EffortSlider
          name={choice.name}
          model={model}
          efforts={runs.efforts}
          resting={runs.effort}
          value={value.effort}
          disabled={disabled}
          pick={(effort) =>
            pick({
              ...(value.model ? { model: value.model } : {}),
              ...(effort ? { effort } : {}),
            })
          }
          {...(thumb ? { thumb } : {})}
        />
      ) : (
        model
      )}
    </div>
  );
}

function EffortSlider({
  name,
  model,
  efforts,
  resting,
  value,
  disabled,
  pick,
  thumb,
}: {
  name: string;
  model: ReactNode;
  efforts: readonly Effort[];
  /** The effort the run uses without a pick, when known. */
  resting: string | undefined;
  value: string | undefined;
  disabled: boolean;
  pick(effort: string | undefined): void;
  thumb?: Ref<HTMLInputElement>;
}) {
  const index = efforts.findIndex((effort) => effort.id === value);
  const set = index >= 0;
  const own = efforts.findIndex((effort) => effort.id === resting);
  const at = set ? index : Math.max(own, 0);
  const last = Math.max(efforts.length - 1, 1);
  const known = set || own >= 0;
  const level = known ? (efforts[at]?.label ?? "") : "Default";
  // A tap on the thumb's resting stop changes no value, so commits pick too.
  // The run's own effort is no pick.
  const choose = (next: number) => {
    const effort = efforts[next]?.id;
    pick(effort === resting ? undefined : effort);
  };
  return (
    <Slider.Root
      className={styles.slider}
      data-unknown={known ? undefined : ""}
      value={at}
      min={0}
      max={efforts.length - 1}
      step={1}
      thumbAlignment="edge"
      disabled={disabled}
      onValueChange={choose}
      onValueCommitted={choose}
    >
      {/* Keep the model outside the drag target, on the track's attached tab. */}
      <div className={styles.tab}>
        {model}
        <span aria-hidden="true">{level}</span>
      </div>
      <Slider.Control className={styles.control}>
        <Slider.Track className={styles.track}>
          <Slider.Indicator className={styles.indicator} />
          {efforts.map((effort, stop) => (
            <span
              key={effort.id}
              className={styles.stop}
              style={{ "--stop": stop / last } as CSSProperties}
            />
          ))}
          <Slider.Thumb
            className={styles.thumb}
            inputRef={thumb}
            aria-label={`Effort for ${name}'s next run`}
            getAriaValueText={() => level}
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
