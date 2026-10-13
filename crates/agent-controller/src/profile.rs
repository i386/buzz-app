use crate::Result;
use secp256k1::{schnorr::Signature, Secp256k1, XOnlyPublicKey};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub(crate) const MAX_PROFILE_CONTENT_BYTES: usize = 128 * 1024;

/// Count the JSON content bytes, not the unescaped field lengths.
pub(crate) fn bounded_content(content: Map<String, Value>) -> Result<String> {
    let serialized = Value::Object(content).to_string();
    if serialized.len() > MAX_PROFILE_CONTENT_BYTES {
        return Err("Profile content exceeds the readable limit".into());
    }
    Ok(serialized)
}

#[derive(Deserialize)]
struct Profile {
    id: String,
    pubkey: String,
    created_at: u64,
    kind: u16,
    tags: Vec<Vec<String>>,
    content: String,
    sig: String,
}

/// Refuse malformed/unverified reads instead of replacing the profile with defaults.
pub(crate) struct CurrentProfile {
    pub content: Map<String, Value>,
    pub tags: Vec<Vec<String>>,
    pub created_at: u64,
    pub id: String,
}

pub(crate) fn current(events: &[Value], author: &str) -> Result<Option<CurrentProfile>> {
    if events.len() > 5 {
        return Err("Too many profile results".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "System clock is unavailable")?
        .as_secs();
    let mut profiles = Vec::new();
    for value in events {
        let event: Profile =
            serde_json::from_value(value.clone()).map_err(|_| "Invalid current profile")?;
        if event.pubkey != author
            || event.kind != 0
            || event.created_at > now + 60
            || event.content.len() > MAX_PROFILE_CONTENT_BYTES
        {
            return Err("Current profile identity or timestamp is invalid".into());
        }
        let bytes = serde_json::to_vec(&json!([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content
        ]))
        .map_err(|_| "Invalid current profile")?;
        let hash = Sha256::digest(bytes);
        let key: XOnlyPublicKey = author.parse().map_err(|_| "Invalid profile key")?;
        let sig: Signature = event.sig.parse().map_err(|_| "Invalid profile signature")?;
        if event.id != format!("{hash:x}")
            || Secp256k1::verification_only()
                .verify_schnorr(&sig, &hash, &key)
                .is_err()
        {
            return Err("Current profile signature could not be verified".into());
        }
        profiles.push(event);
    }
    profiles.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
    profiles
        .into_iter()
        .next()
        .map(|event| {
            Ok(CurrentProfile {
                content: serde_json::from_str(&event.content)
                    .map_err(|_| "Current profile is not a JSON object")?,
                tags: event.tags,
                created_at: event.created_at,
                id: event.id,
            })
        })
        .transpose()
}
