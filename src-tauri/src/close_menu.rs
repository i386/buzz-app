//! Cmd+W is a menu action that only ever closes a tab, never the window: with
//! no tab to close it does nothing. The red button still closes the window.
//! Ctrl+Tab and Ctrl+Shift+Tab switch tabs from the same menu, so they also
//! work while a raw guest webview (the browser panel) owns keyboard focus.
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, WINDOW_SUBMENU_ID},
    AppHandle, Manager, Runtime,
};

const CLOSE: &str = "buzz-close";
const NEXT: &str = "buzz-next-tab";
const PREVIOUS: &str = "buzz-previous-tab";
const REQUEST: &str = include_str!("close-request.js");
const SWITCH: &str = include_str!("switch-tab-request.js");

pub(crate) fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let close = MenuItem::with_id(app, CLOSE, "Close Tab", true, Some("CmdOrCtrl+W"))?;
    // Tauri's default has Close Window in both File and Window. Preserve all
    // other native items (especially editing/services), replacing both routes.
    // Predefined items expose their label, but not their native action type.
    let close_label = PredefinedMenuItem::close_window(app, None)?.text()?;
    let mut replaced = 0;
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            for (index, item) in submenu.items()?.iter().enumerate() {
                if let Some(predefined) = item.as_predefined_menuitem() {
                    if predefined.text()? == close_label {
                        submenu.remove(item)?;
                        submenu.insert(&close, index)?;
                        replaced += 1;
                    }
                }
            }
        }
    }
    debug_assert_eq!(replaced, 2, "Tauri default Close menu structure changed");
    if let Some(window) = menu.get(WINDOW_SUBMENU_ID) {
        if let Some(window) = window.as_submenu() {
            window.append_items(&[
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, NEXT, "Show Next Tab", true, Some("Ctrl+Tab"))?,
                &MenuItem::with_id(
                    app,
                    PREVIOUS,
                    "Show Previous Tab",
                    true,
                    Some("Ctrl+Shift+Tab"),
                )?,
            ])?;
        }
    }
    Ok(menu)
}

pub(crate) fn handle<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let script = match event.id().as_ref() {
        CLOSE => REQUEST.to_owned(),
        // A block keeps the binding out of the page's global scope.
        NEXT => format!("{{ const tabEvent = \"buzz:next-tab\";\n{SWITCH}}}"),
        PREVIOUS => format!("{{ const tabEvent = \"buzz:previous-tab\";\n{SWITCH}}}"),
        _ => return,
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // Unlike a predefined Close item, custom menu items stay enabled without
    // a key window. Never consume a retained tab in a hidden/background window.
    if !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true)
        || !window.is_focused().unwrap_or(false)
    {
        return;
    }
    // Evaluate only in the trusted main view, even when a raw guest webview
    // owns keyboard focus.
    if let Err(error) = window.eval(script) {
        eprintln!("Could not send Buzz tab request: {error}");
    }
}
