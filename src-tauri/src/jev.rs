//! The optional Jev watch classifier. Native code owns the TypeSafe key: it is
//! kept in the OS credential store under Buzz's own item, apart from Janet's,
//! and it is never sent back to the webview or given to an agent process. On
//! macOS the item is created by the Buzz binary, so only that binary reads it
//! without a prompt; an agent's shell cannot. The webview sends
//! the questions and the event; native adds the key and the pinned model,
//! calls Jev, and returns only Jev's answers.
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore};
use zeroize::Zeroizing;

#[cfg_attr(test, allow(dead_code))]
pub(crate) const KEY_SERVICE: &str = if cfg!(debug_assertions) {
    "dev.local.buzz.foundation.jev-key.debug"
} else {
    "dev.local.buzz.foundation.jev-key"
};
#[cfg_attr(test, allow(dead_code))]
pub(crate) const KEY_ACCOUNT: &str = "typesafe";
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
    /// The service refused the saved key (401 or 403).
    Unauthorized,
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

/// Where the key lives.
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
            // The store can block on a consent dialog; a caller's deadline
            // still applies while it waits.
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
            || !value.bytes().all(|b| b.is_ascii_graphic())
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

    /// One Jev call. The wait for a slot, the call and the response read share
    /// one deadline. A failed call is not retried: the event passes unchecked.
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
            self.call(&key, body).await
        };
        match tokio::time::timeout_at(deadline.into(), call).await {
            Ok(Ok(answers)) => Classified::Answered { answers },
            Ok(Err(reason)) => failed(reason),
            Err(_) => failed(Failure::Timeout),
        }
    }
    async fn call(&self, key: &str, body: Vec<u8>) -> Result<serde_json::Value, Failure> {
        let _slot = self
            .slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| Failure::ServiceError)?;
        let client = client().ok_or(Failure::ServiceError)?;
        let response = client
            .post(&self.endpoint)
            .bearer_auth(key)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| Failure::ServiceError)?;
        let status = response.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            // The key may have been removed or replaced outside the app.
            self.forget().await;
            return Err(Failure::Unauthorized);
        }
        if !status.is_success() {
            return Err(Failure::ServiceError);
        }
        answers(read_limited(response).await?)
    }
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

/// The OS credential store: the login Keychain on macOS, the Secret Service on
/// Linux and the Credential Manager on Windows.
struct OsKeyStore;

#[cfg(all(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    not(test)
))]
fn decode(bytes: Zeroizing<Vec<u8>>) -> Result<Option<Zeroizing<String>>, String> {
    let text = std::str::from_utf8(&bytes).map_err(|_| "The saved key is damaged".to_string())?;
    let key = text.trim();
    Ok((!key.is_empty()).then(|| Zeroizing::new(key.to_owned())))
}

#[cfg(all(target_os = "macos", not(test)))]
mod platform {
    use super::*;
    use security_framework::os::macos::keychain::SecKeychain;
    const NOT_FOUND: i32 = -25300;
    fn error(error: security_framework::base::Error) -> String {
        match error.code() {
            -128 | -25293 | -25308 => "Keychain access was denied. Allow access and retry",
            _ => "The Keychain is unavailable",
        }
        .into()
    }
    impl KeyStore for OsKeyStore {
        fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
            // Only "item not found" means no key; a locked or refused Keychain
            // is an error, so it neither hides nor removes a saved key.
            match SecKeychain::default()
                .map_err(error)?
                .find_generic_password(KEY_SERVICE, KEY_ACCOUNT)
            {
                Ok((password, _)) => decode(Zeroizing::new(password.to_vec())),
                Err(e) if e.code() == NOT_FOUND => Ok(None),
                Err(e) => Err(error(e)),
            }
        }
        fn replace(&self, key: &str) -> Result<(), String> {
            // A saved item is updated in place, so a failed write leaves the
            // key as it was. A new item's access list trusts only this binary.
            SecKeychain::default()
                .map_err(error)?
                .set_generic_password(KEY_SERVICE, KEY_ACCOUNT, key.as_bytes())
                .map_err(error)
        }
        fn clear(&self) -> Result<(), String> {
            match SecKeychain::default()
                .map_err(error)?
                .find_generic_password(KEY_SERVICE, KEY_ACCOUNT)
            {
                Ok((_, item)) => item.delete(),
                Err(e) if e.code() == NOT_FOUND => return Ok(()),
                Err(e) => return Err(error(e)),
            }
            // Deletion reports no error, so confirm it.
            match self.read()? {
                None => Ok(()),
                Some(_) => Err("The key could not be removed from the Keychain".into()),
            }
        }
    }
}

#[cfg(all(any(target_os = "windows", target_os = "linux"), not(test)))]
mod platform {
    use super::*;
    use buzz_credential_store::{self as credentials, Error};
    fn error(error: Error) -> String {
        match error {
            Error::Denied => "Secure storage access was denied. Allow access and retry",
            Error::Busy => "Another Buzz app is using secure storage. Retry shortly",
            Error::Corrupt => "The saved key is damaged",
            _ => "Secure storage is unavailable. Unlock it and retry",
        }
        .into()
    }
    impl KeyStore for OsKeyStore {
        fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
            match credentials::read(KEY_SERVICE, KEY_ACCOUNT) {
                Ok(bytes) => decode(bytes),
                Err(Error::Absent) => Ok(None),
                Err(e) => Err(error(e)),
            }
        }
        fn replace(&self, key: &str) -> Result<(), String> {
            credentials::replace(KEY_SERVICE, KEY_ACCOUNT, key.as_bytes()).map_err(error)
        }
        fn clear(&self) -> Result<(), String> {
            match credentials::delete(KEY_SERVICE, KEY_ACCOUNT) {
                Ok(()) | Err(Error::Absent) => Ok(()),
                Err(e) => Err(error(e)),
            }
        }
    }
}

// Native tests never touch an OS credential store.
#[cfg(any(
    not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    test
))]
impl KeyStore for OsKeyStore {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        Err("Secure storage is not available here".into())
    }
    fn replace(&self, _key: &str) -> Result<(), String> {
        Err("Secure storage is not available here".into())
    }
    fn clear(&self) -> Result<(), String> {
        Err("Secure storage is not available here".into())
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
