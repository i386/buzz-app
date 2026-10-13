//! Loopback-only fixtures. Production refuses loopback; these tests swap in a
//! resolver and address rule so the real request path can reach a local TLS
//! server that presents a certificate for `admin.test`.

use super::attachment::{fetch, replace_with, save_to, AttachmentRef, Use, ATTACHMENT_CAP};
use super::net::{admin_origin, public, Lookup, Net, Resolve};
use super::*;
use base64::engine::general_purpose::STANDARD;
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const RELAY: &str = "https://relay.test";

#[derive(Clone)]
enum Reply {
    Raw(Vec<u8>),
    /// Read the request, then drop the connection without answering.
    Drop,
}

fn reply(status: &str, content_type: &str, body: &str) -> Reply {
    Reply::Raw(
        format!(
            "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes(),
    )
}

#[derive(Debug, Clone)]
struct Seen {
    head: String,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    }
    fn target(&self) -> String {
        self.head.split_whitespace().nth(1).unwrap().to_owned()
    }
}

struct Fixture {
    port: u16,
    root: reqwest::Certificate,
    seen: Arc<Mutex<Vec<Seen>>>,
}

async fn fixture(replies: Vec<Reply>) -> Fixture {
    let cert = rcgen::generate_simple_self_signed(vec!["admin.test".into()]).unwrap();
    let root = reqwest::Certificate::from_der(cert.cert.der()).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![cert.cert.der().clone()],
        rustls::pki_types::PrivateKeyDer::Pkcs8(cert.signing_key.serialize_der().into()),
    )
    .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        for reply in replies {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let Ok(mut tls) = acceptor.accept(tcp).await else {
                continue;
            };
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            let split = loop {
                let n = tls.read(&mut chunk).await.unwrap();
                buffer.extend_from_slice(&chunk[..n]);
                if let Some(at) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                    break at;
                }
            };
            let head = String::from_utf8_lossy(&buffer[..split]).to_string();
            let mut seen = Seen {
                head,
                body: buffer[split + 4..].to_vec(),
            };
            let length: usize = seen
                .header("content-length")
                .map_or(0, |v| v.parse().unwrap());
            while seen.body.len() < length {
                let n = tls.read(&mut chunk).await.unwrap();
                seen.body.extend_from_slice(&chunk[..n]);
            }
            log.lock().unwrap().push(seen);
            if let Reply::Raw(bytes) = reply {
                tls.write_all(&bytes).await.unwrap();
                let _ = tls.shutdown().await;
            }
        }
    });
    Fixture { port, root, seen }
}

/// Answers each lookup from a script; `None` is a DNS failure.
struct Script(Mutex<Vec<Option<Vec<IpAddr>>>>);

impl Resolve for Script {
    fn lookup<'a>(&'a self, _host: &'a str, port: u16) -> Lookup<'a> {
        let answer = self.0.lock().unwrap().remove(0);
        Box::pin(async move {
            answer
                .map(|ips| {
                    ips.into_iter()
                        .map(|ip| SocketAddr::new(ip, port))
                        .collect()
                })
                .ok_or_else(|| std::io::Error::other("no such host"))
        })
    }
}

fn loopback_only(ip: IpAddr) -> bool {
    ip.is_loopback()
}

fn net(fixture: &Fixture, answers: Vec<Option<Vec<IpAddr>>>) -> Net {
    let mut net = Net::custom(Arc::new(Script(Mutex::new(answers))), loopback_only);
    net.root = Some(fixture.root.clone());
    net
}

fn lo() -> Option<Vec<IpAddr>> {
    Some(vec!["127.0.0.1".parse().unwrap()])
}

/// The fixture's origin passes the production syntax rule; only the address
/// rule is relaxed in tests.
fn origin(fixture: &Fixture) -> String {
    format!("https://admin.test:{}", fixture.port)
}

async fn context(host: &IdentityHost, fixture: &Fixture) -> Context {
    Context {
        relay: RELAY.into(),
        origin: origin(fixture),
        signer: host.viewer().await.unwrap(),
    }
}

fn request(value: Value) -> StaffRequest {
    serde_json::from_value(value).unwrap()
}

fn ban(request_id: &str) -> StaffRequest {
    request(json!({
        "route": "directAction", "communityHost": "community.example",
        "action": "ban", "target": "ab".repeat(32), "requestId": request_id,
        "reason": "spam",
    }))
}

const PROBE: &str = r#"{"status":"ok","authMode":"nip98","role":"moderator","source":"db","canAct":true,"canStaff":false}"#;

const ID: &str = "0f5b8f2e-3c1a-4c7e-9a43-2b6f0d1e9a11";

async fn run(
    net: &Net,
    host: &IdentityHost,
    fixture: &Fixture,
    request: &StaffRequest,
) -> Result<Value, Failure> {
    let ctx = context(host, fixture).await;
    execute(net, host, &ctx, Some(origin(fixture)), request).await
}

#[tokio::test]
async fn answer_changing_from_allowed_to_private_is_refused_at_the_request() {
    let fixture = fixture(vec![reply("200 OK", "application/json", PROBE); 2]).await;
    let net = net(
        &fixture,
        vec![lo(), Some(vec!["10.0.0.7".parse().unwrap()])],
    );
    let host = IdentityHost::fixture();
    let probe = request(json!({ "route": "probe" }));
    assert!(run(&net, &host, &fixture, &probe).await.is_ok());
    let failure = run(&net, &host, &fixture, &probe).await.unwrap_err();
    assert_eq!(failure.category, Category::NotSent);
    assert!(failure.not_sent);
    assert_eq!(fixture.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn any_disallowed_answer_in_a_mixed_set_is_refused() {
    let fixture = fixture(vec![]).await;
    let mixed = Some(vec![
        "127.0.0.1".parse().unwrap(),
        "192.168.1.2".parse().unwrap(),
    ]);
    let net = net(&fixture, vec![mixed]);
    let host = IdentityHost::fixture();
    let failure = run(&net, &host, &fixture, &request(json!({ "route": "probe" })))
        .await
        .unwrap_err();
    assert!(failure.not_sent);
}

#[tokio::test]
async fn dns_failure_and_empty_answers_are_refused() {
    let fixture = fixture(vec![]).await;
    let net = net(&fixture, vec![None, Some(vec![])]);
    let host = IdentityHost::fixture();
    let probe = request(json!({ "route": "probe" }));
    for _ in 0..2 {
        let failure = run(&net, &host, &fixture, &probe).await.unwrap_err();
        assert_eq!(failure.category, Category::NotSent);
    }
    assert!(fixture.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn system_proxy_settings_cannot_redirect_the_connection() {
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    let hits = Arc::new(Mutex::new(0));
    let counter = hits.clone();
    tokio::spawn(async move {
        while proxy.accept().await.is_ok() {
            *counter.lock().unwrap() += 1;
        }
    });
    let fixture = fixture(vec![reply("200 OK", "application/json", PROBE)]).await;
    let net = net(&fixture, vec![lo()]);
    let host = IdentityHost::fixture();
    let ctx = context(&host, &fixture).await;
    // Proxy variables are read when a client is built; restore them at once.
    let names = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
    let saved: Vec<_> = names.iter().map(std::env::var_os).collect();
    names.iter().for_each(|n| std::env::set_var(n, &proxy_url));
    let client = net.client(&admin_origin(&ctx.origin).unwrap()).await;
    for (name, value) in names.iter().zip(saved) {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
    let response = client
        .unwrap()
        .get(format!("{}/api/admin/v1/probe", ctx.origin))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(*hits.lock().unwrap(), 0);
    assert_eq!(fixture.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn signature_binds_the_exact_url_method_and_body() {
    let fixture = fixture(vec![
        reply(
            "202 Accepted",
            "application/json",
            r#"{"state":"pending","actionId":"a","replayed":false}"#,
        ),
        reply(
            "200 OK",
            "application/json",
            r#"{"items":[],"nextCursor":null}"#,
        ),
    ])
    .await;
    let net = net(&fixture, vec![lo(), lo()]);
    let host = IdentityHost::fixture();
    run(&net, &host, &fixture, &ban(ID)).await.unwrap();
    let search = request(json!({
        "route": "searchMembers", "communityHost": "community.example", "q": "a b&c",
    }));
    run(&net, &host, &fixture, &search).await.unwrap();
    let seen = fixture.seen.lock().unwrap().clone();
    for (seen, method) in seen.iter().zip(["POST", "GET"]) {
        let token = seen.header("authorization").unwrap();
        let event: nostr::event::Event = serde_json::from_slice(
            &STANDARD
                .decode(token.strip_prefix("Nostr ").unwrap())
                .unwrap(),
        )
        .unwrap();
        event.verify().unwrap();
        assert_eq!(event.kind.as_u16(), 27235);
        assert_eq!(event.pubkey.to_hex(), host.viewer().await.unwrap());
        let tag = |name: &str| {
            event.tags.iter().find_map(|t| {
                let t = t.as_slice();
                (t[0] == name).then(|| t[1].clone())
            })
        };
        assert_eq!(
            tag("u").unwrap(),
            format!("{}{}", origin(&fixture), seen.target())
        );
        assert_eq!(tag("method").unwrap(), method);
        assert_eq!(
            tag("payload").unwrap(),
            format!("{:x}", Sha256::digest(&seen.body))
        );
        assert!(tag("nonce").is_some());
    }
    assert_eq!(
        seen[0].target(),
        format!(
            "/api/admin/v1/members/{}/ban?communityHost=community.example",
            "ab".repeat(32)
        )
    );
    let body: Value = serde_json::from_slice(&seen[0].body).unwrap();
    assert_eq!(body, json!({ "requestId": ID, "reason": "spam" }));
    assert_eq!(
        seen[1].target(),
        "/api/admin/v1/members/search?communityHost=community.example&q=a+b%26c"
    );
    assert!(seen[1].body.is_empty());
}

#[tokio::test]
async fn a_lost_write_response_is_ambiguous_and_the_retry_keeps_its_request_id() {
    let fixture = fixture(vec![
        Reply::Drop,
        reply("502 Bad Gateway", "application/json", ""),
        Reply::Raw(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 40\r\n\r\n{\"state\"".to_vec()),
        reply("200 OK", "application/json", r#"{"state":"succeeded","actionId":"a","replayed":true}"#),
    ])
    .await;
    let net = net(&fixture, vec![lo(), lo(), lo(), lo()]);
    let host = IdentityHost::fixture();
    let write = ban(ID);
    for _ in 0..3 {
        let failure = run(&net, &host, &fixture, &write).await.unwrap_err();
        assert_eq!(failure.category, Category::Ambiguous);
        assert!(!failure.not_sent);
    }
    let value = run(&net, &host, &fixture, &write).await.unwrap();
    assert_eq!(value["replayed"], true);
    let ids: Vec<Value> = fixture
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|s| serde_json::from_slice::<Value>(&s.body).unwrap()["requestId"].clone())
        .collect();
    assert_eq!(ids, vec![json!(ID); 4]);
}

#[tokio::test]
async fn only_a_complete_empty_404_or_405_is_unsupported() {
    let coded = format!(
        r#"{{"error":{{"code":"not_found","message":"No such member","requestId":"{ID}"}}}}"#
    );
    let fixture = fixture(vec![
        reply("404 Not Found", "text/plain", ""),
        reply("405 Method Not Allowed", "text/plain", ""),
        reply("404 Not Found", "application/json", &coded),
        Reply::Raw(b"HTTP/1.1 404 Not Found\r\ncontent-length: 50\r\n\r\n{".to_vec()),
        reply(
            "409 Conflict",
            "application/json",
            &format!(
                r#"{{"error":{{"code":"request_id_conflict","message":"m","requestId":"{ID}"}}}}"#
            ),
        ),
        reply("403 Forbidden", "application/json", ""),
        reply("401 Unauthorized", "application/json", ""),
        reply("500 Internal Server Error", "application/json", ""),
        reply("200 OK", "text/html", "<html>sign in</html>"),
        Reply::Raw(
            b"HTTP/1.1 302 Found\r\nlocation: https://evil.example/\r\ncontent-length: 0\r\n\r\n"
                .to_vec(),
        ),
    ])
    .await;
    let net = net(&fixture, vec![lo(); 10]);
    let host = IdentityHost::fixture();
    let read = request(json!({
        "route": "getMember", "communityHost": "community.example", "pubkey": "cd".repeat(32),
    }));
    let mut results = Vec::new();
    for _ in 0..10 {
        let f = run(&net, &host, &fixture, &read).await.unwrap_err();
        results.push((f.category, f.body_complete, f.body_empty, f.code));
    }
    use Category::*;
    assert_eq!(
        results,
        vec![
            (Unsupported, true, true, None),
            (Unsupported, true, true, None),
            (Rejected, true, false, Some("not_found".into())),
            (Ambiguous, false, false, None),
            (Rejected, true, false, Some("request_id_conflict".into())),
            (Forbidden, true, true, None),
            (Unauthorized, true, true, None),
            (Ambiguous, true, true, None),
            (Intercepted, false, false, None),
            (Intercepted, false, false, None),
        ]
    );
    assert_eq!(
        fixture.seen.lock().unwrap().len(),
        10,
        "no redirect was followed"
    );
}

#[tokio::test]
async fn a_changed_context_is_refused_before_sending() {
    let fixture = fixture(vec![]).await;
    let net = net(&fixture, vec![lo(); 4]);
    let host = IdentityHost::fixture();
    let ctx = context(&host, &fixture).await;
    let write = ban(ID);
    let moved = execute(
        &net,
        &host,
        &ctx,
        Some("https://other.example".into()),
        &write,
    )
    .await;
    let gone = execute(&net, &host, &ctx, None, &write).await;
    let other = Context {
        signer: "ef".repeat(32),
        ..context(&host, &fixture).await
    };
    let switched = execute(&net, &host, &other, Some(origin(&fixture)), &write).await;
    let local = Context {
        origin: "https://localhost".into(),
        ..context(&host, &fixture).await
    };
    let refused = execute(
        &net,
        &host,
        &local,
        Some("https://localhost".into()),
        &write,
    )
    .await;
    for result in [moved, gone, switched, refused] {
        assert!(result.unwrap_err().not_sent);
    }
    assert!(fixture.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn attachment_fetch_checks_type_size_and_hash() {
    let bytes = b"\x89PNG fake";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let png = || {
        let mut raw = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: {}\r\n\r\n",
            bytes.len()
        )
        .into_bytes();
        raw.extend_from_slice(bytes);
        Reply::Raw(raw)
    };
    let fixture = fixture(vec![png(), png(), reply("200 OK", "application/pdf", "x")]).await;
    let net = net(&fixture, vec![lo(); 3]);
    let host = IdentityHost::fixture();
    let ctx = context(&host, &fixture).await;
    let found = Some(origin(&fixture));
    let attachment = |sha256: &str, mime: &str| AttachmentRef {
        feedback_id: ID.into(),
        sha256: sha256.into(),
        mime: mime.into(),
        size: bytes.len(),
    };
    let ok = fetch(
        &net,
        &host,
        &ctx,
        found.clone(),
        &attachment(&hash, "image/png"),
        Use::Preview,
    )
    .await;
    assert_eq!(ok.unwrap(), bytes);
    let wrong = fetch(
        &net,
        &host,
        &ctx,
        found.clone(),
        &attachment(&"0".repeat(64), "image/png"),
        Use::Save,
    )
    .await;
    assert_eq!(
        wrong.unwrap_err().code.as_deref(),
        Some("attachment_hash_mismatch")
    );
    let typed = fetch(
        &net,
        &host,
        &ctx,
        found.clone(),
        &attachment(&hash, "image/png"),
        Use::Save,
    )
    .await;
    assert_eq!(
        typed.unwrap_err().code.as_deref(),
        Some("attachment_mime_mismatch")
    );
    let preview = fetch(
        &net,
        &host,
        &ctx,
        found,
        &attachment(&hash, "application/pdf"),
        Use::Preview,
    )
    .await;
    assert!(preview.unwrap_err().not_sent, "non-images are save-only");
    let seen = fixture.seen.lock().unwrap();
    assert_eq!(
        seen[0].target(),
        format!("/api/admin/v1/feedback/{ID}/attachments/{hash}")
    );
}

#[test]
fn admin_origin_accepts_only_public_https_origins() {
    for ok in [
        "https://admin.example.com",
        "https://admin.example.com:8443/",
        "https://8.8.8.8",
    ] {
        assert!(admin_origin(ok).is_ok(), "{ok}");
    }
    for bad in [
        "http://admin.example.com",
        "https://localhost",
        "https://relay.localhost",
        "https://printer.local",
        "https://intranet",
        "https://127.0.0.1",
        "https://10.1.2.3",
        "https://[::1]",
        "https://[fd00::1]",
        "https://[::ffff:192.168.0.1]",
        "https://user@admin.example.com",
        "https://admin.example.com/api",
        "https://admin.example.com?x",
    ] {
        assert!(admin_origin(bad).is_err(), "{bad}");
    }
}

#[test]
fn public_addresses_exclude_every_special_range() {
    for ip in ["8.8.8.8", "1.1.1.1", "2606:4700::1111"] {
        assert!(public(ip.parse().unwrap()), "{ip}");
    }
    for ip in [
        "0.1.2.3",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "192.0.0.8",
        "192.0.2.1",
        "192.168.0.1",
        "198.18.0.1",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "64:ff9b::a00:1",
        "2001:db8::1",
        "2001::1",
        "2002:a00:1::",
        "::ffff:10.0.0.1",
    ] {
        assert!(!public(ip.parse().unwrap()), "{ip}");
    }
}

#[test]
fn advertised_admin_api_is_validated() {
    assert_eq!(
        advertised(&json!({ "admin_api": "https://admin.example.com" })).as_deref(),
        Some("https://admin.example.com")
    );
    for info in [
        json!({}),
        json!({ "admin_api": "http://admin.example.com" }),
        json!({ "admin_api": 7 }),
    ] {
        assert_eq!(advertised(&info), None);
    }
}

#[test]
fn routes_build_exact_urls_and_bodies() {
    let origin = admin_origin("https://admin.example.com").unwrap();
    let built = |value: Value| request(value).build(&origin);
    let resolve = built(json!({
        "route": "resolveReport", "id": ID, "action": "timeout", "requestId": ID, "expirationSecs": 60,
    }))
    .unwrap();
    assert_eq!(resolve.method, "POST");
    assert_eq!(
        resolve.url.as_str(),
        format!("https://admin.example.com/api/admin/v1/reports/{ID}/resolve")
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&resolve.body).unwrap(),
        json!({ "action": "timeout", "requestId": ID, "expirationSecs": 60 })
    );
    let list = built(json!({ "route": "listReports", "query": { "status": "open", "scope": "all", "limit": 50 } })).unwrap();
    assert_eq!(list.url.query(), Some("status=open&limit=50&scope=all"));
    let lift = built(json!({ "route": "liftRestriction", "communityHost": "c.example:8443", "kind": "timeout", "pubkey": "ab".repeat(32) })).unwrap();
    assert_eq!(
        (lift.method, lift.url.path()),
        (
            "DELETE",
            format!("/api/admin/v1/members/{}/timeout", "ab".repeat(32)).as_str()
        )
    );
    let feedback =
        built(json!({ "route": "setFeedbackStatus", "id": ID, "status": "archived" })).unwrap();
    assert_eq!(
        (feedback.method, feedback.body),
        ("PATCH", br#"{"status":"archived"}"#.to_vec())
    );
    for bad in [
        json!({ "route": "resolveReport", "id": ID, "action": "ban", "requestId": ID, "expirationSecs": 60 }),
        json!({ "route": "resolveReport", "id": ID, "action": "timeout", "requestId": ID }),
        json!({ "route": "resolveReport", "id": ID, "action": "ban", "requestId": "not-a-uuid" }),
        json!({ "route": "getReport", "id": "../probe" }),
        json!({ "route": "getMember", "communityHost": "c.example/x", "pubkey": "ab".repeat(32) }),
        json!({ "route": "getMember", "communityHost": "c.example", "pubkey": "AB".repeat(32) }),
        json!({ "route": "listRestrictions", "communityHost": "c.example", "limit": 201 }),
        json!({ "route": "searchMembers", "communityHost": "c.example", "q": "" }),
        json!({ "route": "directAction", "communityHost": "c.example", "action": "timeout", "target": "ab".repeat(32), "requestId": ID }),
        json!({ "route": "directAction", "communityHost": "c.example", "action": "delete", "target": "ab".repeat(32), "requestId": ID, "expirationSecs": 5 }),
        // The relay answers 400 to a ban with a duration.
        json!({ "route": "directAction", "communityHost": "c.example", "action": "ban", "target": "ab".repeat(32), "requestId": ID, "expirationSecs": 5 }),
        // The relay caps timeouts at 365 days and report pages at 200.
        json!({ "route": "directAction", "communityHost": "c.example", "action": "timeout", "target": "ab".repeat(32), "requestId": ID, "expirationSecs": 365 * 86400 + 1 }),
        json!({ "route": "listReports", "query": { "limit": 201 } }),
    ] {
        assert!(built(bad.clone()).is_err(), "{bad}");
    }
    assert!(
        serde_json::from_value::<StaffRequest>(json!({ "route": "probe", "path": "/x" })).is_err()
    );
    assert!(serde_json::from_value::<StaffRequest>(json!({ "route": "rawHttp" })).is_err());
}

/// Known non-public addresses plus each registry block's edges.
const REFUSED_ADDRESSES: &[&str] = &[
    "192.88.99.2",
    "192.88.99.0",
    "192.88.99.255",
    "2001:2::1",
    "2001:2:0:ffff::1",
    "3fff::1",
    "3fff:fff:ffff::1",
    "198.19.255.255",
    "100.127.255.255",
    "2001:1ff:ffff::1",
];
const PUBLIC_NEIGHBOURS: &[&str] = &[
    "192.88.98.255",
    "192.88.100.0",
    "198.20.0.0",
    "100.128.0.0",
    "2001:200::1",
    "3fff:1000::1",
];

#[test]
fn reserved_ranges_are_refused_as_literals_and_neighbours_are_not() {
    for ip in REFUSED_ADDRESSES {
        assert!(!public(ip.parse().unwrap()), "{ip}");
        let literal = match ip.parse::<IpAddr>().unwrap() {
            IpAddr::V4(v4) => format!("https://{v4}"),
            IpAddr::V6(v6) => format!("https://[{v6}]"),
        };
        assert!(admin_origin(&literal).is_err(), "{literal}");
    }
    for ip in PUBLIC_NEIGHBOURS {
        assert!(public(ip.parse().unwrap()), "{ip}");
    }
}

#[tokio::test]
async fn reserved_dns_answers_are_refused_by_the_production_rule() {
    let fixture = fixture(vec![]).await;
    let answers = REFUSED_ADDRESSES
        .iter()
        .map(|ip| Some(vec![ip.parse().unwrap()]))
        .collect::<Vec<_>>();
    let mut net = Net::custom(Arc::new(Script(Mutex::new(answers))), public);
    net.root = Some(fixture.root.clone());
    let host = IdentityHost::fixture();
    let probe = request(json!({ "route": "probe" }));
    for ip in REFUSED_ADDRESSES {
        let failure = run(&net, &host, &fixture, &probe).await.unwrap_err();
        assert!(failure.not_sent, "{ip}");
    }
    assert!(fixture.seen.lock().unwrap().is_empty());
}

const PK: &str = "abababababababababababababababababababababababababababababababab";
const REPORT: &str = r#"{"id":"r","communityId":"c","communityHost":"h","reportEventId":"e","reporterPubkey":"p","targetKind":"event","target":"t","reportType":"spam","status":"open","activeAction":null,"createdAt":"2026-01-01T00:00:00Z"}"#;

/// Every route: a valid body, and a misrouted or malformed 2xx.
fn route_bodies() -> Vec<(Value, String, &'static str)> {
    let action = r#"{"id":"a","requestId":"q","actorPubkey":"p","actorRole":"moderator","action":"ban","status":"succeeded","reason":null,"expiresAt":null,"errorMessage":null,"createdAt":"t","updatedAt":"t"}"#;
    let resolution = format!(r#"{{"status":"resolved","activeAction":{action}}}"#);
    let page = |item: &str| format!(r#"{{"items":[{item}],"nextCursor":null}}"#);
    vec![
        (json!({ "route": "probe" }), PROBE.into(), r#"{"gateway":"sign in"}"#),
        (json!({ "route": "listReports", "query": {} }), format!("[{REPORT}]"), r#"{"items":[]}"#),
        (json!({ "route": "getReport", "id": ID }), REPORT.into(), r#"{"id":"r"}"#),
        (json!({ "route": "resolveReport", "id": ID, "action": "ban", "requestId": ID }), resolution.clone(), r#"{"status":"resolved","activeAction":{"status":"teleported"}}"#),
        (json!({ "route": "reopenReport", "id": ID, "requestId": ID }), r#"{"status":"open"}"#.into(), "[]"),
        (json!({ "route": "cancelReport", "id": ID, "actionId": ID }), format!(r#"{{"status":"open","activeAction":{action}}}"#), r#"{"status":"resolved","activeAction":null}"#),
        (json!({ "route": "listFeedback" }), r#"[{"id":"f","communityId":null,"communityHost":null,"submitterPubkey":"p","bodySummary":"b","status":"new","receivedAt":"t"}]"#.into(), r#"[{"id":"f"}]"#),
        (json!({ "route": "getFeedback", "id": ID }), r#"{"id":"f","communityId":null,"communityHost":null,"eventId":"e","submitterPubkey":"p","body":"b","status":"reviewed","tags":[],"eventCreatedAt":"t","receivedAt":"t"}"#.into(), r#"{"id":"f","status":"lost"}"#),
        (json!({ "route": "setFeedbackStatus", "id": ID, "status": "archived" }), r#"{"status":"archived"}"#.into(), r#"{"status":"burned"}"#),
        (json!({ "route": "listOperators" }), r#"[{"pubkey":"p","effectiveRole":"operator","sources":["config"]}]"#.into(), r#"[{"pubkey":"p","effectiveRole":"king","sources":[]}]"#),
        (json!({ "route": "putOperator", "pubkey": PK, "role": "moderator" }), r#"{"pubkey":"p","effectiveRole":"moderator","sources":["db"]}"#.into(), "{}"),
        (json!({ "route": "deleteOperator", "pubkey": PK }), format!(r#"{{"deleted":"{PK}"}}"#), "null"),
        (json!({ "route": "listRestrictions", "communityHost": "c.example" }), page(r#"{"pubkey":"p","banned":true,"banExpiresAt":null,"banReason":null,"mutedUntil":null,"muteReason":null,"actorPubkey":"a","updatedAt":"t"}"#), "[]"),
        (json!({ "route": "liftRestriction", "communityHost": "c.example", "kind": "ban", "pubkey": PK }), String::new(), "{}"),
        (json!({ "route": "directAction", "communityHost": "c.example", "action": "ban", "target": PK, "requestId": ID }), r#"{"state":"succeeded","actionId":"a","replayed":false}"#.into(), r#"{"state":"queued"}"#),
        (json!({ "route": "listCommunities" }), page(r#"{"id":"c","host":"c.example","icon":null}"#), r#"{"items":null}"#),
        (json!({ "route": "searchMembers", "communityHost": "c.example", "q": "a" }), r#"{"items":[{"pubkey":"p","displayName":null,"nip05":null,"avatarUrl":null}]}"#.into(), r#"{"members":[]}"#),
        (json!({ "route": "getMember", "communityHost": "c.example", "pubkey": PK }), r#"{"pubkey":"p","profile":null,"role":null,"banned":false,"mutedUntil":null,"isStaff":false}"#.into(), r#"{"pubkey":"p"}"#),
        (json!({ "route": "getEvent", "communityHost": "c.example", "id": PK }), r#"{"id":"e","authorPubkey":"p","kind":1,"content":"c","createdAt":"t","deletedAt":null,"channelId":null}"#.into(), r#"{"id":"e","kind":"one"}"#),
    ]
}

#[tokio::test]
async fn every_route_accepts_only_its_own_success_shape() {
    let bodies = route_bodies();
    let mut replies = Vec::new();
    for (_, good, bad) in &bodies {
        let status = if good.is_empty() {
            "204 No Content"
        } else {
            "200 OK"
        };
        replies.push(reply(status, "application/json", good));
        replies.push(reply("200 OK", "application/json", bad));
        replies.push(reply("200 OK", "application/json", ""));
    }
    let fixture = fixture(replies).await;
    let net = net(&fixture, vec![lo(); bodies.len() * 3]);
    let host = IdentityHost::fixture();
    for (value, good, _) in bodies {
        let req = request(value.clone());
        assert!(
            run(&net, &host, &fixture, &req).await.is_ok(),
            "valid {value}"
        );
        let bad = run(&net, &host, &fixture, &req).await.unwrap_err();
        assert_eq!(bad.category, Category::Ambiguous, "misrouted {value}");
        let empty = run(&net, &host, &fixture, &req).await;
        if good.is_empty() {
            assert!(empty.is_ok(), "{value}");
        } else {
            let empty = empty.unwrap_err();
            assert_eq!(
                (empty.category, empty.body_empty),
                (Category::Ambiguous, true),
                "empty {value}"
            );
        }
        // Writes stay retryable; a non-success never claims the request unsent.
        assert!(!bad.not_sent);
    }
}

#[tokio::test]
async fn a_gateway_page_after_a_write_keeps_the_write_uncertain() {
    let fixture = fixture(vec![
        reply("502 Bad Gateway", "text/html", "<html>bad gateway</html>"),
        reply("403 Forbidden", "text/html", "<html>access</html>"),
        reply("400 Bad Request", "application/json", r#"{"gateway":"no"}"#),
        reply(
            "200 OK",
            "application/json",
            r#"{"state":"succeeded","actionId":"a","replayed":true}"#,
        ),
    ])
    .await;
    let net = net(&fixture, vec![lo(); 4]);
    let host = IdentityHost::fixture();
    let write = ban(ID);
    for _ in 0..3 {
        let failure = run(&net, &host, &fixture, &write).await.unwrap_err();
        assert_eq!(failure.category, Category::Ambiguous);
        assert!(!failure.not_sent);
    }
    assert_eq!(
        run(&net, &host, &fixture, &write).await.unwrap()["replayed"],
        true
    );
    let seen = fixture.seen.lock().unwrap();
    assert_eq!(seen.len(), 4);
    for s in seen.iter() {
        assert_eq!(s.target(), seen[0].target());
        assert_eq!(s.body, seen[0].body, "same intent and requestId");
    }
}

#[test]
fn every_route_builds_its_url_method_and_cap_and_rejects_bad_input() {
    use super::route::{PROBE_CAP, SUCCESS_CAP};
    let origin = admin_origin("https://admin.example.com").unwrap();
    let b = "/api/admin/v1";
    let table: Vec<(Value, &str, String, Option<&str>)> = vec![
        (json!({"route":"probe"}), "GET", format!("{b}/probe"), None),
        (
            json!({"route":"listReports","query":{"limit":5}}),
            "GET",
            format!("{b}/reports?limit=5"),
            None,
        ),
        (
            json!({"route":"getReport","id":ID}),
            "GET",
            format!("{b}/reports/{ID}"),
            Some("id"),
        ),
        (
            json!({"route":"resolveReport","id":ID,"action":"ban","requestId":ID}),
            "POST",
            format!("{b}/reports/{ID}/resolve"),
            Some("requestId"),
        ),
        (
            json!({"route":"reopenReport","id":ID,"requestId":ID}),
            "POST",
            format!("{b}/reports/{ID}/reopen"),
            Some("id"),
        ),
        (
            json!({"route":"cancelReport","id":ID,"actionId":ID}),
            "POST",
            format!("{b}/reports/{ID}/cancel"),
            Some("actionId"),
        ),
        (
            json!({"route":"listFeedback"}),
            "GET",
            format!("{b}/feedback"),
            None,
        ),
        (
            json!({"route":"getFeedback","id":ID}),
            "GET",
            format!("{b}/feedback/{ID}"),
            Some("id"),
        ),
        (
            json!({"route":"setFeedbackStatus","id":ID,"status":"new"}),
            "PATCH",
            format!("{b}/feedback/{ID}"),
            Some("id"),
        ),
        (
            json!({"route":"listOperators"}),
            "GET",
            format!("{b}/operators"),
            None,
        ),
        (
            json!({"route":"putOperator","pubkey":PK,"role":"operator"}),
            "PUT",
            format!("{b}/operators/{PK}"),
            Some("pubkey"),
        ),
        (
            json!({"route":"deleteOperator","pubkey":PK}),
            "DELETE",
            format!("{b}/operators/{PK}"),
            Some("pubkey"),
        ),
        (
            json!({"route":"listRestrictions","communityHost":"c.example"}),
            "GET",
            format!("{b}/members/restrictions?communityHost=c.example"),
            Some("communityHost"),
        ),
        (
            json!({"route":"liftRestriction","communityHost":"c.example","kind":"ban","pubkey":PK}),
            "DELETE",
            format!("{b}/members/{PK}/ban?communityHost=c.example"),
            Some("pubkey"),
        ),
        (
            json!({"route":"directAction","communityHost":"c.example","action":"delete","target":PK,"requestId":ID}),
            "POST",
            format!("{b}/events/{PK}/delete?communityHost=c.example"),
            Some("target"),
        ),
        (
            json!({"route":"listCommunities","q":"c"}),
            "GET",
            format!("{b}/communities?q=c"),
            None,
        ),
        (
            json!({"route":"searchMembers","communityHost":"c.example","q":"a"}),
            "GET",
            format!("{b}/members/search?communityHost=c.example&q=a"),
            Some("communityHost"),
        ),
        (
            json!({"route":"getMember","communityHost":"c.example","pubkey":PK}),
            "GET",
            format!("{b}/members/{PK}?communityHost=c.example"),
            Some("pubkey"),
        ),
        (
            json!({"route":"getEvent","communityHost":"c.example","id":PK}),
            "GET",
            format!("{b}/events/{PK}?communityHost=c.example"),
            Some("id"),
        ),
    ];
    assert_eq!(table.len(), 19, "one row per route");
    for (value, method, target, id_field) in table {
        let req = request(value.clone());
        let built = req.build(&origin).unwrap();
        let actual = match built.url.query() {
            Some(q) => format!("{}?{q}", built.url.path()),
            None => built.url.path().to_owned(),
        };
        assert_eq!(
            (built.method, actual.as_str()),
            (method, target.as_str()),
            "{value}"
        );
        let cap = if value["route"] == "probe" {
            PROBE_CAP
        } else {
            SUCCESS_CAP
        };
        assert_eq!(built.success_cap, cap, "{value}");
        assert_eq!(req.is_write(), method != "GET", "{value}");
        let mut extra = value.clone();
        extra["unexpected"] = json!(1);
        assert!(
            serde_json::from_value::<StaffRequest>(extra).is_err(),
            "unknown field {value}"
        );
        if let Some(field) = id_field {
            let mut bad = value.clone();
            bad[field] = json!("../probe");
            assert!(request(bad).build(&origin).is_err(), "bad {field} {value}");
        }
    }
}

#[tokio::test]
async fn attachment_size_limit_is_enforced_before_and_while_reading() {
    let fixture = fixture(vec![reply("200 OK", "image/png", "0123456789")]).await;
    let net = net(&fixture, vec![lo()]);
    let host = IdentityHost::fixture();
    let ctx = context(&host, &fixture).await;
    let at = |size| AttachmentRef {
        feedback_id: ID.into(),
        sha256: "0".repeat(64),
        mime: "image/png".into(),
        size,
    };
    for size in [0, ATTACHMENT_CAP + 1] {
        let f = fetch(
            &net,
            &host,
            &ctx,
            Some(origin(&fixture)),
            &at(size),
            Use::Preview,
        )
        .await;
        assert!(f.unwrap_err().not_sent, "{size}");
    }
    let longer = fetch(
        &net,
        &host,
        &ctx,
        Some(origin(&fixture)),
        &at(4),
        Use::Preview,
    )
    .await;
    assert_eq!(
        longer.unwrap_err().code.as_deref(),
        Some("attachment_size_mismatch")
    );
    assert_eq!(fixture.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn previews_are_only_raster_images() {
    let fixture = fixture(vec![]).await;
    let net = net(&fixture, vec![]);
    let host = IdentityHost::fixture();
    let ctx = context(&host, &fixture).await;
    for mime in ["image/svg+xml", "application/pdf"] {
        let attachment = AttachmentRef {
            feedback_id: ID.into(),
            sha256: "0".repeat(64),
            mime: mime.into(),
            size: 4,
        };
        let f = fetch(
            &net,
            &host,
            &ctx,
            Some(origin(&fixture)),
            &attachment,
            Use::Preview,
        )
        .await;
        assert!(f.unwrap_err().not_sent, "{mime}");
    }
    assert!(fixture.seen.lock().unwrap().is_empty());
}

/// Never answers, like a stalled resolver.
struct Stalled;

impl Resolve for Stalled {
    fn lookup<'a>(&'a self, _host: &'a str, _port: u16) -> Lookup<'a> {
        Box::pin(std::future::pending())
    }
}

#[tokio::test(start_paused = true)]
async fn a_stalled_lookup_times_out_as_unresolved() {
    let net = Net::custom(Arc::new(Stalled), loopback_only);
    let origin = Url::parse("https://admin.example").unwrap();
    assert_eq!(
        net.client(&origin).await.unwrap_err(),
        "The admin host could not be resolved"
    );
}

#[test]
fn save_reports_cancellation_success_and_disk_errors() {
    assert_eq!(save_to(None, b"x"), json!({ "state": "cancelled" }));
    let dir = std::env::temp_dir().join(format!("relay-admin-save-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("a.png");
    assert_eq!(
        save_to(Some(Ok(file.clone())), b"bytes"),
        json!({ "state": "saved" })
    );
    assert_eq!(std::fs::read(&file).unwrap(), b"bytes");
    let missing = save_to(Some(Ok(dir.join("no/such/dir/a.png"))), b"x");
    assert_eq!(missing["state"], "failed");
    assert_eq!(missing["failure"]["notSent"], true);
    #[cfg(target_os = "macos")]
    {
        // Gatekeeper checks the saved file because it carries the quarantine flag.
        let mut value = [0u8; 256];
        let path = std::ffi::CString::new(file.to_str().unwrap()).unwrap();
        let size = unsafe {
            libc::getxattr(
                path.as_ptr(),
                c"com.apple.quarantine".as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        assert!(size > 0, "saved attachment has no quarantine flag");
    }
    let not_a_path = save_to(Some(Err("not a file path".into())), b"x");
    assert_eq!(not_a_path["state"], "failed");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn failed_mark_keeps_an_existing_destination_and_removes_only_a_new_file() {
    let dir = std::env::temp_dir().join(format!("relay-admin-replace-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let fail = |_: &std::fs::File, _: &std::path::Path| Err(std::io::Error::other("no streams"));
    let entries = || std::fs::read_dir(&dir).unwrap().count();

    let existing = dir.join("a.png");
    std::fs::write(&existing, b"previous").unwrap();
    assert!(replace_with(&existing, b"new", fail).is_err());
    assert_eq!(std::fs::read(&existing).unwrap(), b"previous");
    assert_eq!(entries(), 1, "a failed save added a file");

    let fresh = dir.join("b.png");
    assert!(replace_with(&fresh, b"new", fail).is_err());
    assert!(!fresh.exists(), "a failed save left the file it created");
    assert_eq!(entries(), 1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn save_overwrites_in_place_keeping_permissions_and_symlinks() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = std::env::temp_dir().join(format!("relay-admin-inplace-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();

    let private = dir.join("private.png");
    std::fs::write(&private, b"previous contents").unwrap();
    std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        save_to(Some(Ok(private.clone())), b"new"),
        json!({ "state": "saved" })
    );
    assert_eq!(std::fs::read(&private).unwrap(), b"new");
    let mode = std::fs::metadata(&private).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);

    let target = dir.join("target.png");
    std::fs::write(&target, b"old").unwrap();
    let link = dir.join("link.png");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert_eq!(
        save_to(Some(Ok(link.clone())), b"through"),
        json!({ "state": "saved" })
    );
    assert!(std::fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(&target).unwrap(), b"through");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn save_through_a_dangling_symlink_fails_without_creating_its_target() {
    let dir = std::env::temp_dir().join(format!("relay-admin-dangling-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let target = dir.join("missing.png");
    let link = dir.join("link.png");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert_eq!(save_to(Some(Ok(link.clone())), b"new")["state"], "failed");
    assert!(std::fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read_link(&link).unwrap(), target);
    assert!(!target.exists(), "a failed save created the symlink target");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn save_over_a_hard_link_updates_every_name() {
    let dir = std::env::temp_dir().join(format!("relay-admin-hardlink-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("a.png");
    let other = dir.join("b.png");
    std::fs::write(&file, b"previous").unwrap();
    std::fs::hard_link(&file, &other).unwrap();
    assert_eq!(
        save_to(Some(Ok(file.clone())), b"new"),
        json!({ "state": "saved" })
    );
    assert_eq!(std::fs::read(&file).unwrap(), b"new");
    assert_eq!(std::fs::read(&other).unwrap(), b"new");
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn bad_nested_fields_and_statuses_are_not_successes() {
    let mut cases = Vec::new();
    for (req, good, _) in route_bodies() {
        let route = req["route"].as_str().unwrap();
        let mut value: Value = if good.is_empty() {
            continue;
        } else {
            serde_json::from_str(&good).unwrap()
        };
        match route {
            "getReport" => {
                value["message"] = json!({"authorPubkey":"a","content":{},"createdAt":"t"});
            }
            "resolveReport" => {
                value["activeAction"]["errorMessage"] = json!({"oops":true});
            }
            "cancelReport" | "reopenReport" => {
                value["status"] = json!("teleported");
            }
            "searchMembers" => {
                value["items"][0]["displayName"] = json!({"oops":true});
            }
            "getMember" => {
                value["role"] = json!({"oops":true});
            }
            _ => continue,
        }
        cases.push((req, value.to_string()));
    }
    let fixture = fixture(
        cases
            .iter()
            .map(|(_, body)| reply("200 OK", "application/json", body))
            .collect(),
    )
    .await;
    let net = net(&fixture, vec![lo(); cases.len()]);
    let host = IdentityHost::fixture();
    let mut admitted = Vec::new();
    for (req, body) in cases {
        let result = run(&net, &host, &fixture, &request(req.clone())).await;
        if result.is_ok() {
            println!("admitted {req}: {body}");
            admitted.push(req["route"].clone());
        }
    }
    assert!(
        admitted.is_empty(),
        "malformed successes admitted: {admitted:?}"
    );
}

/// beta's `ErrorEnvelope`, with its `WWW-Authenticate: Nostr` challenge.
fn beta_error(status: &str, code: &str, challenge: bool) -> Reply {
    let header = if challenge {
        "application/json\r\nwww-authenticate: Nostr"
    } else {
        "application/json"
    };
    let body = format!(r#"{{"error":{{"code":"{code}","message":"m","requestId":"{ID}"}}}}"#);
    reply(status, header, &body)
}

#[tokio::test]
async fn only_the_relays_own_error_envelope_settles_a_sent_write() {
    use Category as C;
    let cases: Vec<(Reply, C)> = vec![
        (
            reply(
                "401 Unauthorized",
                "application/json",
                r#"{"gateway":"session expired"}"#,
            ),
            C::Ambiguous,
        ),
        (
            reply(
                "403 Forbidden",
                "application/json",
                r#"{"gateway":"access denied"}"#,
            ),
            C::Ambiguous,
        ),
        (
            reply("401 Unauthorized", "application/json", ""),
            C::Ambiguous,
        ),
        (reply("403 Forbidden", "application/json", ""), C::Ambiguous),
        // Envelope-looking bodies that are not beta's exact shape.
        (
            reply(
                "409 Conflict",
                "application/json",
                r#"{"error":{"code":"conflict"}}"#,
            ),
            C::Ambiguous,
        ),
        (
            reply(
                "409 Conflict",
                "application/json",
                r#"{"error":{"code":"conflict","message":"m","requestId":"nope"}}"#,
            ),
            C::Ambiguous,
        ),
        (
            reply(
                "409 Conflict",
                "application/json",
                &format!(
                    r#"{{"error":{{"code":"conflict","message":"m","requestId":"{ID}","via":"gw"}}}}"#
                ),
            ),
            C::Ambiguous,
        ),
        (beta_error("409 Conflict", "Conflict!", false), C::Ambiguous),
        (
            beta_error("401 Unauthorized", "unauthorized", false),
            C::Ambiguous,
        ),
        (
            beta_error("401 Unauthorized", "forbidden", true),
            C::Ambiguous,
        ),
        (
            beta_error("403 Forbidden", "unauthorized", false),
            C::Ambiguous,
        ),
        // beta's genuine rejections.
        (
            beta_error("401 Unauthorized", "unauthorized", true),
            C::Unauthorized,
        ),
        (
            beta_error("403 Forbidden", "forbidden", false),
            C::Forbidden,
        ),
        (
            beta_error("409 Conflict", "request_id_conflict", false),
            C::Rejected,
        ),
        (
            beta_error("400 Bad Request", "invalid_action_for_target", false),
            C::Rejected,
        ),
        (
            beta_error("422 Unprocessable Entity", "enforcement_failed", false),
            C::Rejected,
        ),
        (beta_error("404 Not Found", "not_found", false), C::Rejected),
        (reply("404 Not Found", "text/plain", ""), C::Unsupported),
    ];
    let fixture = fixture(cases.iter().map(|(r, _)| r.clone()).collect()).await;
    let net = net(&fixture, vec![lo(); cases.len()]);
    let host = IdentityHost::fixture();
    for (i, (_, want)) in cases.iter().enumerate() {
        let failure = run(&net, &host, &fixture, &ban(ID)).await.unwrap_err();
        assert_eq!(failure.category, *want, "case {i}");
        assert_eq!(
            failure.auth_lost,
            matches!(failure.status, Some(401 | 403)),
            "case {i}"
        );
    }
}

#[tokio::test]
async fn a_read_401_or_403_from_anyone_reports_lost_access() {
    let fixture = fixture(vec![
        reply("401 Unauthorized", "application/json", r#"{"gateway":"x"}"#),
        reply("403 Forbidden", "application/json", ""),
    ])
    .await;
    let net = net(&fixture, vec![lo(); 2]);
    let host = IdentityHost::fixture();
    let probe = request(json!({ "route": "probe" }));
    for want in [Category::Unauthorized, Category::Forbidden] {
        let failure = run(&net, &host, &fixture, &probe).await.unwrap_err();
        assert_eq!((failure.category, failure.auth_lost), (want, true));
    }
}

/// Every field and status a route's DTO defines is checked, nested and
/// nullable ones included; unknown extra fields are not.
#[test]
fn each_dto_field_and_status_is_checked() {
    let bad = |route: &str| -> Vec<(&'static str, Value)> {
        let s = || json!({});
        match route {
            "probe" => vec![
                ("/status", json!("teapot")),
                ("/authMode", json!("x")),
                ("/role", json!("king")),
                ("/source", json!("x")),
                ("/canAct", s()),
                ("/canStaff", json!(null)),
            ],
            "listReports" => vec![
                ("/0/status", json!("lost")),
                ("/0/note", s()),
                ("/0/channelId", s()),
                ("/0/resolvedBy", s()),
                ("/0/actionId", json!(1)),
                ("/0/targetAuthorPubkey", s()),
            ],
            "getReport" => vec![
                (
                    "/message",
                    json!({"authorPubkey":"a","content":{},"createdAt":"t"}),
                ),
                (
                    "/message",
                    json!({"authorPubkey":"a","content":"c","createdAt":"t","deletedAt":{}}),
                ),
                ("/message", json!({"content":"c","createdAt":"t"})),
                ("/resolvedAt", s()),
                ("/activeAction", json!({"status":"succeeded"})),
            ],
            "resolveReport" => vec![
                ("/status", json!("teleported")),
                ("/activeAction/errorMessage", s()),
                ("/activeAction/reason", s()),
                ("/activeAction/expiresAt", json!(5)),
                ("/activeAction/status", json!("x")),
                ("/activeAction/action", json!("x")),
                ("/activeAction/actorRole", json!("x")),
            ],
            "reopenReport" => vec![
                ("/status", json!("teleported")),
                ("/status", json!("resolved")),
            ],
            "cancelReport" => vec![
                ("/status", json!("teleported")),
                ("/status", json!("resolved")),
                ("/activeAction", json!(null)),
                ("/activeAction/errorMessage", s()),
            ],
            "listFeedback" => vec![
                ("/0/status", json!("x")),
                ("/0/category", s()),
                ("/0/communityHost", s()),
            ],
            "getFeedback" => vec![
                ("/status", json!("lost")),
                ("/category", s()),
                ("/communityId", s()),
            ],
            "setFeedbackStatus" => vec![("/status", json!("burned"))],
            "listOperators" => vec![
                ("/0/effectiveRole", json!("king")),
                ("/0/sources", json!(["x"])),
            ],
            "putOperator" => vec![("/effectiveRole", json!("king"))],
            "deleteOperator" => vec![("/deleted", json!(true))],
            "listRestrictions" => vec![
                ("/items/0/banned", json!("yes")),
                ("/items/0/banExpiresAt", s()),
                ("/items/0/banReason", s()),
                ("/items/0/mutedUntil", s()),
                ("/items/0/muteReason", s()),
            ],
            "directAction" => vec![
                ("/state", json!("queued")),
                ("/state", json!("pending")),
                ("/replayed", json!("no")),
                ("/actionId", json!(null)),
            ],
            "listCommunities" => vec![("/items/0/icon", s()), ("/items/0/host", json!(null))],
            "searchMembers" => vec![
                ("/items/0/displayName", s()),
                ("/items/0/nip05", s()),
                ("/items/0/avatarUrl", s()),
            ],
            "getMember" => vec![
                ("/role", s()),
                ("/role", json!("king")),
                ("/profile", json!({"displayName":{}})),
                ("/profile", json!({"about":1})),
                ("/mutedUntil", s()),
                ("/isStaff", json!("no")),
            ],
            "getEvent" => vec![
                ("/deletedAt", s()),
                ("/channelId", s()),
                ("/kind", json!("one")),
            ],
            _ => vec![],
        }
    };
    for (req, good, _) in route_bodies() {
        let route = req["route"].as_str().unwrap().to_owned();
        let req = request(req);
        if good.is_empty() {
            assert!(shape::valid(&req, 204, None), "{route}");
            continue;
        }
        let good: Value = serde_json::from_str(&good).unwrap();
        let mut extra = good.clone();
        if let Some(o) = extra.as_object_mut() {
            o.insert("futureField".into(), json!({"any": 1}));
        }
        assert!(shape::valid(&req, 200, Some(&good)), "{route}");
        assert!(shape::valid(&req, 200, Some(&extra)), "{route} extra field");
        let cases = bad(&route);
        assert!(!cases.is_empty(), "{route} has no corruption cases");
        for (pointer, value) in cases {
            let mut body = good.clone();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            let slot = body
                .pointer_mut(parent)
                .unwrap_or_else(|| panic!("{route}{pointer}"));
            match slot {
                Value::Array(a) => a[key.parse::<usize>().unwrap()] = value.clone(),
                other => other[key] = value.clone(),
            }
            assert!(
                !shape::valid(&req, 200, Some(&body)),
                "{route}{pointer} = {value}"
            );
        }
    }
    // A direct action's state must match its status: 200 succeeded, 202 pending.
    let direct = request(
        json!({ "route": "directAction", "communityHost": "c.example", "action": "ban", "target": PK, "requestId": ID }),
    );
    let pending = json!({"state":"pending","actionId":"a","replayed":false});
    let succeeded = json!({"state":"succeeded","actionId":"a","replayed":true});
    assert!(shape::valid(&direct, 202, Some(&pending)));
    assert!(!shape::valid(&direct, 200, Some(&pending)));
    assert!(!shape::valid(&direct, 202, Some(&succeeded)));
    // Only lifting a restriction may be empty.
    assert!(!shape::valid(&direct, 204, None));
}

#[tokio::test]
async fn every_non_global_registry_boundary_is_refused_as_literal_and_dns() {
    let addresses = [
        "0.0.0.0",
        "0.255.255.255",
        "10.0.0.0",
        "10.255.255.255",
        "100.64.0.0",
        "100.127.255.255",
        "127.0.0.0",
        "127.255.255.255",
        "169.254.0.0",
        "169.254.255.255",
        "172.16.0.0",
        "172.31.255.255",
        "192.0.0.0",
        "192.0.0.255",
        "192.0.0.7",
        "192.0.0.8",
        "192.0.0.170",
        "192.0.0.171",
        "192.0.2.0",
        "192.0.2.255",
        "192.88.99.0",
        "192.88.99.255",
        "192.88.99.2",
        "192.168.0.0",
        "192.168.255.255",
        "198.18.0.0",
        "198.19.255.255",
        "198.51.100.0",
        "198.51.100.255",
        "203.0.113.0",
        "203.0.113.255",
        "240.0.0.0",
        "255.255.255.255",
        "::1",
        "::",
        "::ffff:0.0.0.0",
        "::ffff:255.255.255.255",
        "64:ff9b:1::",
        "64:ff9b:1:ffff:ffff:ffff:ffff:ffff",
        "100::",
        "100::ffff:ffff:ffff:ffff",
        "100:0:0:1::",
        "100::1:ffff:ffff:ffff:ffff",
        "2001::",
        "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff",
        "2001:0:ffff:ffff:ffff:ffff:ffff:ffff",
        "2001:2::",
        "2001:2:0:ffff:ffff:ffff:ffff:ffff",
        "2001:10::",
        "2001:1f:ffff:ffff:ffff:ffff:ffff:ffff",
        "2001:db8::",
        "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
        "2002::",
        "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
        "3fff::",
        "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
        "5f00::",
        "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
        "fc00::",
        "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
        "fe80::",
        "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ];
    let fixture = fixture(vec![]).await;
    let answers = addresses
        .iter()
        .map(|ip| Some(vec![ip.parse().unwrap()]))
        .collect();
    let net = Net::custom(Arc::new(Script(Mutex::new(answers))), public);
    let host = IdentityHost::fixture();
    let probe = request(json!({"route":"probe"}));
    for ip in addresses {
        let addr: IpAddr = ip.parse().unwrap();
        assert!(!public(addr), "predicate {ip}");
        let literal = match addr {
            IpAddr::V4(v) => format!("https://{v}"),
            IpAddr::V6(v) => format!("https://[{v}]"),
        };
        assert!(admin_origin(&literal).is_err(), "literal {ip}");
        assert!(
            run(&net, &host, &fixture, &probe)
                .await
                .unwrap_err()
                .not_sent,
            "dns {ip}"
        );
    }
    assert!(fixture.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn reserved_addresses_and_malformed_successes_are_refused() {
    for ip in ["192.88.99.2", "2001:2::1", "2001:1::4", "3fff::1"] {
        assert!(!public(ip.parse().unwrap()), "still accepts {ip}");
        let literal = if ip.contains(':') {
            format!("https://[{ip}]")
        } else {
            format!("https://{ip}")
        };
        assert!(admin_origin(&literal).is_err());
    }
    let fixture = fixture(vec![
        reply("200 OK", "application/json", r#"{"gateway":"sign in"}"#),
        reply("200 OK", "application/json", r#"{"state":"not-an-action"}"#),
        reply("204 No Content", "application/json", ""),
    ])
    .await;
    let net = net(&fixture, vec![lo(); 3]);
    let host = IdentityHost::fixture();
    let probe = request(json!({"route":"probe"}));
    for request in [&probe, &ban(ID), &ban(ID)] {
        assert_eq!(
            run(&net, &host, &fixture, request)
                .await
                .unwrap_err()
                .category,
            Category::Ambiguous
        );
    }
}

#[tokio::test]
async fn valid_reason_must_fit_betas_body_limit() {
    // An over-limit body is refused before signing instead of being sent
    // and held as ambiguous.
    let req = request(
        json!({"route":"resolveReport","id":ID,"action":"timeout","requestId":ID,"reason":"😀".repeat(1000),"expirationSecs":3600}),
    );
    let fixture = fixture(vec![reply(
        "413 Payload Too Large",
        "text/plain",
        "length limit exceeded",
    )])
    .await;
    let net = net(&fixture, vec![lo()]);
    let host = IdentityHost::fixture();
    let failure = run(&net, &host, &fixture, &req).await.unwrap_err();
    assert!(failure.not_sent, "{failure:?}");
    assert_eq!(failure.message, "Reason is too long");
    assert!(fixture.seen.lock().unwrap().is_empty(), "nothing was sent");
}

/// Resolve is the only route a valid reason can push past the limit: test it
/// at exactly 4,096 bytes and one over, with multi-byte characters and JSON escapes in the reason.
#[test]
fn write_bodies_are_capped_at_betas_limit_in_bytes() {
    let origin = Url::parse("https://admin.test").unwrap();
    let routes = [
        json!({"route":"resolveReport","id":ID,"action":"timeout","requestId":ID,"expirationSecs":3600}),
    ];
    for base in routes {
        let with = |reason: String| {
            let mut v = base.clone();
            v["reason"] = json!(reason);
            request(v).build(&origin)
        };
        // Escapes ("\"" and "\\" become 2 bytes), 2- and 4-byte characters.
        let mut hit = None;
        'search: for prefix in ["\"\\é", "\"\\", "\"é", "\\é", "\"", "\\"] {
            for emoji in (0..=997).rev() {
                for ascii in 0..=3 {
                    let reason = format!("{prefix}{}{}", "😀".repeat(emoji), "a".repeat(ascii));
                    if reason.chars().count() < 1000
                        && with(reason.clone()).map(|b| b.body.len()) == Ok(route::BODY_MAX)
                    {
                        hit = Some(reason);
                        break 'search;
                    }
                }
            }
        }
        let at_limit = hit.unwrap_or_else(|| panic!("no 4096-byte reason for {base}"));
        assert!(with(at_limit.clone()).is_ok(), "{base}");
        let over = with(format!("{at_limit}\""));
        assert_eq!(
            over.map(|b| b.body.len()),
            Err("Reason is too long".into()),
            "{base}"
        );
        let over = with(format!("{at_limit}a"));
        assert!(over.is_err(), "{base}");
    }
    // Every other body-bearing route stays under the limit even with its
    // widest valid input; the cap still guards them.
    let widest = "😀".repeat(1000);
    for v in [
        json!({"route":"reopenReport","id":ID,"requestId":ID,"reason":widest}),
        json!({"route":"directAction","communityHost":"c.example","action":"timeout","target":PK,"requestId":ID,"expirationSecs":31_536_000,"reason":widest}),
        json!({"route":"cancelReport","id":ID,"actionId":ID}),
        json!({"route":"setFeedbackStatus","id":ID,"status":"archived"}),
        json!({"route":"putOperator","pubkey":PK,"role":"moderator"}),
    ] {
        let built = request(v.clone()).build(&origin).unwrap();
        assert!(
            !built.body.is_empty() && built.body.len() <= route::BODY_MAX,
            "{v}"
        );
    }
}

#[tokio::test]
async fn every_received_401_or_403_reports_lost_access() {
    let html = |s: &str| reply(s, "text/html", "<html>Sign in</html>");
    let cut = |s: &str| {
        Reply::Raw(format!("HTTP/1.1 {s}\r\ncontent-type: application/json\r\ncontent-length: 999\r\nconnection: close\r\n\r\n{{}}").into_bytes())
    };
    let big = |s: &str| {
        reply(
            s,
            "application/json",
            &format!("\"{}\"", "x".repeat(route::ERROR_CAP + 1)),
        )
    };
    let mut replies = Vec::new();
    for status in ["401 Unauthorized", "403 Forbidden"] {
        replies.extend([html(status), cut(status), big(status)]);
    }
    // Once through the request path, once through the attachment path.
    let all: Vec<Reply> = replies
        .iter()
        .cloned()
        .chain(replies.iter().cloned())
        .collect();
    let fixture = fixture(all).await;
    let net = net(&fixture, vec![lo(); replies.len() * 2]);
    let host = IdentityHost::fixture();
    for i in 0..replies.len() {
        let failure = run(&net, &host, &fixture, &ban(ID)).await.unwrap_err();
        assert_eq!(
            (failure.category, failure.auth_lost),
            (Category::Ambiguous, true),
            "request {i}: {failure:?}"
        );
    }
    let ctx = context(&host, &fixture).await;
    let attachment = AttachmentRef {
        feedback_id: ID.into(),
        sha256: "ab".repeat(32),
        mime: "image/png".into(),
        size: 4,
    };
    for i in 0..replies.len() {
        let failure = fetch(
            &net,
            &host,
            &ctx,
            Some(origin(&fixture)),
            &attachment,
            Use::Preview,
        )
        .await
        .unwrap_err();
        assert!(failure.auth_lost, "attachment {i}: {failure:?}");
        assert!(matches!(failure.status, Some(401 | 403)), "attachment {i}");
    }
}
