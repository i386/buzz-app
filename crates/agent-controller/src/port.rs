//! Agent identities an earlier agent system saved on this machine, which Agents
//! can take over: the harness controller's library and old Buzz's. The identity
//! and its public name, picture and description move, with its instructions
//! and workspace as a `Carry` for the new type to adopt, and old Buzz's team it
//! was on; other harness settings stay behind. Neither store is ever written.
use crate::config::{agent_id, canonical_key, canonical_relay, MAX_AGENTS};
use crate::import::read_json;
use crate::{Credentials, LegacySource, Result, Secret};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortSource {
    /// This app's harness agents, whose keys are already in its credential store.
    Harness,
    Installed,
    Development,
}
impl PortSource {
    fn legacy(self) -> Option<LegacySource> {
        match self {
            Self::Harness => None,
            Self::Installed => Some(LegacySource::Installed),
            Self::Development => Some(LegacySource::Development),
        }
    }
}

/// One identity another store holds, as it was last saved there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Portable {
    pub source: PortSource,
    pub pubkey: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    /// The community it was saved for there; the new identity uses the open one.
    pub relay: String,
    /// Settings any type may adopt. Only taking the agent over reports them.
    #[serde(skip)]
    pub carry: Carry,
    /// The old Buzz team it was on, if that team still exists and is not one
    /// old Buzz built in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<OldTeam>,
}

/// An old Buzz team as old Buzz last saved it, keyed by its old ID.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OldTeam {
    pub id: String,
    pub name: String,
    /// Its shared instructions, "" for none.
    pub instructions: String,
}

/// What an agent kept in an earlier system that a new type may give it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Carry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// Its working directory, absolute or `~/…`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct Portables {
    pub agents: Vec<Portable>,
    /// A store that could not be read; the others are still listed.
    pub warnings: Vec<String>,
}

/// The harness library file and the OS data directory old Buzz kept its own in.
#[derive(Clone)]
pub struct OldStores {
    pub harness: PathBuf,
    pub data_dir: PathBuf,
}
impl OldStores {
    /// Every identity on this machine, one per key. The harness copy wins, since
    /// reading its key needs no other app's keychain entry. A missing store adds
    /// nothing.
    pub fn list(&self) -> Portables {
        let mut found = Portables::default();
        let mut seen = BTreeSet::new();
        for source in [
            PortSource::Harness,
            PortSource::Installed,
            PortSource::Development,
        ] {
            match self.read(source) {
                Ok((agents, teams)) => {
                    found.warnings.extend(teams.err());
                    found.agents.extend(
                        agents
                            .into_iter()
                            .map(|(agent, _)| agent)
                            .filter(|agent| seen.insert(agent.pubkey.clone())),
                    );
                }
                Err(error) => found.warnings.push(error),
            }
        }
        found
    }
    /// One listed identity, its team and its key, all re-read from the store it
    /// is in, so the caller names only its choice. Unreadable teams leave it
    /// with none.
    pub fn take(
        &self,
        source: PortSource,
        pubkey: &str,
        credentials: &dyn Credentials,
    ) -> Result<(Portable, Secret)> {
        let (agent, saved) = self
            .read(source)?
            .0
            .into_iter()
            .find(|(agent, _)| agent.pubkey == pubkey)
            .ok_or("That agent is no longer saved there")?;
        let key = match source.legacy() {
            Some(_) if !saved.is_empty() => Secret::parse(&saved, pubkey)?,
            Some(legacy) => credentials.read_legacy(legacy, pubkey)?,
            None => credentials
                .read(&saved, pubkey)?
                .ok_or("That agent's key is no longer saved")?,
        };
        Ok((agent, key))
    }
    /// Its identities, each with where its key is: the harness credential ID, or
    /// the key old Buzz kept in the record itself, if it did. Teams that cannot
    /// be read are reported apart, and attach to no one.
    fn read(&self, source: PortSource) -> Result<Read> {
        let (path, records) = match source.legacy() {
            None => (self.harness.clone(), "agents"),
            Some(legacy) => (
                self.data_dir
                    .join(legacy.app_directory())
                    .join("agents/managed-agents.json"),
                "",
            ),
        };
        if !path.try_exists().unwrap_or(true) {
            return Ok((vec![], Ok(())));
        }
        let file =
            read_json(&path, false).map_err(|_| format!("Could not read {}", path.display()))?;
        let records = if records.is_empty() {
            &file
        } else {
            &file[records]
        };
        let records = records
            .as_array()
            .filter(|records| records.len() <= MAX_AGENTS)
            .ok_or_else(|| format!("Could not read {}", path.display()))?;
        let teams = match source.legacy() {
            Some(_) if records.iter().any(|record| record["team_id"].is_string()) => {
                old_teams(&path.with_file_name("teams.json"))
            }
            _ => Ok(vec![]),
        };
        let known = teams.as_deref().unwrap_or_default();
        let found = records
            .iter()
            .filter_map(|record| portable(source, record, records, known))
            .collect();
        Ok((found, teams.map(drop)))
    }
}

/// A store's identities, each with where its key is, and whether its teams
/// could be read.
type Read = (Vec<(Portable, String)>, Result<()>);

/// Old Buzz's teams beside its agents, built-in ones left out. A missing file
/// has none; any invalid team makes the file unreadable.
fn old_teams(path: &std::path::Path) -> Result<Vec<OldTeam>> {
    if !path.try_exists().unwrap_or(true) {
        return Ok(vec![]);
    }
    let unreadable = || format!("Could not read {}", path.display());
    let file = read_json(path, false).map_err(|_| unreadable())?;
    let teams = file
        .as_array()
        .filter(|teams| teams.len() <= MAX_AGENTS)
        .ok_or_else(unreadable)?;
    let mut ids = BTreeSet::new();
    let mut found = vec![];
    for team in teams {
        let id = team["id"].as_str().unwrap_or("");
        let instructions = match &team["instructions"] {
            Value::Null => "",
            value => value.as_str().ok_or_else(unreadable)?,
        };
        if id.is_empty()
            || id.len() > 256
            || id.contains('\0')
            || !ids.insert(id)
            || instructions.len() > 128 * 1024
            || instructions.contains('\0')
        {
            return Err(unreadable());
        }
        if team["is_builtin"].as_bool() != Some(true) {
            found.push(OldTeam {
                id: id.into(),
                name: team_name(team["name"].as_str().unwrap_or("")),
                instructions: instructions.trim().into(),
            });
        }
    }
    Ok(found)
}

/// Trimmed, at most 120 UTF-16 units as the app counts them, never splitting a
/// character; a blank name gets a stand-in.
fn team_name(raw: &str) -> String {
    let name = raw.trim();
    if name.is_empty() {
        return "Team from old Buzz".into();
    }
    let mut units = 0;
    name.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 120
        })
        .collect()
}

fn portable(
    source: PortSource,
    record: &Value,
    records: &[Value],
    teams: &[OldTeam],
) -> Option<(Portable, String)> {
    let text = |key: &str| record.get(key).and_then(Value::as_str).unwrap_or("");
    let harness = source == PortSource::Harness;
    let pubkey = text("pubkey");
    let relay =
        canonical_relay(text(if harness { "relayUrl" } else { "relay_url" })).unwrap_or_default();
    let name = text("name").trim();
    if !canonical_key(pubkey) || name.is_empty() {
        return None;
    }
    let credential = if harness {
        Some(text("credentialId"))
            .filter(|id| !id.is_empty())
            .map_or_else(|| agent_id(pubkey, &relay), str::to_owned)
    } else {
        text("private_key_nsec").to_owned()
    };
    // A harness string is authoritative, including "" for explicit removal.
    // Legacy imports saved no override but retained the identity's artwork and
    // linked definition; snapshots retained their public profile's avatarUrl.
    let picture = if harness {
        record["picture"].as_str().or_else(|| {
            let imported = &record["imported"];
            let saved = &imported["record"];
            if saved["profile"].is_object() {
                saved["profile"]["avatarUrl"].as_str()
            } else {
                saved["avatar_url"]
                    .as_str()
                    .or_else(|| imported["definition"]["avatar_url"].as_str())
            }
        })
    } else {
        record["avatar_url"].as_str()
    }
    .filter(|url| public_picture(url))
    .map(str::to_owned);
    Some((
        Portable {
            source,
            pubkey: pubkey.into(),
            name: name.into(),
            picture,
            about: description(source, record, records),
            relay,
            carry: Carry {
                // Old Buzz ran an instance's own prompt, never its definition's.
                instructions: present(text(if harness {
                    "systemPrompt"
                } else {
                    "system_prompt"
                })),
                // Old Buzz saved no workspace.
                workspace: harness.then(|| present(text("workspace"))).flatten(),
            },
            // Missing from the file: deleted in old Buzz, or one it built in.
            team: teams
                .iter()
                .find(|team| record["team_id"].as_str() == Some(&team.id))
                .cloned(),
        },
        credential,
    ))
}

/// Old Buzz's linked definition owns the authored description, never a stale
/// instance copy. Harness imports retain either that definition or a snapshot's
/// public profile. A missing/blank source stays absent; no community lookup.
fn description(source: PortSource, record: &Value, records: &[Value]) -> Option<String> {
    let value = if source == PortSource::Harness {
        let imported = &record["imported"];
        let saved = &imported["record"];
        if saved["profile"]["about"].is_string() {
            &saved["profile"]["about"]
        } else if saved["persona_id"].is_string() {
            &imported["definition"]["description"]
        } else {
            &saved["description"]
        }
    } else if let Some(persona) = record["persona_id"].as_str() {
        &records.iter().find(|definition| {
            definition["pubkey"].as_str().unwrap_or("").is_empty()
                && definition["slug"].as_str() == Some(persona)
        })?["description"]
    } else {
        &record["description"]
    };
    present(value.as_str()?)
}

fn present(text: &str) -> Option<String> {
    Some(text.trim())
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// A profile picture is a public HTTPS URL of bounded length, never inline data.
pub(crate) fn public_picture(url: &str) -> bool {
    url.len() <= 2048
        && url::Url::parse(url).is_ok_and(|url| {
            url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
        })
}

#[cfg(test)]
mod tests;
