use super::*;
use crate::notifications::Notifications;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Mutex,
    },
    time::Duration,
};
use zbus::{connection::Builder, message::Header, zvariant::OwnedValue};

// Each test owns an isolated real bus. Never register a fake notification service
// on the user's session bus or change process-global DBUS_SESSION_BUS_ADDRESS.
struct Bus(Child, String);
impl Bus {
    fn start() -> Self {
        let mut child = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--nopidfile", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("Linux notification tests require dbus-daemon");
        let mut address = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        assert!(
            !address.trim().is_empty(),
            "dbus-daemon did not return an address"
        );
        Self(child, address.trim().to_owned())
    }
}
impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[derive(Clone, Copy)]
enum Scenario {
    Click,
    Close,
    Burst,
    Overflow,
    Unsupported,
    Rejected,
    Markup,
}
/// Every scenario sends this plain-text preview.
const PREVIEW: &str = "<harness> & a > b";
struct Daemon {
    scenario: Scenario,
    unicast: bool,
    calls: Arc<AtomicUsize>,
}
#[zbus::interface(name = "org.freedesktop.Notifications")]
impl Daemon {
    fn get_capabilities(&self) -> Vec<&str> {
        match self.scenario {
            Scenario::Unsupported => vec![],
            Scenario::Markup => vec!["actions", "body-markup"],
            _ => vec!["actions"],
        }
    }

    #[allow(clippy::too_many_arguments)] // The standard freedesktop Notify signature.
    async fn notify(
        &self,
        app_name: &str,
        replaces_id: u32,
        _app_icon: &str,
        summary: &str,
        body: &str,
        actions: Vec<String>,
        hints: HashMap<String, OwnedValue>,
        expire_timeout: i32,
        #[zbus(connection)] connection: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> zbus::fdo::Result<u32> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        // A markup server must show the typed text, not parse it as tags.
        let expected = if matches!(self.scenario, Scenario::Markup) {
            "&lt;harness&gt; &amp; a &gt; b"
        } else {
            PREVIEW
        };
        assert_eq!(
            (app_name, replaces_id, summary, body),
            ("Buzz", 0, "Title", expected)
        );
        assert_eq!(actions, ["default", "Open"]);
        // Banners are silent on the server side; the app plays its own sound.
        assert_eq!(
            hints.get("suppress-sound").map(|value| &**value),
            Some(&zbus::zvariant::Value::from(true))
        );
        assert_eq!(hints.len(), 1);
        assert_eq!(expire_timeout, -1);
        if matches!(self.scenario, Scenario::Rejected) {
            return Err(zbus::fdo::Error::Failed("Notify rejected".into()));
        }
        let destination = if self.unicast {
            header.sender().map(|s| s.as_str())
        } else {
            None
        };
        let count = match self.scenario {
            Scenario::Burst => 96,
            Scenario::Overflow => MAX_ACTIVE + 1,
            _ => 1,
        };
        for index in 0..count {
            let id = if matches!(self.scenario, Scenario::Overflow) {
                1000 + index as u32
            } else {
                7
            };
            connection
                .emit_signal(
                    destination,
                    PATH,
                    SERVICE,
                    "NotificationClosed",
                    &(id, 2u32),
                )
                .await?;
        }
        if matches!(self.scenario, Scenario::Overflow) {
            // Keep Notify pending until the client reports its resource limit.
            // Ping fences socket receipt, not application consumption: replying
            // here could let reply-first polling bypass the early-buffer limit.
            // The test tears down this isolated bus after checking completion.
            return future::pending().await;
        }
        if matches!(self.scenario, Scenario::Close) {
            connection
                .emit_signal(
                    destination,
                    PATH,
                    SERVICE,
                    "NotificationClosed",
                    &(42u32, 2u32),
                )
                .await?;
        }
        // First terminal response wins, even if the daemon immediately follows
        // action with close (or sends duplicate activation).
        for _ in 0..2 {
            connection
                .emit_signal(
                    destination,
                    PATH,
                    SERVICE,
                    "ActionInvoked",
                    &(42u32, "default"),
                )
                .await?;
        }
        connection
            .emit_signal(
                destination,
                PATH,
                SERVICE,
                "NotificationClosed",
                &(42u32, 2u32),
            )
            .await?;
        // Round trip to the caller forces its socket reader past the signals
        // before Notify replies. This is an ordering barrier, not a sleep or a
        // manually pre-armed notification listener in the fixture.
        connection
            .call_method(
                header.sender().map(|name| name.as_str()),
                PATH,
                Some("org.freedesktop.DBus.Peer"),
                "Ping",
                &(),
            )
            .await?;
        Ok(42)
    }
}

fn exercise(scenario: Scenario, unicast: bool) -> (Outcome, usize) {
    let bus = Bus::start();
    let address = bus.1.clone();
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        zbus::block_on(async move {
            let calls = Arc::new(AtomicUsize::new(0));
            let _server = Builder::address(address.as_str())
                .unwrap()
                .name(SERVICE)
                .unwrap()
                .serve_at(
                    PATH,
                    Daemon {
                        scenario,
                        unicast,
                        calls: calls.clone(),
                    },
                )
                .unwrap()
                .build()
                .await
                .unwrap();
            let connection = Builder::address(address.as_str())
                .unwrap()
                .build()
                .await
                .unwrap();
            // Enable the standard Peer.Ping endpoint for the ordering barrier.
            // No notification signal subscription is installed by the test.
            let _ = connection.object_server();
            let state = Notifications::default();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let output = seen.clone();
            let pending = state
                .reserve(Box::new(move |outcome| {
                    output.lock().unwrap().push(outcome)
                }))
                .unwrap();
            // The real production operation owns receiver setup, Notify,
            // correlation, terminal callback and capacity release.
            show(Ok(connection), "Title", PREVIEW, pending).await;
            assert_eq!(*state.0.lock().unwrap(), 0);
            let mut seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            tx.send((seen.remove(0), calls.load(Ordering::SeqCst)))
                .unwrap();
        });
    });
    // Deadline is test failure detection only, never notification expiry.
    let result = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("native notification operation did not finish");
    worker.join().unwrap();
    result
}

#[test]
fn click_before_notify_reply_survives_unicast_and_broadcast_and_closes_once() {
    for unicast in [true, false] {
        assert_eq!(exercise(Scenario::Click, unicast), (Outcome::Activated, 1));
    }
}

#[test]
fn markup_servers_receive_escaped_plain_text() {
    assert_eq!(exercise(Scenario::Markup, true), (Outcome::Activated, 1));
}

#[test]
fn dismissal_before_notify_reply_never_becomes_activation() {
    for unicast in [true, false] {
        assert_eq!(exercise(Scenario::Close, unicast), (Outcome::Closed, 1));
    }
}

#[test]
fn pre_reply_burst_drains_beyond_zbus_queue_and_deduplicates_other_ids() {
    assert_eq!(exercise(Scenario::Burst, true), (Outcome::Activated, 1));
}

#[test]
fn distinct_id_overflow_fails_explicitly_and_releases_capacity() {
    let (outcome, calls) = exercise(Scenario::Overflow, false);
    assert_eq!(calls, 1);
    assert!(
        matches!(outcome, Outcome::Failed(error) if error.contains("Too many notification responses"))
    );
}

#[test]
fn unsupported_actions_fail_without_display_and_release_capacity() {
    let (outcome, calls) = exercise(Scenario::Unsupported, true);
    assert_eq!(calls, 0);
    assert!(matches!(outcome, Outcome::Failed(error) if error.contains("does not support clicks")));
}

#[test]
fn notify_error_releases_capacity() {
    let (outcome, calls) = exercise(Scenario::Rejected, true);
    assert_eq!(calls, 1);
    assert!(matches!(outcome, Outcome::Failed(error) if error.contains("Notify rejected")));
}
