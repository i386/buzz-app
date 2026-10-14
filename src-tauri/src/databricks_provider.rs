//! One shared Databricks connection. Credentials never enter the renderer or
//! Goose's config. Goose's command-auth adapter reads fresh access tokens here.
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zeroize::Zeroize;

const HOST: &str = "https://block-lakehouse-production.cloud.databricks.com";
const CLIENT_ID: &str = "databricks-cli";
type Result<T> = std::result::Result<T, String>;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Credential {
    access: String,
    refresh: String,
    expires: u64,
}
impl Drop for Credential {
    fn drop(&mut self) {
        self.access.zeroize();
        self.refresh.zeroize();
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
fn directory() -> Result<PathBuf> {
    let dir = dirs::data_local_dir()
        .ok_or("Provider storage is unavailable")?
        .join("buzz")
        .join("providers")
        .join("databricks");
    private_directory(&dir)?;
    Ok(dir)
}
fn private_directory(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).map_err(|_| "Could not create provider storage")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect provider storage")?;
    }
    Ok(())
}
async fn lock(dir: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(dir.join("credential.lock"))
        .map_err(|_| "Could not lock provider storage")?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => return Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if tokio::time::Instant::now() >= deadline {
                    return Err("Databricks is busy. Try again.".into());
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(_) => return Err("Could not lock provider storage".into()),
        }
    }
}
fn read(dir: &Path) -> Result<Option<Credential>> {
    use std::io::Read;
    match File::open(dir.join("credential.json")) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(64 * 1024)
                .read_to_end(&mut bytes)
                .map_err(|_| "Could not read Databricks credentials")?;
            if bytes.len() == 64 * 1024 {
                bytes.zeroize();
                return Err("Saved Databricks credentials are too large".into());
            }
            let result = serde_json::from_slice(&bytes)
                .map_err(|_| "Saved Databricks credentials are invalid. Sign in again.".into());
            bytes.zeroize();
            result.map(Some)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read Databricks credentials".into()),
    }
}
fn write(dir: &Path, value: &Credential) -> Result<()> {
    let mut bytes =
        serde_json::to_vec(value).map_err(|_| "Could not encode provider credentials")?;
    let result = write_file(dir.join("credential.json"), &bytes);
    bytes.zeroize();
    result
}
pub(super) fn write_file(path: PathBuf, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let parent = path.parent().ok_or("Invalid provider storage")?;
    private_directory(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Could not save provider configuration")?;
    file.write_all(bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Could not save provider configuration")?;
    file.persist(path)
        .map_err(|_| "Could not save provider configuration")?;
    Ok(())
}
fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not create the Databricks client".into())
}
async fn body(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Databricks returned HTTP {}. Check your connection or sign in again.",
            status.as_u16()
        ));
    }
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Could not read Databricks response")?;
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("Databricks response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let result =
        serde_json::from_slice(&bytes).map_err(|_| "Databricks returned invalid JSON".into());
    bytes.zeroize();
    result
}
async fn oidc(client: &reqwest::Client) -> Result<Value> {
    body(
        client
            .get(format!(
                "{HOST}/oidc/.well-known/oauth-authorization-server"
            ))
            .send()
            .await
            .map_err(|_| "Could not reach Databricks")?,
    )
    .await
}
fn endpoint(value: &Value, key: &str) -> Result<String> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or("Invalid Databricks OAuth configuration")?;
    let url = url::Url::parse(text).map_err(|_| "Invalid Databricks OAuth configuration")?;
    if url.origin().ascii_serialization() != HOST
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid Databricks OAuth origin".into());
    }
    Ok(text.into())
}
async fn exchange(
    client: &reqwest::Client,
    fields: &[(&str, &str)],
    old_refresh: &str,
) -> Result<Credential> {
    let url = endpoint(&oidc(client).await?, "token_endpoint")?;
    grant(client, &url, fields, old_refresh).await
}
async fn grant(
    client: &reqwest::Client,
    url: &str,
    fields: &[(&str, &str)],
    old_refresh: &str,
) -> Result<Credential> {
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(fields.iter().copied())
        .finish();
    let response = client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(encoded)
        .send()
        .await
        .map_err(|_| "Databricks sign-in could not complete")?;
    let mut data = body(response).await?;
    let access = data["access_token"]
        .take()
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Databricks did not return an access token")?
        .to_owned();
    let refresh = data["refresh_token"]
        .take()
        .as_str()
        .unwrap_or(old_refresh)
        .to_owned();
    let expires = data["expires_in"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or("Databricks did not return token expiry")?;
    if refresh.is_empty() || access.len() > 16 * 1024 || refresh.len() > 16 * 1024 {
        return Err("Invalid Databricks credentials".into());
    }
    Ok(Credential {
        access,
        refresh,
        expires: now().saturating_add(expires),
    })
}
/// Serializes refresh across Buzz and every Goose credential helper.
async fn token(client: &reqwest::Client, dir: &Path) -> Result<Credential> {
    let _lock = lock(dir).await?;
    let saved = read(dir)?.ok_or("Sign in to Databricks in Buzz first")?;
    if saved.expires > now().saturating_add(60) {
        return Ok(saved);
    }
    let next = exchange(
        client,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", &saved.refresh),
        ],
        &saved.refresh,
    )
    .await?;
    write(dir, &next)?;
    Ok(next)
}
fn chat_models(data: &Value) -> Vec<Value> {
    data["endpoints"].as_array().into_iter().flatten().filter_map(|ep| {
        let id = ep["name"].as_str()?;
        if ep["state"]["ready"] != "READY" || ep["task"] != "llm/v1/chat" || ep["capabilities"]["function_calling"] != true { return None; }
        let foundation = ep["config"]["served_entities"].as_array()?.iter().find_map(|e| e.get("foundation_model"))?;
        if foundation["ai_gateway_v2_supported"] != true || !foundation["api_types"].as_array()?.iter().any(|a| a == "mlflow/v1/responses") { return None; }
        Some(json!({"id":id, "label":foundation["display_name"].as_str().unwrap_or(id), "api":"openai-responses", "family":foundation["model_class"].as_str().unwrap_or("")}))
    }).collect()
}
async fn models(client: &reqwest::Client, dir: &Path) -> Result<Vec<Value>> {
    let credential = token(client, dir).await?;
    let response = client
        .get(format!("{HOST}/api/2.0/serving-endpoints"))
        .bearer_auth(&credential.access)
        .send()
        .await
        .map_err(|_| "Could not list Databricks models")?;
    let data = body(response).await?;
    if !data["endpoints"].is_array() {
        return Err("Databricks returned an invalid model catalog".into());
    }
    Ok(chat_models(&data))
}
fn argument<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    input[key]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 4096)
        .ok_or_else(|| format!("Invalid {key}"))
}
async fn execute(operation: &str, input: &Value) -> Result<Value> {
    let dir = directory()?;
    let client = client()?;
    match operation {
        "status" => Ok(json!({"connected":read(&dir)?.is_some(), "host":HOST})),
        "authorize" => Ok(
            json!({"url":endpoint(&oidc(&client).await?, "authorization_endpoint")?, "host":HOST}),
        ),
        "connect" => {
            let redirect = argument(input, "redirect")?;
            let url = url::Url::parse(redirect).map_err(|_| "Invalid OAuth redirect")?;
            if url.scheme() != "http"
                || url.host_str() != Some("localhost")
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("Invalid OAuth redirect".into());
            }
            let credential = exchange(
                &client,
                &[
                    ("grant_type", "authorization_code"),
                    ("client_id", CLIENT_ID),
                    ("code", argument(input, "code")?),
                    ("code_verifier", argument(input, "verifier")?),
                    ("redirect_uri", redirect),
                ],
                "",
            )
            .await?;
            let _lock = lock(&dir).await?;
            write(&dir, &credential)?;
            Ok(json!({"connected":true, "host":HOST}))
        }
        "disconnect" => {
            let _lock = lock(&dir).await?;
            match std::fs::remove_file(dir.join("credential.json")) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("Could not remove Databricks credentials".into()),
            }
            Ok(json!({"connected":false, "host":HOST}))
        }
        "models" => Ok(json!(models(&client, &dir).await?)),
        "goose" => {
            let model = argument(input, "model")?;
            if read(&dir)?.is_none() {
                return Err("Sign in to Databricks in Buzz first".into());
            }
            // Launches reuse the written catalog; only a new model or binary refetches.
            if let Some(env) = crate::goose_databricks::reuse(model) {
                return Ok(env);
            }
            let catalog = models(&client, &dir).await?;
            crate::goose_databricks::prepare(HOST, &catalog, model)
        }
        _ => Err("Unknown Databricks operation".into()),
    }
}

#[tauri::command]
pub(crate) async fn databricks_provider(operation: String, input: Value) -> Result<Value> {
    execute(&operation, &input).await
}

/// Credential-command mode prints only the access token to Goose's pipe.
pub fn run_token_helper() -> bool {
    if std::env::args().nth(1).as_deref() != Some("--databricks-provider-token") {
        return false;
    }
    let result = (|| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "Could not start provider helper")?;
        runtime.block_on(async {
            let dir = directory()?;
            let credential = token(&client()?, &dir).await?;
            println!("{}", credential.access);
            Ok::<_, String>(())
        })
    })();
    if result.is_err() {
        eprintln!("Databricks credentials are unavailable. Sign in again in Buzz.");
        std::process::exit(1);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn server(status: &str, data: Value) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let payload = data.to_string();
        let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0; 1024];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&chunk[..n]);
                assert!(request.len() < 64 * 1024);
                let text = String::from_utf8_lossy(&request);
                if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|v| v.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if body.len() >= length {
                        break;
                    }
                }
            }
            socket.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8(request).unwrap()
        });
        (format!("http://{address}/token"), task)
    }

    #[tokio::test]
    async fn rotates_refresh_tokens_and_encodes_the_oauth_form() {
        let (url, request) = server("200 OK", json!({"access_token":"next-access", "refresh_token":"next-refresh", "expires_in":3600})).await;
        let before = now();
        let credential = grant(
            &client().unwrap(),
            &url,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", "old+refresh&token"),
            ],
            "old+refresh&token",
        )
        .await
        .unwrap();
        assert_eq!(credential.access, "next-access");
        assert_eq!(credential.refresh, "next-refresh");
        assert!(credential.expires >= before + 3600);
        assert!(request
            .await
            .unwrap()
            .contains("refresh_token=old%2Brefresh%26token"));
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), &credential).unwrap();
        assert_eq!(read(dir.path()).unwrap().unwrap().refresh, "next-refresh");
    }

    #[tokio::test]
    async fn retains_refresh_token_when_the_server_does_not_rotate_it() {
        let (url, request) = server(
            "200 OK",
            json!({"access_token":"next-access", "expires_in":3600}),
        )
        .await;
        let credential = grant(&client().unwrap(), &url, &[], "saved-refresh")
            .await
            .unwrap();
        assert_eq!(credential.refresh, "saved-refresh");
        request.await.unwrap();
    }

    #[tokio::test]
    async fn does_not_expose_http_error_bodies_or_overwrite_saved_credentials() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            &Credential {
                access: "old-access".into(),
                refresh: "old-refresh".into(),
                expires: 1,
            },
        )
        .unwrap();
        let (url, request) =
            server("401 Unauthorized", json!({"error":"secret-from-server"})).await;
        let error = grant(&client().unwrap(), &url, &[], "old-refresh")
            .await
            .err()
            .unwrap();
        assert!(error.contains("HTTP 401"));
        assert!(!error.contains("secret-from-server"));
        assert_eq!(read(dir.path()).unwrap().unwrap().refresh, "old-refresh");
        request.await.unwrap();
    }

    #[tokio::test]
    async fn refresh_storage_is_exclusive_across_independent_handles() {
        let dir = tempfile::tempdir().unwrap();
        let held = lock(dir.path()).await.unwrap();
        let competing = OpenOptions::new()
            .read(true)
            .write(true)
            .open(dir.path().join("credential.lock"))
            .unwrap();
        assert_eq!(
            FileExt::try_lock_exclusive(&competing).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        drop(held);
        FileExt::try_lock_exclusive(&competing).unwrap();
    }

    #[test]
    fn credentials_are_private_and_corrupt_storage_is_actionable() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            &Credential {
                access: "access".into(),
                refresh: "refresh".into(),
                expires: 2,
            },
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(dir.path().join("credential.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::write(dir.path().join("credential.json"), "corrupt-token-data").unwrap();
        let error = read(dir.path()).err().unwrap();
        assert!(error.contains("Sign in again"));
        assert!(!error.contains("corrupt-token-data"));
    }

    #[test]
    fn discovery_keeps_exact_ids_and_requires_ready_tool_support_and_route_facts() {
        let ready = json!({"name":"served-model", "task":"llm/v1/chat", "state":{"ready":"READY"}, "capabilities":{"function_calling":true}, "config":{"served_entities":[{"foundation_model":{"display_name":"GPT", "model_class":"gpt", "ai_gateway_v2_supported":true, "api_types":["mlflow/v1/responses"]}}]}});
        let mut no_tools = ready.clone();
        no_tools["capabilities"]["function_calling"] = json!(false);
        let mut not_ready = ready.clone();
        not_ready["state"]["ready"] = json!("NOT_READY");
        let mut other_route = ready.clone();
        other_route["config"]["served_entities"][0]["foundation_model"]["api_types"] =
            json!(["anthropic/v1/messages"]);
        assert_eq!(
            chat_models(&json!({"endpoints":[ready,no_tools,not_ready,other_route]})),
            vec![
                json!({"id":"served-model", "label":"GPT", "api":"openai-responses", "family":"gpt"})
            ]
        );
        assert!(endpoint(
            &json!({"token_endpoint":"https://attacker.invalid/token"}),
            "token_endpoint"
        )
        .is_err());
    }
}
