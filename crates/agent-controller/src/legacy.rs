//! The retired controller's registry is read only, including during sign-out.
//! Keep just the identity fields needed to remove its local credential copies.
use crate::config::{agent_id, canonical_key, canonical_relay, MAX_AGENTS};
use crate::{Credentials, Result};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::fs::OpenOptions;
use std::path::PathBuf;

#[derive(Deserialize)]
struct Registry {
    version: u32,
    agents: Vec<Identity>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    id: String,
    pubkey: String,
    relay_url: String,
    credential_id: String,
}

/// Remove keys listed by the v1 registry, without rewriting it. A failed deletion
/// can be retried, including keys already removed. Retired harness settings do
/// not control whether an identity can be erased.
pub fn delete_local_agent_keys(root: PathBuf, credentials: &dyn Credentials) -> Result<()> {
    if !root.is_absolute() {
        return Err("Agent storage requires an absolute directory".into());
    }
    match std::fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(meta) if meta.is_dir() => {}
        _ => return Err("Agent storage must be a directory, not a link".into()),
    }
    // Older app instances still use this lock. Never erase keys under a writer.
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let lock = options
        .open(root.join("controller.lock"))
        .map_err(|_| "Could not open agent storage lock")?;
    if !lock
        .metadata()
        .map_err(|_| "Could not inspect agent storage lock")?
        .is_file()
    {
        return Err("Agent storage lock must be a regular file".into());
    }
    lock.try_lock()
        .map_err(|_| "Another Buzz app owns this agent storage")?;
    let path = root.join("agents.json");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Could not inspect saved agents".into()),
        Ok(_) => {}
    }
    let registry: Registry = serde_json::from_value(crate::import::read_json(&path, false)?)
        .map_err(|_| "Saved agent identities are malformed; left unchanged")?;
    if registry.version != 1 || registry.agents.len() > MAX_AGENTS {
        return Err("Unsupported agent storage version or size; left unchanged".into());
    }
    let mut ids = BTreeSet::new();
    // Validate the entire inventory before the first destructive operation.
    for agent in &registry.agents {
        if !canonical_key(&agent.pubkey)
            || canonical_relay(&agent.relay_url)? != agent.relay_url
            || agent.id != agent_id(&agent.pubkey, &agent.relay_url)
            || !ids.insert(&agent.id)
            || agent
                .credential_id
                .split_once('-')
                .is_none_or(|(key, digest)| key != agent.pubkey || !canonical_key(digest))
        {
            return Err("Invalid saved agent identity; left unchanged".into());
        }
    }
    for agent in registry.agents {
        credentials.delete(&agent.credential_id, &agent.pubkey)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
