//! Verified profile publication helpers, also used when adopting an existing identity.
use crate::{Result, Secret};
use serde_json::Value;

/// Native-only publication input, never serialized across IPC.
pub struct CreationProfile {
    pub credential_id: String,
    pub pubkey: String,
    pub url: String,
    pub auth: String,
    pub name: String,
    pub picture: Option<String>,
    pub name_pending: bool,
    pub about: Option<String>,
    pub revision: u64,
}
impl CreationProfile {
    pub fn event(&self, key: &Secret, existing: &[Value]) -> Result<Value> {
        if key.pubkey() != self.pubkey {
            return Err("Profile identity changed".into());
        }
        key.profile(
            &self.name,
            self.picture.as_deref(),
            self.name_pending,
            self.about.as_deref(),
            &self.auth,
            existing,
        )
    }
    pub fn confirm(&self, existing: &[Value], event_id: &str) -> Result<()> {
        let current = crate::profile::current(existing, &self.pubkey)?;
        if current.as_ref().map(|profile| profile.id.as_str()) != Some(event_id) {
            return Err("A different profile is current; saved profile remains pending. Refresh and retry publication.".into());
        }
        Ok(())
    }
    pub fn query_url(&self) -> String {
        self.url.trim_end_matches("/events").to_owned() + "/query"
    }
    pub fn authenticate_query(&self, key: &Secret, body: &[u8]) -> Result<Value> {
        if key.pubkey() != self.pubkey {
            return Err("Profile identity changed".into());
        }
        key.profile_auth(&self.query_url(), body)
    }
    pub fn authenticate(&self, key: &Secret, body: &[u8]) -> Result<Value> {
        if key.pubkey() != self.pubkey {
            return Err("Profile identity changed".into());
        }
        key.profile_auth(&self.url, body)
    }
}
