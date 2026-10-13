import { afterEach, beforeEach, vi } from "vitest";

// jsdom lacks pointer capture and reports Document as relatedTarget after a
// focused node is removed. Browsers report null. Keep these emulator repairs
// local to tests that interact with Sonner; real focus/swipes are browser-tested.
function normalizeFocus(event: FocusEvent) {
  if (event.relatedTarget === document) {
    Object.defineProperty(event, "relatedTarget", { value: null });
  }
}
let pointerCapture: PropertyDescriptor | undefined;
beforeEach(() => {
  pointerCapture = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "setPointerCapture",
  );
  Object.defineProperty(Element.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  document.addEventListener("focusin", normalizeFocus, true);
});
afterEach(() => {
  document.removeEventListener("focusin", normalizeFocus, true);
  if (pointerCapture)
    Object.defineProperty(
      Element.prototype,
      "setPointerCapture",
      pointerCapture,
    );
  else Reflect.deleteProperty(Element.prototype, "setPointerCapture");
});
