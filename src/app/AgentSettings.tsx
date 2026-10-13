import { useState, type ReactNode } from "react";
import {
  setRememberAgentsPreference,
  useRememberAgentsPreference,
} from "../features/messages/mention-preferences";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { Button } from "../shared/design-system/ui/Button";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { ToastNotice } from "../shared/design-system/ui/Toast";

export function AgentSettings({
  archive,
  active = true,
}: {
  archive?: ReactNode;
  active?: boolean;
}) {
  const preference = useRememberAgentsPreference();
  const [error, setError] = useState<string | null>(null);
  const change = (enabled: boolean) =>
    setError(setRememberAgentsPreference(enabled));
  return (
    <section aria-labelledby="agent-settings-title">
      <Header id="agent-settings-title" title="Agents" />
      {archive}
      <div className="mt-section-gap">
        <InlineHeader title="Messages" />
        <SettingsGroup>
          <SwitchPreferenceRow
            label="Remember mentioned agents"
            description="Keep the same agents selected for your next message in this channel or thread."
            checked={preference}
            onCheckedChange={change}
          />
        </SettingsGroup>
      </div>
      {active && error && (
        <ToastNotice title="Agent preference wasn’t saved" description={error}>
          <Button type="button" size="sm" onClick={() => change(preference)}>
            Retry saving
          </Button>
        </ToastNotice>
      )}
    </section>
  );
}
