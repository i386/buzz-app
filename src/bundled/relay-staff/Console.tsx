import { useState } from "react";
import {
  ChatCircleIcon,
  FlagIcon,
  GlobeIcon,
  ShieldIcon,
} from "../../shared/design-system/icons";
import { CommunityPage, Communities } from "./Communities";
import { DirectActionsProvider } from "./DirectActions";
import { Feedback } from "./Feedback";
import { Operators } from "./Operators";
import { Reports } from "./Reports";
import { useSession } from "./session";
import { NavContext, type CommunityRef } from "./ui";

export const SCREENS = {
  reports: {
    title: "Reports",
    icon: FlagIcon,
    subtitle: "Triage reports from every community on",
  },
  feedback: {
    title: "Feedback",
    icon: ChatCircleIcon,
    subtitle: "Review feedback sent to",
  },
  communities: {
    title: "Communities",
    icon: GlobeIcon,
    subtitle: "Browse and moderate every community on",
  },
  staff: {
    title: "Staff",
    icon: ShieldIcon,
    subtitle: "Add, change and remove operators and moderators on",
  },
};
export type Screen = keyof typeof SCREENS;

/**
 * One authorized screen. A community badge opens that community's page in
 * place, with Back to the screen. The direct-action controller sits above
 * the community page, so going Back keeps a reviewed action.
 */
export function Console({ screen }: { screen: Screen }) {
  const { context, isOperator } = useSession();
  const [community, setCommunity] = useState<CommunityRef | null>(null);
  const connectedHost = hostOf(context.relay);
  return (
    <NavContext.Provider value={{ open: setCommunity, connectedHost }}>
      <DirectActionsProvider>
        {community ? (
          <CommunityPage
            community={community}
            onBack={() => setCommunity(null)}
          />
        ) : (
          <>
            {screen === "reports" && <Reports />}
            {screen === "feedback" && <Feedback />}
            {screen === "communities" && (
              <Communities
                connectedHost={connectedHost}
                onOpen={setCommunity}
              />
            )}
            {screen === "staff" && isOperator && <Operators />}
          </>
        )}
      </DirectActionsProvider>
    </NavContext.Provider>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
