// The New agent dialog's card, as a type's `Create` view sees it: a corner
// beside the type choice for compact controls, and a way to take over the card
// while editing, which the dialog answers with Back and Done.
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type CardEditing = Readonly<{ back(): void; done(): void }>;
type CreateCard = Readonly<{
  corner: HTMLElement | null;
  /** Takes over the card until called again with `null`. */
  edit(editing: CardEditing | null): void;
}>;

export const CreateCardContext = createContext<CreateCard | null>(null);
export const useCreateCard = () => useContext(CreateCardContext);

/** Shows `children` in the card's top corner, beside the type choice. Outside
 * the dialog it shows them in place. */
export function CreateCorner({ children }: { children: ReactNode }) {
  const card = useCreateCard();
  if (!card) return children;
  return card.corner ? createPortal(children, card.corner) : null;
}
