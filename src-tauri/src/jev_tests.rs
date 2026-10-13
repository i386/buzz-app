use super::*;
use std::sync::Mutex as StdMutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Default)]
struct FakeStore {
    key: StdMutex<Option<String>>,
    reads: StdMutex<usize>,
    /// Reads fail, as a locked or refused Keychain does.
    unreadable: StdMutex<bool>,
    /// Reads block this long, as a stalled `security` process does.
    stall: StdMutex<Duration>,
}
impl KeyStore for Arc<FakeStore> {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        *self.reads.lock().unwrap() += 1;
        std::thread::sleep(*self.stall.lock().unwrap());
        if *self.unreadable.lock().unwrap() {
            return Err("locked".into());
        }
        Ok(self.key.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn replace(&self, key: &str) -> Result<(), String> {
        *self.key.lock().unwrap() = Some(key.into());
        Ok(())
    }
    fn clear(&self) -> Result<(), String> {
        *self.key.lock().unwrap() = None;
        Ok(())
    }
}

/// A one-connection-per-response HTTP server. Returns its URL and the requests it saw.
async fn server(
    responses: Vec<(u16, &'static str, String)>,
) -> (String, Arc<StdMutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/systemone", listener.local_addr().unwrap());
    let seen = Arc::new(StdMutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        for (status, headers, body) in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            log.lock()
                .unwrap()
                .push(String::from_utf8_lossy(&request).to_string());
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n{headers}\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
        }
    });
    (url, seen)
}

fn host(store: &Arc<FakeStore>, url: String, timeout: Duration) -> JevHost {
    JevHost::with(Box::new(store.clone()), url, timeout)
}
fn keyed(key: &str) -> Arc<FakeStore> {
    let store = Arc::new(FakeStore::default());
    *store.key.lock().unwrap() = Some(key.into());
    store
}
const OK: &str = r#"{"model":"jev-1.13.0","answers":{"asks":{"type":"noul","noul":0.9}}}"#;

#[tokio::test]
async fn sends_the_key_and_pinned_model_and_returns_only_answers() {
    let (url, seen) = server(vec![(200, "", OK.into())]).await;
    let store = keyed("test-key-do-not-use");
    let result = host(&store, url, TIMEOUT)
        .classify(
            serde_json::json!({"event": {"content": "hi"}}),
            serde_json::json!({"asks": {"type": "noul"}}),
        )
        .await;
    assert_eq!(
        result,
        Classified::Answered {
            answers: serde_json::json!({"asks": {"type": "noul", "noul": 0.9}})
        }
    );
    let request = seen.lock().unwrap()[0].clone();
    assert!(request
        .to_ascii_lowercase()
        .contains("authorization: bearer test-key-do-not-use")); // sadscan:disable np.http.2 (fake test key)
    assert!(request.contains(r#""model":"jev-1.13.0""#));
    // The result the webview gets has no key.
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("test-key-do-not-use"));
}

#[tokio::test]
async fn without_a_key_nothing_is_sent() {
    let (url, seen) = server(vec![]).await;
    let store = Arc::new(FakeStore::default());
    let host = host(&store, url, TIMEOUT);
    assert!(!host.configured().await.unwrap());
    let result = host
        .classify(serde_json::json!({}), serde_json::json!({}))
        .await;
    assert_eq!(
        result,
        Classified::Failed {
            reason: Failure::MissingCredentials
        }
    );
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn set_and_clear_take_effect_without_reading_the_keychain_again() {
    let store = Arc::new(FakeStore::default());
    let host = host(&store, "http://127.0.0.1:9/".into(), TIMEOUT);
    assert!(!host.configured().await.unwrap());
    host.set("  tk_new  ").await.unwrap();
    assert!(host.configured().await.unwrap());
    assert_eq!(store.key.lock().unwrap().as_deref(), Some("tk_new"));
    host.clear().await.unwrap();
    assert!(!host.configured().await.unwrap());
    assert_eq!(*store.reads.lock().unwrap(), 1);
}

#[tokio::test]
async fn refuses_a_key_that_is_not_one_printable_token() {
    let store = Arc::new(FakeStore::default());
    let host = host(&store, "http://127.0.0.1:9/".into(), TIMEOUT);
    for bad in ["", "a b", "a\nb", "a\u{e9}b", &"x".repeat(513)] {
        assert!(host.set(bad).await.is_err(), "{bad:?}");
    }
    assert!(store.key.lock().unwrap().is_none());
}

#[tokio::test]
async fn a_failed_call_is_not_retried() {
    for status in [429, 500, 503] {
        let (url, seen) = server(vec![
            (status, "retry-after: 0\r\n", String::new()),
            (200, "", OK.into()),
        ])
        .await;
        let result = host(&keyed("k"), url, TIMEOUT)
            .classify(serde_json::json!({}), serde_json::json!({}))
            .await;
        assert_eq!(
            result,
            Classified::Failed {
                reason: Failure::ServiceError
            },
            "{status}"
        );
        assert_eq!(seen.lock().unwrap().len(), 1, "{status}");
    }
}

#[tokio::test]
async fn a_refused_key_is_reported_as_unauthorized() {
    for status in [401, 403] {
        let (url, seen) = server(vec![(status, "", String::new())]).await;
        let result = host(&keyed("k"), url, TIMEOUT)
            .classify(serde_json::json!({}), serde_json::json!({}))
            .await;
        assert_eq!(
            result,
            Classified::Failed {
                reason: Failure::Unauthorized
            },
            "{status}"
        );
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn rejects_another_model_a_missing_answers_object_and_an_oversized_response() {
    for body in [
        r#"{"model":"jev-2","answers":{}}"#.to_string(),
        r#"{"model":"jev-1.13.0"}"#.to_string(),
        "not json".to_string(),
        format!(
            r#"{{"model":"jev-1.13.0","answers":{{"a":"{}"}}}}"#,
            "x".repeat(RESPONSE_LIMIT)
        ),
    ] {
        let (url, _) = server(vec![(200, "", body)]).await;
        let result = host(&keyed("k"), url, TIMEOUT)
            .classify(serde_json::json!({}), serde_json::json!({}))
            .await;
        assert_eq!(
            result,
            Classified::Failed {
                reason: Failure::InvalidResponse
            }
        );
    }
}

#[tokio::test]
async fn an_oversized_request_is_not_sent() {
    let (url, seen) = server(vec![]).await;
    let big = "x".repeat(INPUT_LIMIT);
    let result = host(&keyed("k"), url, TIMEOUT)
        .classify(serde_json::json!({ "event": big }), serde_json::json!({}))
        .await;
    assert_eq!(
        result,
        Classified::Failed {
            reason: Failure::InputLimit
        }
    );
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_silent_server_times_out() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let (_socket, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
    });
    let result = host(&keyed("k"), url, Duration::from_millis(200))
        .classify(serde_json::json!({}), serde_json::json!({}))
        .await;
    assert_eq!(
        result,
        Classified::Failed {
            reason: Failure::Timeout
        }
    );
}

#[tokio::test]
async fn an_unreadable_keychain_is_not_a_missing_key_and_is_read_again() {
    let (url, seen) = server(vec![(200, "", OK.into())]).await;
    let store = keyed("k");
    *store.unreadable.lock().unwrap() = true;
    let host = host(&store, url, TIMEOUT);
    assert!(host.configured().await.is_err());
    // Not "missing", so the app does not turn the classifier off.
    assert_eq!(
        host.classify(serde_json::json!({}), serde_json::json!({}))
            .await,
        Classified::Failed {
            reason: Failure::ServiceError
        }
    );
    *store.unreadable.lock().unwrap() = false;
    assert!(matches!(
        host.classify(serde_json::json!({}), serde_json::json!({}))
            .await,
        Classified::Answered { .. }
    ));
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_refused_key_is_read_again_so_an_outside_removal_is_seen() {
    let (url, seen) = server(vec![(401, "", "{}".into())]).await;
    let store = keyed("k");
    let host = host(&store, url, TIMEOUT);
    assert_eq!(
        host.classify(serde_json::json!({}), serde_json::json!({}))
            .await,
        Classified::Failed {
            reason: Failure::Unauthorized
        }
    );
    *store.key.lock().unwrap() = None;
    assert_eq!(
        host.classify(serde_json::json!({}), serde_json::json!({}))
            .await,
        Classified::Failed {
            reason: Failure::MissingCredentials
        }
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(*store.reads.lock().unwrap(), 2);
}

#[tokio::test]
async fn a_stalled_keychain_read_is_inside_the_deadline() {
    let store = keyed("k");
    *store.stall.lock().unwrap() = Duration::from_secs(2);
    let started = Instant::now();
    let result = host(
        &store,
        "http://127.0.0.1:9/".into(),
        Duration::from_millis(200),
    )
    .classify(serde_json::json!({}), serde_json::json!({}))
    .await;
    assert_eq!(
        result,
        Classified::Failed {
            reason: Failure::Timeout
        }
    );
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn failures_serialize_as_janet_reasons() {
    let value = serde_json::to_value(Classified::Failed {
        reason: Failure::MissingCredentials,
    })
    .unwrap();
    assert_eq!(
        value,
        serde_json::json!({"outcome": "failed", "reason": "missing_credentials"})
    );
    assert_eq!(
        serde_json::to_value(Failure::Unauthorized).unwrap(),
        serde_json::json!("unauthorized")
    );
}

/// Calls the real Jev service. Run with
/// `TYPESAFE_API_KEY=… cargo test jev::tests::live -- --ignored`.
#[tokio::test]
#[ignore = "calls the live TypeSafe service; needs TYPESAFE_API_KEY"]
async fn live_jev_answers_each_question() {
    let Ok(key) = std::env::var("TYPESAFE_API_KEY") else {
        panic!("set TYPESAFE_API_KEY to run the live Jev test");
    };
    let jev = host(&keyed(&key), ENDPOINT.into(), TIMEOUT);
    let questions = serde_json::json!({
        "deploy": {
            "type": "noul",
            "instructions": { "question": "Is this message about a deployment?" },
            "criteria": {
                "true": "The message is about deploying software.",
                "false": "The message is not about deploying software.",
            },
        },
    });
    let state = serde_json::json!({
        "event": { "kind": 9, "content": "Deploying v2 to production now." },
        "author": { "role": "other", "name": null },
    });
    match jev.classify(state, questions).await {
        Classified::Answered { answers } => {
            let p = answers["deploy"]["noul"].as_f64().expect("a noul answer");
            assert!((0.0..=1.0).contains(&p), "probability {p}");
        }
        other => panic!("Jev did not answer: {other:?}"),
    }
}
