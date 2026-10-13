//! Agent state shared by every program that runs this machine's agents: each
//! agent's settings, the owner's teams, unfinished setups, and the agent types'
//! saved sessions. It lives in `agents/state/`, next to `identities.json`, so
//! the app and the standalone `buzz-agent-host` read and write the same state.
//!
//! One file per key, each replaced whole through a rename, so a crash leaves
//! the last complete copy, and two programs that write different keys never
//! overwrite each other. The `hosts/` locks decide which program runs an agent.
use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// The largest value kept, as an upper bound on what `localStorage` held.
const VALUE_LIMIT: usize = 4 * 1024 * 1024;
const KEY_LIMIT: usize = 200;
const TEMPORARY: &str = ".tmp";

pub(crate) struct AgentState {
    dir: Result<PathBuf, String>,
}

impl AgentState {
    /// `dir` is `agents/state`.
    pub(crate) fn new(dir: Result<PathBuf, String>) -> Self {
        Self { dir }
    }

    fn dir(&self) -> Result<&Path, String> {
        self.dir.as_deref().map_err(Clone::clone)
    }

    /// Every key and its value. Unreadable or foreign files are skipped.
    pub(crate) fn load(&self) -> Result<HashMap<String, String>, String> {
        let dir = self.dir()?;
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(_) => return Err("Could not read agent state".into()),
        };
        let mut items = HashMap::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(key) = name.to_str().and_then(decode) else {
                continue;
            };
            if let Ok(value) = fs::read_to_string(entry.path()) {
                items.insert(key, value);
            }
        }
        Ok(items)
    }

    /// Saves `value` under `key`, or removes the key when `value` is `None`.
    pub(crate) fn set(&self, key: &str, value: Option<&str>) -> Result<(), String> {
        if key.is_empty() || key.len() > KEY_LIMIT {
            return Err("Invalid agent state key".into());
        }
        let dir = self.dir()?;
        let path = dir.join(encode(key));
        let Some(value) = value else {
            return match fs::remove_file(&path) {
                Err(error) if error.kind() != ErrorKind::NotFound => {
                    Err("Could not save agent state".into())
                }
                _ => Ok(()),
            };
        };
        if value.len() > VALUE_LIMIT {
            return Err("Agent state is too large".into());
        }
        let saved = (|| {
            fs::create_dir_all(dir)?;
            let mut file = tempfile::Builder::new()
                .suffix(TEMPORARY)
                .tempfile_in(dir)?;
            std::io::Write::write_all(&mut file, value.as_bytes())?;
            file.as_file().sync_all()?;
            file.persist(&path).map_err(|error| error.error)?;
            Ok::<_, std::io::Error>(())
        })();
        saved.map_err(|_| "Could not save agent state".into())
    }
}

/// A file name for `key`: bytes other than `A-Z a-z 0-9 . _ -` become `%XX`.
pub(crate) fn encode(key: &str) -> String {
    let mut name = String::with_capacity(key.len());
    for byte in key.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') {
            name.push(byte as char);
        } else {
            name.push_str(&format!("%{byte:02X}"));
        }
    }
    name
}

/// The key a file name holds, or `None` for a file that is not one, such as a
/// write in progress.
pub(crate) fn decode(name: &str) -> Option<String> {
    if name.is_empty() || name.ends_with(TEMPORARY) || name.starts_with('.') {
        return None;
    }
    let bytes = name.as_bytes();
    let mut key = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let hex = name.get(index + 1..index + 3)?;
                key.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            byte if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') => {
                key.push(byte);
                index += 1;
            }
            _ => return None,
        }
    }
    String::from_utf8(key).ok()
}

#[tauri::command]
pub(crate) async fn app_agent_state_load(
    state: tauri::State<'_, AgentState>,
) -> Result<HashMap<String, String>, String> {
    state.load()
}

#[tauri::command]
pub(crate) async fn app_agent_state_set(
    state: tauri::State<'_, AgentState>,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    state.set(&key, value.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip() {
        for key in [
            "buzz.agents.v1",
            "buzz.codex.sessions.v4:wss://relay.example/a:ab",
            "a/b c%d",
        ] {
            let name = encode(key);
            assert!(!name.contains('/') && !name.contains(':'), "{name}");
            assert_eq!(decode(&name).as_deref(), Some(key));
        }
        assert_eq!(decode("x.tmp"), None);
        assert_eq!(decode(".hidden"), None);
        assert_eq!(decode("bad%Z"), None);
        assert_eq!(decode("has space"), None);
    }

    #[test]
    fn saves_loads_and_removes() {
        let root = tempfile::tempdir().unwrap();
        let state = AgentState::new(Ok(root.path().join("state")));
        assert!(state.load().unwrap().is_empty());
        state.set("one:a", Some("1")).unwrap();
        state.set("two", Some("2")).unwrap();
        state.set("two", Some("22")).unwrap();
        fs::write(root.path().join("state").join("partial.tmp"), "x").unwrap();
        let items = state.load().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items["one:a"], "1");
        assert_eq!(items["two"], "22");
        state.set("one:a", None).unwrap();
        state.set("missing", None).unwrap();
        assert_eq!(state.load().unwrap().keys().collect::<Vec<_>>(), ["two"]);
        assert!(state.set("", Some("x")).is_err());
        assert!(state.set(&"k".repeat(KEY_LIMIT + 1), Some("x")).is_err());
    }
}
