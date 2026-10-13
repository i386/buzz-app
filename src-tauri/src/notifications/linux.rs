//! Standard freedesktop notifications, with the receiver armed before Notify.
use super::{Outcome, Pending, MAX_ACTIVE};
use futures_lite::{future, StreamExt};
use std::{borrow::Cow, collections::HashMap, sync::Arc};
use zbus::{zvariant::Value, Connection, Message, Proxy};

const SERVICE: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";

pub(super) async fn show(
    connection: zbus::Result<Connection>,
    title: &str,
    body: &str,
    pending: Arc<Pending>,
) {
    let result = match connection {
        Ok(connection) => notify(&connection, title, body).await,
        Err(error) => Err(error.to_string()),
    };
    pending.finish(result.unwrap_or_else(Outcome::Failed));
}

async fn notify(connection: &Connection, title: &str, body: &str) -> Result<Outcome, String> {
    let proxy = Proxy::new(connection, SERVICE, PATH, SERVICE)
        .await
        .map_err(|e| e.to_string())?;
    let capabilities: Vec<String> = proxy
        .call("GetCapabilities", &())
        .await
        .map_err(|e| e.to_string())?;
    if !capabilities
        .iter()
        .any(|capability| capability == "actions")
    {
        return Err("The desktop notification service does not support clicks".into());
    }
    // This installs the match rule AND retains an active receiver on the same
    // connection used for Notify, including signals addressed only to its caller.
    let mut signals = proxy
        .receive_all_signals()
        .await
        .map_err(|e| e.to_string())?;
    let body = notification_body(body, &capabilities);
    let icon = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_default();
    let args = (
        "Buzz",
        0u32,
        icon,
        title,
        body.as_ref(),
        vec!["default", "Open"],
        // Sound is app-owned: the renderer plays the selected bundled sound
        // after delivery, so ask the server not to add its own.
        HashMap::<&str, Value<'_>>::from([("suppress-sound", Value::from(true))]),
        -1i32,
    );
    let reply = proxy.call::<_, _, u32>("Notify", &args);
    futures_lite::pin!(reply);
    let mut early = HashMap::new();
    let id = loop {
        // Drain while the reply is pending: filling zbus's bounded signal queue
        // would otherwise prevent its socket reader from reaching the reply.
        enum Next {
            Reply(zbus::Result<u32>),
            Signal(Option<Message>),
        }
        match future::or(async { Next::Reply(reply.as_mut().await) }, async {
            Next::Signal(signals.next().await)
        })
        .await
        {
            Next::Reply(result) => break result.map_err(|e| e.to_string())?,
            Next::Signal(Some(message)) => {
                if let Some((id, outcome)) = response(&message)? {
                    // The daemon assigns IDs. Until its reply arrives, retain
                    // first terminal responses without an unbounded event log.
                    if !early.contains_key(&id) && early.len() == MAX_ACTIVE {
                        return Err(
                            "Too many notification responses before Notify completed".into()
                        );
                    }
                    early.entry(id).or_insert(outcome);
                }
            }
            Next::Signal(None) => return Err("Desktop notification service disconnected".into()),
        }
    };
    if let Some(outcome) = early.remove(&id) {
        return Ok(outcome);
    }
    while let Some(message) = signals.next().await {
        if let Some((response_id, outcome)) = response(&message)? {
            if response_id == id {
                return Ok(outcome);
            }
        }
    }
    Err("Desktop notification service disconnected".into())
}

/// The body is plain text. A server that advertises `body-markup` parses it
/// as markup, so escape it there; typed `<harness>` must stay literal.
fn notification_body<'a>(body: &'a str, capabilities: &[String]) -> Cow<'a, str> {
    if !capabilities
        .iter()
        .any(|capability| capability == "body-markup")
        || !body.contains(['&', '<', '>'])
    {
        return Cow::Borrowed(body);
    }
    let mut escaped = String::with_capacity(body.len());
    for character in body.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            other => escaped.push(other),
        }
    }
    Cow::Owned(escaped)
}

fn response(message: &Message) -> Result<Option<(u32, Outcome)>, String> {
    match message.header().member().map(|name| name.as_str()) {
        Some("ActionInvoked") => {
            let (id, action): (u32, String) =
                message.body().deserialize().map_err(|e| e.to_string())?;
            Ok(Some((
                id,
                if action == "default" {
                    Outcome::Activated
                } else {
                    Outcome::Closed
                },
            )))
        }
        Some("NotificationClosed") => {
            let (id, _reason): (u32, u32) =
                message.body().deserialize().map_err(|e| e.to_string())?;
            Ok(Some((id, Outcome::Closed)))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests;
