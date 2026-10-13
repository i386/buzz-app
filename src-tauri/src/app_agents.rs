//! Native custody for agents the app runs through a plugin (Agents). The key
//! and owner attestation never enter the WebView; it asks for one bounded
//! event, read, upload or memory write at a time, and native signs and sends it
//! to the agent's community.
use buzz_agent_controller::{
    AppAgent, AppAgents, Carry, Credentials, OldStores, OldTeam, PlatformCredentials, PortSource,
    Portable, Portables, Published, Secret, CREDENTIALS_BUSY,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// A NIP-98 `Authorization` header for one signed HTTP auth event.
fn authorization(event: Value) -> Result<String, String> {
    use base64::Engine;
    Ok(format!(
        "Nostr {}",
        base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(&event).map_err(|_| "Could not authorize profile request")?)
    ))
}

const BUSY_WAITS: u32 = 50;
const BUSY_WAIT: std::time::Duration = std::time::Duration::from_millis(100);

/// The identity file (which locks its own writes across app instances) and its
/// own credential handle, so Agents never waits on, or fails with, the harness
/// agent controller (whose storage lock another app may hold).
#[derive(Clone)]
pub(crate) struct AppAgentHost {
    agents: Result<AppAgents, String>,
    /// Earlier agent systems' identities on this machine, which it can take over.
    old: Result<OldStores, String>,
    credentials: Arc<dyn Credentials>,
    /// Each key after its first read, so only create and first use reach the
    /// credential store, whose lock refuses rather than waits. Waiting on this
    /// lock instead lets concurrent publications queue for that first read.
    keys: Arc<Mutex<HashMap<String, Arc<Secret>>>>,
    /// One profile publication per agent at a time, so each is newer than the
    /// last; Delete takes it too, so no publication outlives the key.
    profiles: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    hosting: Arc<Hosting>,
}
impl AppAgentHost {
    /// `packaged` is false for a dev build, which steps aside for a packaged app.
    pub(crate) fn new(
        path: Result<PathBuf, String>,
        old: Result<OldStores, String>,
        packaged: bool,
    ) -> Self {
        let hosts = path
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|path| Ok(path.parent().ok_or("Invalid agent storage")?.join("hosts")));
        Self {
            agents: path.map(AppAgents::open),
            old,
            credentials: Arc::new(PlatformCredentials::default()),
            keys: Arc::default(),
            profiles: Arc::default(),
            hosting: Arc::new(Hosting {
                dir: hosts,
                packaged,
                held: Mutex::default(),
            }),
        }
    }
    fn keys(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Secret>>> {
        self.keys
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    fn profile_turn(&self, pubkey: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.profiles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(pubkey.into())
            .or_default()
            .clone()
    }
    /// The agent's key; read from the credential store only on first use. A
    /// busy store (a harness start or another app holding it) is waited out for
    /// a few seconds, without holding up agents whose keys are already read.
    async fn key(&self, agent: AppAgent) -> Result<(AppAgent, Arc<Secret>), String> {
        let host = self.clone();
        blocking(move || {
            let mut waits = 0;
            loop {
                let mut keys = host.keys();
                if let Some(key) = keys.get(&agent.pubkey) {
                    return Ok((agent, key.clone()));
                }
                match agent.read_key(host.credentials.as_ref()) {
                    Err(error) if error == CREDENTIALS_BUSY && waits < BUSY_WAITS => {
                        drop(keys);
                        waits += 1;
                        std::thread::sleep(BUSY_WAIT);
                    }
                    read => {
                        let key = Arc::new(read?);
                        keys.insert(agent.pubkey.clone(), key.clone());
                        return Ok((agent, key));
                    }
                }
            }
        })
        .await
    }
    /// Deletes the key once any profile publication in flight has settled, so
    /// the community's cleanup sees every profile it will ever have. The row
    /// stays, marked deleted, until the WebView has cleaned up the community and
    /// calls `app_agent_forget`.
    async fn delete(&self, pubkey: String) -> Result<(), String> {
        let turn = self.profile_turn(&pubkey);
        let _turn = turn.lock().await;
        let host = self.clone();
        blocking(move || {
            // Held across the deletion, so no publication re-reads the key meanwhile.
            let mut keys = host.keys();
            keys.remove(&pubkey);
            host.hosting.held().remove(&pubkey);
            host.agents
                .clone()?
                .remove(&pubkey, host.credentials.as_ref())
        })
        .await
    }
    /// The agent, if it still has its key. One deleted elsewhere loses its cached key.
    async fn agent(&self, pubkey: String) -> Result<AppAgent, String> {
        let host = self.clone();
        blocking(move || {
            let agent = host.agents.clone()?.get(&pubkey);
            if agent.is_err() {
                host.keys().remove(&pubkey);
            }
            agent
        })
        .await
    }
}

/// Which running copy of the app runs each agent. Every copy on this machine
/// (the packaged app and any dev builds) shares the agent list and hears the
/// same events. The packaged app always runs what it can and holds
/// `<pubkey>.packaged` while it does; there is only ever one, since release
/// builds are single-instance. Dev builds step aside while that is held, and
/// otherwise run each agent from whichever holds `<pubkey>.lock`. The OS lets go
/// of both when a copy exits, however it exits.
struct Hosting {
    dir: Result<PathBuf, String>,
    packaged: bool,
    /// The lock file this copy holds per agent: `.packaged` or `.lock`.
    held: Mutex<HashMap<String, File>>,
}
impl Hosting {
    fn held(&self) -> std::sync::MutexGuard<'_, HashMap<String, File>> {
        self.held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    /// Whether this copy runs the agent. The packaged app always does, so a
    /// stuck dev build can never silence it. A dev build takes the agent if no
    /// other copy runs it, and lets go while the packaged app does.
    #[allow(clippy::incompatible_msrv)] // `File` locking; see `sign_out::Instance`.
    fn claim(&self, pubkey: &str) -> Result<bool, String> {
        if pubkey.len() != 64
            || !pubkey
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err("Invalid agent".into());
        }
        let dir = self.dir.as_ref().map_err(Clone::clone)?;
        std::fs::create_dir_all(dir).map_err(|_| "Could not open agent hosting")?;
        let packaged = dir.join(format!("{pubkey}.packaged"));
        let mut held = self.held();
        if self.packaged {
            if !held.contains_key(pubkey) {
                let file = open_lock(&packaged)?;
                // A dev build checking for it holds it briefly; this tries again next time.
                if lock(file.try_lock())? {
                    held.insert(pubkey.into(), file);
                }
            }
            return Ok(true);
        }
        if !lock(open_lock(&packaged)?.try_lock_shared())? {
            held.remove(pubkey);
            return Ok(false);
        }
        if !held.contains_key(pubkey) {
            let file = open_lock(&dir.join(format!("{pubkey}.lock")))?;
            if lock(file.try_lock())? {
                held.insert(pubkey.into(), file);
            }
        }
        Ok(held.contains_key(pubkey))
    }
}
/// Whether a try at a lock took it; closing the file lets go.
#[allow(clippy::incompatible_msrv)]
fn lock(attempt: Result<(), TryLockError>) -> Result<bool, String> {
    match attempt {
        Ok(()) => Ok(true),
        Err(TryLockError::WouldBlock) => Ok(false),
        Err(TryLockError::Error(_)) => Err("Could not read agent hosting".into()),
    }
}
fn open_lock(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| "Could not open agent hosting lock".to_owned())
}

/// Runs blocking file and credential work off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "Native credential operation failed".to_owned())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppAgentSummary {
    pubkey: String,
    relay: String,
    owner: String,
    #[serde(rename = "type")]
    agent_type: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    picture: Option<String>,
    deleted: bool,
}
impl From<AppAgent> for AppAgentSummary {
    fn from(agent: AppAgent) -> Self {
        Self {
            pubkey: agent.pubkey,
            relay: agent.relay,
            owner: agent.owner,
            agent_type: agent.agent_type,
            name: agent.name,
            picture: agent.picture,
            deleted: agent.deleted,
        }
    }
}

/// A taken-over identity, the settings its old store kept for its new type,
/// and the old Buzz team it was on as that store has it now.
#[derive(Serialize)]
pub(crate) struct Ported {
    agent: AppAgentSummary,
    carry: Carry,
    #[serde(skip_serializing_if = "Option::is_none")]
    team: Option<OldTeam>,
}
impl Ported {
    fn new(agent: AppAgent, found: Portable) -> Self {
        Self {
            agent: agent.into(),
            carry: found.carry,
            team: found.team,
        }
    }
}

#[tauri::command]
pub(crate) async fn app_agent_list(
    state: tauri::State<'_, AppAgentHost>,
) -> Result<Vec<AppAgentSummary>, String> {
    let agents = state.agents.clone()?;
    blocking(move || Ok(agents.list()?.into_iter().map(Into::into).collect())).await
}

/// Generates a key for `owner` in `destination`, has the signed-in owner attest
/// it, and saves both. Nothing is saved unless all three succeed.
#[tauri::command]
pub(crate) async fn app_agent_create(
    state: tauri::State<'_, AppAgentHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    destination: String,
    owner: String,
    agent_type: String,
    name: String,
) -> Result<AppAgentSummary, String> {
    let agents = state.agents.clone()?;
    let prepared = AppAgents::prepare(&destination, &owner, &agent_type, &name)?;
    let auth = identity
        .inner()
        .authorize_agent(owner, prepared.pubkey().to_owned())
        .await?;
    let host = state.inner().clone();
    blocking(move || {
        // Held so no first key read meets this write in the credential store.
        let mut keys = host.keys();
        host.credentials.retry();
        let (agent, key) = agents.commit(prepared, &auth, host.credentials.as_ref())?;
        keys.insert(agent.pubkey.clone(), Arc::new(key));
        Ok(agent.into())
    })
    .await
}

/// Identities earlier agent systems saved on this machine, as Agents could take
/// them over; the caller leaves out its own.
#[tauri::command]
pub(crate) async fn app_agent_portable(
    state: tauri::State<'_, AppAgentHost>,
) -> Result<Portables, String> {
    let old = state.old.clone()?;
    blocking(move || Ok(old.list())).await
}

/// Takes over an earlier identity with its key, name, picture and description,
/// as `app_agent_create` does for a new one, and reports its carried settings.
/// Its old store keeps it.
#[tauri::command]
pub(crate) async fn app_agent_port(
    state: tauri::State<'_, AppAgentHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    source: PortSource,
    pubkey: String,
    destination: String,
    owner: String,
    agent_type: String,
) -> Result<Ported, String> {
    let agents = state.agents.clone()?;
    let old = state.old.clone()?;
    let credentials = state.credentials.clone();
    let (found, key) = blocking(move || {
        credentials.retry();
        let mut waits = 0;
        loop {
            match old.take(source, &pubkey, credentials.as_ref()) {
                Err(error) if error == CREDENTIALS_BUSY && waits < BUSY_WAITS => {
                    waits += 1;
                    std::thread::sleep(BUSY_WAIT);
                }
                taken => return taken,
            }
        }
    })
    .await?;
    let prepared = AppAgents::adopt(
        &destination,
        &owner,
        &agent_type,
        key,
        &found.name,
        found.picture.clone(),
        found.about.clone(),
    )?;
    let auth = identity
        .inner()
        .authorize_agent(owner, prepared.pubkey().to_owned())
        .await?;
    let host = state.inner().clone();
    blocking(move || {
        let mut keys = host.keys();
        let (agent, key) = agents.commit(prepared, &auth, host.credentials.as_ref())?;
        keys.insert(agent.pubkey.clone(), Arc::new(key));
        Ok(Ported::new(agent, found))
    })
    .await
}

#[tauri::command]
pub(crate) async fn app_agent_rename(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    name: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.rename(&pubkey, &name)).await
}

#[tauri::command]
pub(crate) async fn app_agent_set_type(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    agent_type: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.set_type(&pubkey, &agent_type)).await
}

#[tauri::command]
pub(crate) async fn app_agent_set_picture(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    picture: Option<String>,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.set_picture(&pubkey, picture)).await
}

#[tauri::command]
pub(crate) async fn app_agent_delete(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
) -> Result<(), String> {
    state.delete(pubkey).await
}

#[tauri::command]
pub(crate) async fn app_agent_forget(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.forget(&pubkey)).await
}

/// Whether this copy of the app runs the agent; see `Hosting`.
#[tauri::command]
pub(crate) async fn app_agent_claim(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
) -> Result<bool, String> {
    let hosting = state.hosting.clone();
    blocking(move || hosting.claim(&pubkey)).await
}

/// Lets another copy of the app run the agent, as when this one cannot.
#[tauri::command]
pub(crate) fn app_agent_release(state: tauri::State<'_, AppAgentHost>, pubkey: String) {
    state.hosting.held().remove(&pubkey);
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AppAgentEvent {
    kind: u16,
    content: String,
    #[serde(default)]
    tags: Vec<Vec<String>>,
}

/// Signs one event as the agent and posts it to the agent's own community.
#[tauri::command]
pub(crate) async fn app_agent_publish(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    event: AppAgentEvent,
) -> Result<Value, String> {
    let (agent, key) = state.key(state.agent(pubkey).await?).await?;
    let signed = agent.sign(&key, event.kind, event.content, event.tags)?;
    post(&agent, &key, signed).await
}

/// Publishes changed public metadata. Safe to call any time; one publication
/// runs per agent at a time and records only what its community accepted.
#[tauri::command]
pub(crate) async fn app_agent_publish_profile(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
) -> Result<(), String> {
    let turn = state.profile_turn(&pubkey);
    let _turn = turn.lock().await;
    let agent = state.agent(pubkey).await?;
    if agent.profile_is_current() {
        return Ok(());
    }
    let (agent, key) = state.key(agent).await?;
    let signed = post(&agent, &key, agent.profile_event(&key)?).await?;
    let created_at = signed
        .get("created_at")
        .and_then(Value::as_u64)
        .ok_or("Invalid agent event")?;
    let agents = state.agents.clone()?;
    blocking(move || {
        agents.published(
            &agent.pubkey,
            Published {
                name: agent.name,
                picture: agent.picture,
                about: agent.about,
                created_at,
            },
        )
    })
    .await
}

/// Reads from the agent's community as the agent, so it sees what the agent
/// may see rather than what the owner may.
#[tauri::command]
pub(crate) async fn app_agent_query(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    filters: Vec<Value>,
) -> Result<Value, String> {
    if filters.is_empty() || filters.len() > 8 {
        return Err("Agents read with one to eight filters".into());
    }
    let (agent, key) = state.key(state.agent(pubkey).await?).await?;
    read(&agent, &key, &filters).await
}

async fn read(agent: &AppAgent, key: &Secret, filters: &[Value]) -> Result<Value, String> {
    let bytes = serde_json::to_vec(filters).map_err(|_| "Could not encode agent read")?;
    let response = client(20)?
        .post(agent.query_url())
        .header("Content-Type", "application/json")
        .header(
            "Authorization",
            authorization(agent.http_auth(key, &agent.query_url(), &bytes)?)?,
        )
        .header("x-auth-tag", &agent.auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Agent read failed")?;
    let status = response.status();
    let body = bounded(response, 8 * 1024 * 1024).await?;
    if !status.is_success() {
        return Err(format!(
            "The community refused the agent read: {}",
            reason(status, &body)
        ));
    }
    serde_json::from_slice(&body).map_err(|_| "Invalid agent read".into())
}

/// Media an agent may upload, as the community accepts them.
const UPLOAD_TYPES: [&str; 5] = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "video/mp4",
];
const UPLOAD_LIMIT: usize = 50 * 1024 * 1024;

/// Uploads one file (base64 `data` of type `mime`) to the agent's community
/// as the agent, and returns the community's description of it.
#[tauri::command]
pub(crate) async fn app_agent_upload(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    data: String,
    mime: String,
) -> Result<Value, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    if !UPLOAD_TYPES.contains(&mime.as_str()) || data.len() > UPLOAD_LIMIT / 3 * 4 + 4 {
        return Err("Agents upload images or MP4 video up to 50 MB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "Invalid upload data")?;
    let (agent, key) = state.key(state.agent(pubkey).await?).await?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let auth = serde_json::to_vec(&agent.upload_auth(&key, &sha256)?)
        .map_err(|_| "Could not authorize upload")?;
    let response = client(120)?
        .put(agent.upload_url())
        .header("Content-Type", &mime)
        .header("X-SHA-256", &sha256)
        .header(
            "Authorization",
            format!(
                "Nostr {}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(auth)
            ),
        )
        .header("x-auth-tag", &agent.auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Agent upload unconfirmed")?;
    let status = response.status();
    let body = bounded(response, 64 * 1024).await?;
    if !status.is_success() {
        return Err(format!(
            "The community refused the upload: {}",
            reason(status, &body)
        ));
    }
    serde_json::from_slice(&body).map_err(|_| "Invalid upload receipt".into())
}

/// The largest image an agent is shown. Claude takes 5 MiB of base64 on its
/// strictest hosts, and base64 is 4 characters per 3 bytes.
const MEDIA_LIMIT: usize = 5 * 1024 * 1024 / 4 * 3;

/// Downloads one of its community's media blobs (its URL or `sha256[.ext]`)
/// as the agent, base64.
#[tauri::command]
pub(crate) async fn app_agent_media(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    url: String,
) -> Result<String, String> {
    use base64::Engine;
    let (agent, key) = state.key(state.agent(pubkey).await?).await?;
    let url = agent.media_url(&url)?;
    let auth =
        serde_json::to_vec(&agent.media_auth(&key)?).map_err(|_| "Could not authorize media")?;
    let response = client(120)?
        .get(&url)
        .header(
            "Authorization",
            format!(
                "Nostr {}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(auth)
            ),
        )
        .header("x-auth-tag", &agent.auth)
        .send()
        .await
        .map_err(|_| "Agent media request failed")?;
    let status = response.status();
    let body = bounded(response, MEDIA_LIMIT).await?;
    if !status.is_success() {
        return Err(format!(
            "The community refused the media: {}",
            reason(status, &body)
        ));
    }
    agent.verify_media_hash(&url, &body)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(body))
}

/// Writes one memory entry, encrypted to the agent's owner. `after` is the
/// `created_at` of the entry it replaces, or 0.
#[tauri::command]
pub(crate) async fn app_agent_remember(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    slug: String,
    body: String,
    after: u64,
) -> Result<Value, String> {
    let (agent, key) = state.key(state.agent(pubkey).await?).await?;
    let signed = agent.memory(&key, &slug, &body, after)?;
    post(&agent, &key, signed).await
}

fn client(seconds: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(seconds))
        .build()
        .map_err(|_| "Agent client unavailable".into())
}

async fn bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Agent request failed")? {
        if body.len() + chunk.len() > limit {
            return Err("Agent response is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Why the community refused, from its JSON body when it gives one.
fn reason(status: reqwest::StatusCode, body: &[u8]) -> String {
    let receipt: Value =
        serde_json::from_slice(&body[..body.len().min(16 * 1024)]).unwrap_or(Value::Null);
    receipt
        .get("message")
        .or_else(|| receipt.get("error"))
        .and_then(Value::as_str)
        .map(|text| text.chars().take(300).collect::<String>())
        .unwrap_or_else(|| format!("status {}", status.as_u16()))
}

async fn post(agent: &AppAgent, key: &Secret, signed: Value) -> Result<Value, String> {
    let event_id = signed
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Invalid agent event")?
        .to_owned();
    let bytes = serde_json::to_vec(&signed).map_err(|_| "Could not encode agent event")?;
    let response = client(20)?
        .post(agent.events_url())
        .header("Content-Type", "application/json")
        .header(
            "Authorization",
            authorization(agent.http_auth(key, &agent.events_url(), &bytes)?)?,
        )
        .header("x-auth-tag", &agent.auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Agent event unconfirmed; it may or may not have been accepted")?;
    let status = response.status();
    let body = response.bytes().await.unwrap_or_default();
    let receipt: Value =
        serde_json::from_slice(&body[..body.len().min(16 * 1024)]).unwrap_or(Value::Null);
    if !status.is_success()
        || receipt.get("accepted").and_then(Value::as_bool) != Some(true)
        || receipt.get("event_id").and_then(Value::as_str) != Some(event_id.as_str())
    {
        return Err(format!(
            "The community refused the agent event: {}",
            reason(status, &body)
        ));
    }
    Ok(signed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// One saved key, behind a store that is busy for the first few reads.
    struct Busy(String, AtomicU32);
    impl Credentials for Busy {
        fn read_legacy(
            &self,
            _: buzz_agent_controller::LegacySource,
            _: &str,
        ) -> Result<Secret, String> {
            unreachable!()
        }
        fn read(&self, _: &str, pubkey: &str) -> Result<Option<Secret>, String> {
            if self.1.load(Ordering::SeqCst) > 0 {
                self.1.fetch_sub(1, Ordering::SeqCst);
                return Err(CREDENTIALS_BUSY.into());
            }
            Secret::parse(&self.0, pubkey).map(Some)
        }
        fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
            unreachable!()
        }
        fn delete(&self, _: &str, _: &str) -> Result<(), String> {
            unreachable!()
        }
    }

    /// What the app reads back from an import: the team as the old store has it
    /// when taken, and no `team` at all for an agent on none.
    #[test]
    fn a_ported_agent_carries_its_freshly_read_team() {
        let dir = tempfile::tempdir().unwrap();
        let agents = dir
            .path()
            .join(buzz_agent_controller::LegacySource::Installed.app_directory())
            .join("agents");
        std::fs::create_dir_all(&agents).unwrap();
        let (member, loner) = (Secret::generate().unwrap(), Secret::generate().unwrap());
        let record = |key: &Secret, team: Value| {
            serde_json::json!({"pubkey": key.pubkey(), "name": "Ada", "team_id": team,
                "private_key_nsec": key.hex().to_string()})
        };
        std::fs::write(
            agents.join("managed-agents.json"),
            serde_json::json!([record(&member, "t".into()), record(&loner, Value::Null)])
                .to_string(),
        )
        .unwrap();
        let teams = |name: &str| {
            serde_json::json!([{"id": "t", "name": name, "instructions": " Ship it. "}]).to_string()
        };
        let old = OldStores {
            harness: dir.path().join("none.json"),
            data_dir: dir.path().into(),
        };
        std::fs::write(agents.join("teams.json"), teams("Listed")).unwrap();
        old.list();
        std::fs::write(agents.join("teams.json"), teams("Fresh")).unwrap();
        let ported = |key: &Secret| {
            let busy = Busy(key.hex().to_string(), AtomicU32::new(0));
            let (found, _) = old
                .take(PortSource::Installed, key.pubkey(), &busy)
                .unwrap();
            let agent = AppAgent {
                pubkey: key.pubkey().into(),
                relay: "wss://relay.example".into(),
                owner: "a".repeat(64),
                auth: "[]".into(),
                agent_type: "p/t".into(),
                name: "Ada".into(),
                picture: None,
                profile: None,
                about: None,
                deleted: false,
            };
            serde_json::to_value(Ported::new(agent, found)).unwrap()
        };
        assert_eq!(
            ported(&member)["team"],
            serde_json::json!({"id": "t", "name": "Fresh", "instructions": "Ship it."})
        );
        assert!(ported(&loner).get("team").is_none());
    }

    #[tokio::test]
    async fn a_first_key_read_waits_out_a_busy_store() {
        let key = Secret::generate().unwrap();
        let host = AppAgentHost {
            agents: Err("unused".into()),
            old: Err("unused".into()),
            credentials: Arc::new(Busy(key.hex().to_string(), AtomicU32::new(3))),
            keys: Arc::default(),
            profiles: Arc::default(),
            hosting: Arc::new(hosting(Err("unused".into()), true)),
        };
        let agent = AppAgent {
            pubkey: key.pubkey().into(),
            relay: "wss://relay.example".into(),
            owner: "a".repeat(64),
            auth: "[]".into(),
            agent_type: "p/t".into(),
            name: "Ada".into(),
            picture: None,
            profile: None,
            about: None,
            deleted: false,
        };
        let (_, read) = host.key(agent).await.unwrap();
        assert_eq!(read.pubkey(), key.pubkey());
    }

    #[tokio::test]
    async fn delete_waits_for_a_profile_publication_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let host = AppAgentHost::new(
            Ok(dir.path().join("identities.json")),
            Err("unused".into()),
            true,
        );
        let pubkey = "c".repeat(64);
        let turn = host.profile_turn(&pubkey);
        let publishing = turn.lock().await;
        let mut deleting = tokio::spawn({
            let host = host.clone();
            let pubkey = pubkey.clone();
            async move { host.delete(pubkey).await }
        });
        // Unblocked, deleting an absent agent takes well under this.
        let waited = std::time::Duration::from_millis(300);
        assert!(tokio::time::timeout(waited, &mut deleting).await.is_err());
        drop(publishing);
        deleting.await.unwrap().unwrap();
    }

    fn hosting(dir: Result<PathBuf, String>, packaged: bool) -> Hosting {
        Hosting {
            dir,
            packaged,
            held: Mutex::default(),
        }
    }

    #[test]
    fn one_copy_runs_each_agent_until_it_lets_go() {
        let dir = tempfile::tempdir().unwrap();
        let (first, second) = ("a".repeat(64), "b".repeat(64));
        let one = hosting(Ok(dir.path().join("hosts")), false);
        let other = hosting(Ok(dir.path().join("hosts")), false);
        assert!(one.claim(&first).unwrap());
        assert!(one.claim(&first).unwrap());
        assert!(!other.claim(&first).unwrap());
        assert!(other.claim(&second).unwrap());
        // As when that copy quits.
        drop(one);
        assert!(other.claim(&first).unwrap());
        assert!(other.claim("../x").is_err());
    }

    #[test]
    fn a_packaged_app_runs_what_it_can_and_dev_builds_let_go() {
        let dir = tempfile::tempdir().unwrap();
        let (agent, other) = ("a".repeat(64), "b".repeat(64));
        let dev = hosting(Ok(dir.path().join("hosts")), false);
        let packaged = hosting(Ok(dir.path().join("hosts")), true);
        assert!(dev.claim(&agent).unwrap());
        assert!(dev.claim(&other).unwrap());
        // The packaged app runs it at once, though the dev build had it first,
        assert!(packaged.claim(&agent).unwrap());
        // and the dev build lets go at its next claim.
        assert!(!dev.claim(&agent).unwrap());
        assert!(packaged.claim(&agent).unwrap());
        // A second dev build cannot take it either.
        let another = hosting(Ok(dir.path().join("hosts")), false);
        assert!(!another.claim(&agent).unwrap());
        // One the packaged app does not ask for stays with the dev build.
        assert!(dev.claim(&other).unwrap());
        // As when it can no longer run it.
        packaged.held().remove(&agent);
        assert!(dev.claim(&agent).unwrap());
        assert!(!another.claim(&agent).unwrap());
    }
}
