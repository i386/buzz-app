//! The optional Jev watch classifier. Native code owns the TypeSafe key: it is
//! read from and written to the login Keychain item Janet uses
//! (`typesafe-api-key`), and it never crosses into the webview or an agent
//! process. The webview sends the questions and the event; native adds the key
//! and the pinned model, calls Jev, and returns only Jev's answers.
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore};
use zeroize::Zeroizing;

#[cfg(target_os = "macos")]
pub(crate) const KEYCHAIN_SERVICE: &str = "typesafe-api-key";
pub(crate) const MODEL: &str = "jev-1.13.0";
const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const INPUT_LIMIT: usize = 128 * 1024;
const RESPONSE_LIMIT: usize = 16 * 1024;
/// Calls past this wait for a slot inside their deadline, as in Janet.
const MAX_IN_FLIGHT: usize = 16;
const TIMEOUT: Duration = Duration::from_secs(30);
const KEY_LIMIT: usize = 512;

/// Why a classification has no answers. The event passes in every case.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Failure {
    MissingCredentials,
    InputLimit,
    Timeout,
    ServiceError,
    InvalidResponse,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(crate) enum Classified {
    /// Jev's `answers` object, unvalidated beyond its model and size.
    Answered {
        answers: serde_json::Value,
    },
    Failed {
        reason: Failure,
    },
}

/// Where the key lives. The OS store runs `/usr/bin/security`, as Janet does,
/// so the item keeps the access list that lets Janet read it without a prompt.
pub(crate) trait KeyStore: Send + Sync {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String>;
    fn replace(&self, key: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

pub(crate) struct JevHost {
    store: Arc<dyn KeyStore>,
    /// `None` until read: the Keychain is asked once, then kept current by set
    /// and clear. A failed read is not kept, and a key the service refuses is
    /// read again, so one removed outside the app is seen on the next call.
    key: Mutex<Option<Option<Zeroizing<String>>>>,
    slots: Arc<Semaphore>,
    endpoint: String,
    timeout: Duration,
}

impl JevHost {
    pub(crate) fn new() -> Self {
        Self::with(Box::new(OsKeyStore), ENDPOINT.into(), TIMEOUT)
    }
    pub(crate) fn with(store: Box<dyn KeyStore>, endpoint: String, timeout: Duration) -> Self {
        Self {
            store: Arc::from(store),
            key: Mutex::new(None),
            slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
            endpoint,
            timeout,
        }
    }
    /// The saved key, or `None` when there is none. A Keychain that cannot be
    /// read is an error, not a missing key.
    async fn key(&self) -> Result<Option<Zeroizing<String>>, String> {
        let mut key = self.key.lock().await;
        if key.is_none() {
            // `security` is a blocking subprocess; a caller's deadline still
            // applies while it runs.
            let store = self.store.clone();
            let read = tokio::task::spawn_blocking(move || store.read())
                .await
                .map_err(|_| "The Keychain is unavailable".to_string())??;
            *key = Some(read);
        }
        Ok(key.as_ref().and_then(|k| k.clone()))
    }
    async fn forget(&self) {
        *self.key.lock().await = None;
    }
    pub(crate) async fn configured(&self) -> Result<bool, String> {
        Ok(self.key().await?.is_some())
    }
    pub(crate) async fn set(&self, value: &str) -> Result<(), String> {
        let value = value.trim();
        if value.is_empty()
            || value.len() > KEY_LIMIT
            || !value
                .bytes()
                .all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\')
        {
            return Err("That does not look like a TypeSafe API key".into());
        }
        let mut key = self.key.lock().await;
        let store = self.store.clone();
        let saved = Zeroizing::new(value.to_owned());
        let write = saved.clone();
        tokio::task::spawn_blocking(move || store.replace(&write))
            .await
            .map_err(|_| "The Keychain is unavailable".to_string())??;
        *key = Some(Some(saved));
        Ok(())
    }
    pub(crate) async fn clear(&self) -> Result<(), String> {
        let mut key = self.key.lock().await;
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.clear())
            .await
            .map_err(|_| "The Keychain is unavailable".to_string())??;
        *key = Some(None);
        Ok(())
    }

    /// One Jev call: at most one retry, and the wait for a slot, both attempts
    /// and the response read all share one deadline.
    pub(crate) async fn classify(
        &self,
        state: serde_json::Value,
        questions: serde_json::Value,
    ) -> Classified {
        let failed = |reason| Classified::Failed { reason };
        let body = match serde_json::to_vec(&serde_json::json!({
            "model": MODEL, "state": state, "questions": questions,
        })) {
            Ok(body) if body.len() <= INPUT_LIMIT => body,
            _ => return failed(Failure::InputLimit),
        };
        let deadline = Instant::now() + self.timeout;
        let call = async {
            let key = match self.key().await {
                Ok(Some(key)) => key,
                Ok(None) => return Err(Failure::MissingCredentials),
                // Unreadable is not absent: the key may still be saved.
                Err(_) => return Err(Failure::ServiceError),
            };
            self.call(&key, body, deadline).await
        };
        match tokio::time::timeout_at(deadline.into(), call).await {
            Ok(Ok(answers)) => Classified::Answered { answers },
            Ok(Err(reason)) => failed(reason),
            Err(_) => failed(Failure::Timeout),
        }
    }
    async fn call(
        &self,
        key: &str,
        body: Vec<u8>,
        deadline: Instant,
    ) -> Result<serde_json::Value, Failure> {
        let _slot = self
            .slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| Failure::ServiceError)?;
        let client = client().ok_or(Failure::ServiceError)?;
        for attempt in 0..2 {
            let response = client
                .post(&self.endpoint)
                .bearer_auth(key)
                .header("content-type", "application/json")
                .body(body.clone())
                .send()
                .await
                .map_err(|_| Failure::ServiceError)?;
            let status = response.status();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                // The key may have been removed or replaced outside the app.
                self.forget().await;
                return Err(Failure::ServiceError);
            }
            if !status.is_success() {
                if attempt == 0 && (status.as_u16() == 429 || status.is_server_error()) {
                    let backoff = retry_after(response.headers()).max(Duration::from_millis(500));
                    // Never retry sooner than asked, or past the deadline.
                    if Instant::now() + backoff >= deadline {
                        return Err(Failure::ServiceError);
                    }
                    tokio::time::sleep(backoff).await;
                    continue;
                }
                return Err(Failure::ServiceError);
            }
            return answers(read_limited(response).await?);
        }
        Err(Failure::ServiceError)
    }
}

fn retry_after(headers: &reqwest::header::HeaderMap) -> Duration {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(|seconds| Duration::from_secs_f64(seconds.min(3600.0)))
        .unwrap_or(Duration::from_millis(500))
}

async fn read_limited(mut response: reqwest::Response) -> Result<Vec<u8>, Failure> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::ServiceError)? {
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err(Failure::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Jev's answers, when the response is for the pinned model.
fn answers(bytes: Vec<u8>) -> Result<serde_json::Value, Failure> {
    let mut value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidResponse)?;
    if value.get("model").and_then(|m| m.as_str()) != Some(MODEL) {
        return Err(Failure::InvalidResponse);
    }
    match value.get_mut("answers").map(serde_json::Value::take) {
        Some(answers @ serde_json::Value::Object(_)) => Ok(answers),
        _ => Err(Failure::InvalidResponse),
    }
}

fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .build()
                .ok()
        })
        .as_ref()
}

/// The login Keychain through `/usr/bin/security`, as Janet reads it. Writes go
/// through its interactive mode on stdin, so the key is never in a command line.
struct OsKeyStore;

/// `security`'s exit status for errSecItemNotFound.
#[cfg(target_os = "macos")]
const ITEM_NOT_FOUND: i32 = 44;

#[cfg(target_os = "macos")]
impl OsKeyStore {
    fn security(args: &[&str], input: Option<&str>) -> Result<std::process::Output, String> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("/usr/bin/security")
            .args(args)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "The Keychain is unavailable".to_string())?;
        if let Some(input) = input {
            let mut stdin = child.stdin.take().ok_or("The Keychain is unavailable")?;
            stdin
                .write_all(input.as_bytes())
                .map_err(|_| "The Keychain is unavailable".to_string())?;
        }
        child
            .wait_with_output()
            .map_err(|_| "The Keychain is unavailable".to_string())
    }
}

#[cfg(target_os = "macos")]
impl KeyStore for OsKeyStore {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        let output = Self::security(
            &["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            None,
        )?;
        // Only "item not found" means no key; a locked or refused Keychain
        // is an error, so it neither hides nor removes a saved key.
        if output.status.code() == Some(ITEM_NOT_FOUND) {
            return Ok(None);
        }
        if !output.status.success() {
            return Err("The Keychain could not be read".into());
        }
        let text = Zeroizing::new(String::from_utf8(output.stdout).unwrap_or_default());
        let key = text.trim();
        Ok((!key.is_empty()).then(|| Zeroizing::new(key.to_owned())))
    }
    fn replace(&self, key: &str) -> Result<(), String> {
        // Updated in place, so a failed write leaves the saved key as it was.
        let account = std::env::var("USER").unwrap_or_else(|_| "buzz".into());
        let account: String = account
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c))
            .collect();
        let command = Zeroizing::new(format!(
            "add-generic-password -U -a \"{account}\" -s {KEYCHAIN_SERVICE} -w \"{key}\"\n"
        ));
        Self::security(&["-i"], Some(&command))?;
        match self.read()? {
            Some(saved) if saved.as_str() == key => Ok(()),
            // Another account's item is read first; it is left for the
            // owner to remove rather than deleted here.
            Some(_) => Err(
                "Another TypeSafe key is saved in the Keychain. Remove it, then try again".into(),
            ),
            None => Err("The key was not saved to the Keychain".into()),
        }
    }
    fn clear(&self) -> Result<(), String> {
        // Removes every item of the service; bounded in case deletion is refused.
        for _ in 0..16 {
            let output =
                Self::security(&["delete-generic-password", "-s", KEYCHAIN_SERVICE], None)?;
            if !output.status.success() {
                return match self.read()? {
                    None => Ok(()),
                    Some(_) => Err("The key could not be removed from the Keychain".into()),
                };
            }
        }
        Err("The key could not be removed from the Keychain".into())
    }
}

#[cfg(not(target_os = "macos"))]
impl KeyStore for OsKeyStore {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        Ok(None)
    }
    fn replace(&self, _key: &str) -> Result<(), String> {
        Err("The Jev classifier key is kept in the macOS Keychain; it is not available here".into())
    }
    fn clear(&self) -> Result<(), String> {
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn jev_classifier_status(host: tauri::State<'_, JevHost>) -> Result<bool, String> {
    host.configured().await
}

#[tauri::command]
pub(crate) async fn jev_classifier_set_key(
    host: tauri::State<'_, JevHost>,
    key: String,
) -> Result<(), String> {
    let key = Zeroizing::new(key);
    host.set(&key).await
}

#[tauri::command]
pub(crate) async fn jev_classifier_clear_key(
    host: tauri::State<'_, JevHost>,
) -> Result<(), String> {
    host.clear().await
}

#[tauri::command]
pub(crate) async fn jev_classify(
    host: tauri::State<'_, JevHost>,
    state: serde_json::Value,
    questions: serde_json::Value,
) -> Result<Classified, String> {
    Ok(host.classify(state, questions).await)
}

#[cfg(test)]
#[path = "jev_tests.rs"]
mod tests;
