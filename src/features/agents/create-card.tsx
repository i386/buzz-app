// The New agent dialog's card, as a type's `Create` view sees it: a way to take
// over the card while editing, which the dialog answers with Back and Done.
import { createContext, useContext } from "react";

export type CardEditing = Readonly<{ back(): void; done(): void }>;
type CreateCard = Readonly<{
  /** Takes over the card until called again with `null`. */
  edit(editing: CardEditing | null): void;
}>;

export const CreateCardContext = createContext<CreateCard | null>(null);
export const useCreateCard = () => useContext(CreateCardContext);
