// Evaluated only in the trusted main webview by the macOS Close Tab menu.
// The status is informational: the window never closes when unhandled.
(() => {
  if (document.querySelector('dialog[open], [aria-modal="true"]'))
    return "handled";
  const request = new Event("buzz:close-active-tab", { cancelable: true });
  window.dispatchEvent(request);
  return request.defaultPrevented ? "handled" : "unhandled";
})();
