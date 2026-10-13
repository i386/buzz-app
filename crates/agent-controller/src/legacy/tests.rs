use super::*;
use crate::{LegacySource, Secret};
use serde_json::{json, Value};
use std::sync::Mutex;

#[derive(Default)]
struct Keychain(Mutex<(Vec<String>, bool)>);
impl Credentials for Keychain {
    fn delete(&self, id: &str, _: &str) -> Result<()> {
        let mut state = self.0.lock().unwrap();
        if state.1 && id.starts_with('b') {
            state.1 = false;
            return Err("keychain interrupted".into());
        }
        state.0.push(id.into());
        Ok(())
    }
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret> {
        unreachable!()
    }
    fn read(&self, _: &str, _: &str) -> Result<Option<Secret>> {
        unreachable!()
    }
    fn add(&self, _: &str, _: &Secret) -> Result<()> {
        unreachable!()
    }
}
fn row(key: &str) -> Value {
    let relay = "wss://relay.example";
    let id = agent_id(key, relay);
    json!({"id": id, "pubkey": key, "relayUrl": relay, "credentialId": id,
        "imported": {"record": {"backend": {"type": "provider"}, "backend_agent_id": "remote"}}})
}
fn registry(dir: &std::path::Path, value: Value) -> Vec<u8> {
    let bytes = serde_json::to_vec(&value).unwrap();
    std::fs::write(dir.join("agents.json"), &bytes).unwrap();
    bytes
}
#[test]
fn deletion_resumes_and_keeps_remote_and_local_records_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let first = row(&"a".repeat(64));
    let second = row(&"b".repeat(64));
    let bytes = registry(dir.path(), json!({"version":1,"agents":[first,second]}));
    let credentials = Keychain(Mutex::new((vec![], true)));
    assert!(delete_local_agent_keys(dir.path().into(), &credentials).is_err());
    assert_eq!(credentials.0.lock().unwrap().0.len(), 1);
    delete_local_agent_keys(dir.path().into(), &credentials).unwrap();
    let calls = &credentials.0.lock().unwrap().0;
    assert_eq!(
        calls,
        &[
            first["credentialId"].as_str().unwrap(),
            first["credentialId"].as_str().unwrap(),
            second["credentialId"].as_str().unwrap()
        ]
    );
    assert_eq!(
        std::fs::read(dir.path().join("agents.json")).unwrap(),
        bytes
    );
}
#[test]
fn missing_registry_is_done_but_bad_or_future_registry_removes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Keychain::default();
    delete_local_agent_keys(dir.path().join("absent"), &credentials).unwrap();
    delete_local_agent_keys(dir.path().into(), &credentials).unwrap();
    for value in [
        json!({}),
        json!({"version":2,"agents":[]}),
        json!({"version":1,"agents":[row(&"a".repeat(64)),{}]}),
        json!({"version":1,"agents":[row(&"a".repeat(64)),row(&"a".repeat(64))]}),
    ] {
        registry(dir.path(), value);
        assert!(delete_local_agent_keys(dir.path().into(), &credentials).is_err());
    }
    let mut wrong = row(&"a".repeat(64));
    wrong["credentialId"] = row(&"b".repeat(64))["credentialId"].clone();
    registry(dir.path(), json!({"version":1,"agents":[wrong]}));
    assert!(delete_local_agent_keys(dir.path().into(), &credentials).is_err());
    assert!(credentials.0.lock().unwrap().0.is_empty());
}
#[test]
fn a_live_controller_lock_prevents_key_deletion() {
    let dir = tempfile::tempdir().unwrap();
    registry(
        dir.path(),
        json!({"version":1,"agents":[row(&"a".repeat(64))]}),
    );
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.path().join("controller.lock"))
        .unwrap();
    lock.lock().unwrap();
    let credentials = Keychain::default();
    assert!(delete_local_agent_keys(dir.path().into(), &credentials).is_err());
    assert!(credentials.0.lock().unwrap().0.is_empty());
    drop(lock);
    delete_local_agent_keys(dir.path().into(), &credentials).unwrap();
    assert_eq!(credentials.0.lock().unwrap().0.len(), 1);
}
#[cfg(unix)]
#[test]
fn symlinked_registry_directory_file_or_lock_never_deletes_a_key() {
    use std::os::unix::fs::symlink;
    for target in ["directory", "agents.json", "controller.lock"] {
        let dir = tempfile::tempdir().unwrap();
        let actual = dir.path().join("actual");
        std::fs::create_dir(&actual).unwrap();
        registry(
            &actual,
            json!({"version":1,"agents":[row(&"a".repeat(64))]}),
        );
        let root = dir.path().join("config");
        if target == "directory" {
            symlink(&actual, &root).unwrap();
        } else {
            std::fs::create_dir(&root).unwrap();
            registry(&root, json!({"version":1,"agents":[row(&"a".repeat(64))]}));
            if target == "agents.json" {
                std::fs::remove_file(root.join(target)).unwrap();
            } else {
                std::fs::write(actual.join(target), "").unwrap();
            }
            symlink(actual.join(target), root.join(target)).unwrap();
        }
        let credentials = Keychain::default();
        assert!(delete_local_agent_keys(root, &credentials).is_err());
        assert!(credentials.0.lock().unwrap().0.is_empty());
    }
}
