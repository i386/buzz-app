use super::*;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Mutex;

/// Saved keys by credential ID, and old Buzz's by source and pubkey.
#[derive(Default)]
struct Memory(Mutex<BTreeMap<String, String>>);
impl Credentials for Memory {
    fn read_legacy(&self, source: LegacySource, pubkey: &str) -> Result<Secret> {
        let saved = self.0.lock().unwrap();
        let hex = saved
            .get(&format!("{}:{pubkey}", source.keyring_service()))
            .ok_or("Absent")?;
        Secret::parse(hex, pubkey)
    }
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>> {
        let saved = self.0.lock().unwrap();
        saved
            .get(id)
            .map(|hex| Secret::parse(hex, pubkey))
            .transpose()
    }
    fn add(&self, id: &str, key: &Secret) -> Result<()> {
        let mut saved = self.0.lock().unwrap();
        saved.insert(id.into(), key.hex().to_string());
        Ok(())
    }
    fn delete(&self, id: &str, _: &str) -> Result<()> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

fn stores(dir: &std::path::Path) -> OldStores {
    OldStores {
        harness: dir.join("app/agent-controller/agents.json"),
        data_dir: dir.join("data"),
    }
}
fn write(path: std::path::PathBuf, value: Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, value.to_string()).unwrap();
}
fn legacy(dir: &std::path::Path, source: LegacySource, value: Value) {
    let path = dir
        .join("data")
        .join(source.app_directory())
        .join("agents/managed-agents.json");
    write(path, value);
}
fn key() -> Secret {
    Secret::generate().unwrap()
}

#[test]
fn lists_each_identity_once_preferring_the_harness_copy() {
    let dir = tempfile::tempdir().unwrap();
    let (shared, old, dev) = (key(), key(), key());
    write(
        stores(dir.path()).harness,
        json!({"version": 1, "agents": [{
            "pubkey": shared.pubkey(), "relayUrl": "wss://relay.example",
            "name": "Ada", "picture": "data:image/png;base64,AA",
            "credentialId": "ignored-by-list",
        }]}),
    );
    legacy(
        dir.path(),
        LegacySource::Installed,
        json!([
            {"pubkey": shared.pubkey(), "name": "Ada (old)", "relay_url": "wss://old.example"},
            {"pubkey": old.pubkey(), "name": " Bea ", "relay_url": "wss://old.example/",
             "avatar_url": "https://old.example/media/b.png"},
            // A persona with no identity, and an unnamed identity.
            {"pubkey": "", "name": "Persona"},
            {"pubkey": key().pubkey(), "name": ""},
        ]),
    );
    legacy(
        dir.path(),
        LegacySource::Development,
        json!([{"pubkey": dev.pubkey(), "name": "Cy", "relay_url": "not a relay"}]),
    );
    let found = stores(dir.path()).list();
    assert!(found.warnings.is_empty());
    assert_eq!(
        found.agents,
        [
            Portable {
                source: PortSource::Harness,
                pubkey: shared.pubkey().into(),
                name: "Ada".into(),
                picture: None,
                about: None,
                relay: "wss://relay.example".into(),
                carry: Carry::default(),
                team: None,
            },
            Portable {
                source: PortSource::Installed,
                pubkey: old.pubkey().into(),
                name: "Bea".into(),
                picture: Some("https://old.example/media/b.png".into()),
                about: None,
                relay: "wss://old.example".into(),
                carry: Carry::default(),
                team: None,
            },
            Portable {
                source: PortSource::Development,
                pubkey: dev.pubkey().into(),
                name: "Cy".into(),
                picture: None,
                about: None,
                relay: String::new(),
                carry: Carry::default(),
                team: None,
            },
        ]
    );
}

#[test]
fn carries_each_stores_own_instructions_and_the_harness_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let (harness, old, linked, blank) = (key(), key(), key(), key());
    write(
        stores(dir.path()).harness,
        json!({"agents": [{
            "pubkey": harness.pubkey(), "relayUrl": "wss://relay.example", "name": "Ada",
            "systemPrompt": " Review PRs.\n", "workspace": "~/code",
        }, {
            "pubkey": blank.pubkey(), "relayUrl": "wss://relay.example", "name": "Dee",
            "systemPrompt": "  ", "workspace": "",
        }]}),
    );
    legacy(
        dir.path(),
        LegacySource::Installed,
        json!([
            {"pubkey": old.pubkey(), "name": "Bea", "system_prompt": "Triage.", "workspace": "~/x"},
            // Old Buzz ran the instance's prompt; its definition's is not used.
            {"pubkey": "", "slug": "reviewer", "name": "Reviewer", "system_prompt": "Persona."},
            {"pubkey": linked.pubkey(), "name": "Cy", "persona_id": "reviewer", "system_prompt": null},
        ]),
    );
    let carried: BTreeMap<_, _> = stores(dir.path())
        .list()
        .agents
        .into_iter()
        .map(|agent| (agent.name, agent.carry))
        .collect();
    assert_eq!(
        carried,
        BTreeMap::from([
            (
                "Ada".into(),
                Carry {
                    instructions: Some("Review PRs.".into()),
                    workspace: Some("~/code".into()),
                }
            ),
            (
                "Bea".into(),
                Carry {
                    instructions: Some("Triage.".into()),
                    workspace: None,
                }
            ),
            ("Cy".into(), Carry::default()),
            ("Dee".into(), Carry::default()),
        ])
    );
    // Listing never shows them; only taking the agent over does.
    assert!(!serde_json::to_string(&stores(dir.path()).list())
        .unwrap()
        .contains("Review PRs"));
}

#[test]
fn missing_stores_list_nothing_and_a_broken_one_hides_only_itself() {
    let dir = tempfile::tempdir().unwrap();
    assert!(stores(dir.path()).list().agents.is_empty());
    assert!(stores(dir.path()).list().warnings.is_empty());
    let old = key();
    write(stores(dir.path()).harness, json!({"agents": "nope"}));
    legacy(
        dir.path(),
        LegacySource::Installed,
        json!([{"pubkey": old.pubkey(), "name": "Bea"}]),
    );
    let found = stores(dir.path()).list();
    assert_eq!(found.warnings.len(), 1);
    assert_eq!(found.agents.len(), 1);
    assert_eq!(found.agents[0].pubkey, old.pubkey());
}

#[test]
fn takes_the_key_from_the_store_it_was_listed_in() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (harness, old, inline) = (key(), key(), key());
    let id = agent_id(harness.pubkey(), "wss://relay.example");
    credentials.add(&id, &harness).unwrap();
    credentials.0.lock().unwrap().insert(
        format!("buzz-desktop:{}", old.pubkey()),
        old.hex().to_string(),
    );
    write(
        stores(dir.path()).harness,
        json!({"agents": [{
            "pubkey": harness.pubkey(), "relayUrl": "wss://relay.example",
            "name": "Ada", "credentialId": id,
        }]}),
    );
    legacy(
        dir.path(),
        LegacySource::Installed,
        json!([
            {"pubkey": old.pubkey(), "name": "Bea", "description": " Reviews PRs ",
             "avatar_url": "https://old.example/bea.png"},
            {"pubkey": inline.pubkey(), "name": "Cy", "private_key_nsec": inline.hex().to_string()},
        ]),
    );
    let stores = stores(dir.path());
    let (agent, key) = stores
        .take(PortSource::Harness, harness.pubkey(), &credentials)
        .unwrap();
    assert_eq!(
        (agent.name.as_str(), key.pubkey()),
        ("Ada", harness.pubkey())
    );
    let (agent, key) = stores
        .take(PortSource::Installed, old.pubkey(), &credentials)
        .unwrap();
    assert_eq!((agent.name.as_str(), key.pubkey()), ("Bea", old.pubkey()));
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(key.pubkey())).unwrap();
    let prepared = crate::AppAgents::adopt(
        "wss://relay.example",
        &auth[1],
        "p/t",
        key,
        &agent.name,
        agent.picture,
        agent.about,
    )
    .unwrap();
    let destination = crate::AppAgents::open(dir.path().join("agents/identities.json"));
    let (agent, key) = destination.commit(prepared, &auth, &credentials).unwrap();
    let reopened = destination.get(&agent.pubkey).unwrap();
    let profile = reopened.profile_event(&key).unwrap();
    let content: Value = serde_json::from_str(profile["content"].as_str().unwrap()).unwrap();
    assert_eq!(
        content,
        json!({"name": "Bea", "bot": true,
        "picture": "https://old.example/bea.png", "about": "Reviews PRs"})
    );
    let event: nostr::event::Event = serde_json::from_value(profile).unwrap();
    event.verify().unwrap();
    // A key old Buzz kept in the record is read from there, not the keychain.
    let (_, key) = stores
        .take(PortSource::Installed, inline.pubkey(), &credentials)
        .unwrap();
    assert_eq!(key.pubkey(), inline.pubkey());
    assert!(!serde_json::to_string(&stores.list())
        .unwrap()
        .contains(&*inline.hex()));
    // Each source reads only its own store.
    assert!(stores
        .take(PortSource::Development, old.pubkey(), &credentials)
        .is_err());
    assert!(stores
        .take(PortSource::Harness, old.pubkey(), &credentials)
        .is_err());
}

#[test]
fn imports_authored_descriptions_from_the_saved_profile_or_exact_definition() {
    let dir = tempfile::tempdir().unwrap();
    let keys: Vec<_> = (0..7).map(|_| key()).collect();
    write(
        stores(dir.path()).harness,
        json!({"agents": [
            {"pubkey": keys[0].pubkey(), "name": "Snapshot", "imported": {
                "record": {"profile": {"about": " Snapshot description "}}
            }},
            {"pubkey": keys[1].pubkey(), "name": "Imported legacy", "imported": {
                "record": {"persona_id": "reviewer", "description": "stale"},
                "definition": {"description": " Retained definition "}
            }}
        ]}),
    );
    let records = json!([
        {"pubkey": keys[2].pubkey(), "name": "Linked", "persona_id": "reviewer", "description": "stale"},
        {"pubkey": "", "slug": "reviewer", "description": " Reviews PRs.\nCarefully. "},
        {"pubkey": keys[3].pubkey(), "name": "Standalone", "description": " Standalone description "},
        {"pubkey": keys[4].pubkey(), "name": "Orphan", "persona_id": "missing", "description": "stale"},
        {"pubkey": keys[5].pubkey(), "name": "Blank", "persona_id": "blank", "description": "stale"},
        {"pubkey": "", "slug": "blank", "description": "  "},
        {"pubkey": keys[6].pubkey(), "name": "Unrelated", "description": "Other description"}
    ]);
    // Both legacy installation paths have the same persisted format.
    for source in [LegacySource::Installed, LegacySource::Development] {
        legacy(dir.path(), source, records.clone());
        let found = stores(dir.path()).list();
        assert!(found.warnings.is_empty());
        let descriptions: Vec<_> = found
            .agents
            .iter()
            .map(|agent| serde_json::to_value(agent).unwrap()["about"].clone())
            .collect();
        assert_eq!(
            descriptions,
            vec![
                json!("Snapshot description"),
                json!("Retained definition"),
                json!("Reviews PRs.\nCarefully."),
                json!("Standalone description"),
                Value::Null,
                Value::Null,
                json!("Other description"),
            ]
        );
        std::fs::remove_file(
            dir.path()
                .join("data")
                .join(source.app_directory())
                .join("agents/managed-agents.json"),
        )
        .unwrap();
    }
}

#[test]
fn retained_harness_artwork_survives_agents_storage_and_signed_publication() {
    let retained = json!({
        "record": {"persona_id": "reviewer", "avatar_url": "https://old.example/identity.png"},
        "definition": {"slug": "reviewer", "avatar_url": "https://old.example/definition.png"}
    });
    let mut inherited = retained.clone();
    inherited["record"]["avatar_url"] = Value::Null;
    let snapshot = json!({"record": {"profile": {
        "avatarUrl": "https://old.example/snapshot.png", "avatarDataUrl": "data:image/png;base64,AA"
    }}});
    let mut unsafe_legacy = retained.clone();
    unsafe_legacy["record"]["avatar_url"] = json!("https://user:secret@old.example/private.png");
    for (current, imported, expected) in [
        (
            Value::Null,
            retained.clone(),
            Some("https://old.example/identity.png"),
        ),
        (
            Value::Null,
            inherited,
            Some("https://old.example/definition.png"),
        ),
        (
            Value::Null,
            snapshot,
            Some("https://old.example/snapshot.png"),
        ),
        (
            json!("https://new.example/current.png"),
            retained.clone(),
            Some("https://new.example/current.png"),
        ),
        // Empty is an explicit harness removal, not a missing override.
        (json!(""), retained.clone(), None),
        (json!("data:image/png;base64,AA"), retained, None),
        (Value::Null, unsafe_legacy, None),
        (Value::Null, Value::Null, None),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let credentials = Memory::default();
        let key = key();
        let id = agent_id(key.pubkey(), "wss://relay.example");
        credentials.add(&id, &key).unwrap();
        let stores = stores(dir.path());
        write(
            stores.harness.clone(),
            json!({"version": 1, "agents": [{
                "pubkey": key.pubkey(), "relayUrl": "wss://relay.example", "name": "Ada",
                "credentialId": id, "picture": current, "imported": imported
            }]}),
        );
        // The harness wins over the installed copy of this exact identity.
        legacy(
            dir.path(),
            LegacySource::Installed,
            json!([{
                "pubkey": key.pubkey(), "name": "Old Ada", "avatar_url": "https://old.example/installed.png"
            }]),
        );
        let found = stores.list();
        assert!(found.warnings.is_empty());
        assert_eq!(found.agents.len(), 1);
        assert_eq!(found.agents[0].source, PortSource::Harness);
        let (agent, key) = stores
            .take(found.agents[0].source, key.pubkey(), &credentials)
            .unwrap();
        let auth: Vec<String> =
            serde_json::from_str(&crate::secret::test_attestation(key.pubkey())).unwrap();
        let prepared = crate::AppAgents::adopt(
            "wss://relay.example",
            &auth[1],
            "p/t",
            key,
            &agent.name,
            agent.picture,
            agent.about,
        )
        .unwrap();
        let path = dir.path().join("agents/identities.json");
        let (agent, _) = crate::AppAgents::open(path.clone())
            .commit(prepared, &auth, &credentials)
            .unwrap();
        let reopened = crate::AppAgents::open(path).get(&agent.pubkey).unwrap();
        let event = reopened
            .profile_event(&reopened.read_key(&credentials).unwrap())
            .unwrap();
        assert_eq!(event["kind"], 0);
        let content: Value = serde_json::from_str(event["content"].as_str().unwrap()).unwrap();
        assert_eq!(content.get("picture").and_then(Value::as_str), expected);
        let event: nostr::event::Event = serde_json::from_value(event).unwrap();
        event.verify().unwrap();
    }
}

/// Old Buzz's team file and agent library, scrubbed: no keys, made-up names.
fn old_buzz(dir: &std::path::Path, source: LegacySource) {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/old-buzz-teams");
    let agents = dir.join("data").join(source.app_directory()).join("agents");
    std::fs::create_dir_all(&agents).unwrap();
    for file in ["teams.json", "managed-agents.json"] {
        std::fs::copy(fixture.join(file), agents.join(file)).unwrap();
    }
}
fn team_of(found: &[Portable], name: &str) -> Option<OldTeam> {
    found
        .iter()
        .find(|agent| agent.name == name)
        .unwrap()
        .team
        .clone()
}

#[test]
fn attaches_each_old_buzz_agents_live_team() {
    let dir = tempfile::tempdir().unwrap();
    old_buzz(dir.path(), LegacySource::Installed);
    let found = stores(dir.path()).list();
    assert!(found.warnings.is_empty());
    let sietch = OldTeam {
        id: "6f9c2d1e-4b7a-4e8f-9a3c-2d5e8f1b7c40".into(),
        name: "Sietch Tabr".into(),
        instructions: "Ship small, verified changes.\nReport in the originating thread.".into(),
    };
    assert_eq!(team_of(&found.agents, "Stilgar"), Some(sietch.clone()));
    assert_eq!(team_of(&found.agents, "Chani"), Some(sietch));
    // Built in to old Buzz, by its flag: never brought over.
    assert_eq!(team_of(&found.agents, "Fizz"), None);
    // A user's own team with the built-in one's name still comes.
    assert_eq!(
        team_of(&found.agents, "Greeter").map(|team| team.name),
        Some("Welcome Team".into())
    );
    // Deleted in old Buzz, or never on one.
    assert_eq!(team_of(&found.agents, "Ghost"), None);
    assert_eq!(team_of(&found.agents, "Loner"), None);
    let nameless = team_of(&found.agents, "Nameless").unwrap();
    assert_eq!(
        (nameless.name.as_str(), nameless.instructions.as_str()),
        ("Team from old Buzz", "")
    );
    // The list shows it on the card; the definition is not an agent.
    let json = serde_json::to_value(&found).unwrap();
    assert_eq!(json["agents"][0]["team"]["name"], "Sietch Tabr");
    assert!(json["agents"][4].get("team").is_none());
    assert_eq!(found.agents.len(), 7);

    // Development's copy has the same old IDs, so the same team.
    old_buzz(dir.path(), LegacySource::Development);
    let (dev, teams) = stores(dir.path()).read(PortSource::Development).unwrap();
    assert!(teams.is_ok());
    let dev: Vec<Portable> = dev.into_iter().map(|(agent, _)| agent).collect();
    assert_eq!(team_of(&dev, "Chani"), team_of(&found.agents, "Chani"));
}

#[test]
fn unreadable_teams_warn_and_leave_every_agent_importable() {
    let teams_path = |dir: &std::path::Path| {
        dir.join("data")
            .join(LegacySource::Installed.app_directory())
            .join("agents/teams.json")
    };
    let member = json!([{"pubkey": "1".repeat(64), "name": "Stilgar", "team_id": "t"}]);
    // A missing file: no teams and nothing to report.
    let dir = tempfile::tempdir().unwrap();
    legacy(dir.path(), LegacySource::Installed, member.clone());
    let found = stores(dir.path()).list();
    assert!(found.warnings.is_empty());
    assert_eq!(found.agents[0].team, None);
    for broken in [
        json!({"teams": []}),
        json!([{"id": "t", "name": "A"}, {"id": "t", "name": "B"}]),
        json!([{"id": "", "name": "A"}]),
        json!([{"id": "t", "name": "A", "instructions": 7}]),
        json!([{"id": "t", "name": "A", "instructions": "a\0b"}]),
        json!([{"id": "t", "name": "A", "instructions": "x".repeat(128 * 1024 + 1)}]),
    ] {
        let dir = tempfile::tempdir().unwrap();
        legacy(dir.path(), LegacySource::Installed, member.clone());
        write(teams_path(dir.path()), broken.clone());
        let found = stores(dir.path()).list();
        assert_eq!(found.warnings.len(), 1, "{broken}");
        assert_eq!(found.agents.len(), 1);
        assert_eq!(found.agents[0].team, None);
    }
    // Not JSON at all.
    let dir = tempfile::tempdir().unwrap();
    legacy(dir.path(), LegacySource::Installed, member);
    std::fs::write(teams_path(dir.path()), "{").unwrap();
    assert_eq!(stores(dir.path()).list().warnings.len(), 1);
}

#[test]
fn team_names_are_trimmed_bounded_and_never_blank() {
    assert_eq!(team_name("  Sietch  "), "Sietch");
    assert_eq!(team_name(" \n "), "Team from old Buzz");
    assert_eq!(team_name(&"a".repeat(130)), "a".repeat(120));
    // 119 units, then a two-unit character that would cross 120: dropped whole.
    assert_eq!(
        team_name(&format!("{}😀b", "a".repeat(119))),
        "a".repeat(119)
    );
}

#[test]
fn taking_an_agent_rereads_its_team() {
    let dir = tempfile::tempdir().unwrap();
    let agent = key();
    let teams = |name: &str, text: &str| json!([{"id": "t", "name": name, "instructions": text}]);
    legacy(
        dir.path(),
        LegacySource::Installed,
        json!([{"pubkey": agent.pubkey(), "name": "Stilgar", "team_id": "t",
                "private_key_nsec": agent.hex().to_string()}]),
    );
    let path = dir
        .path()
        .join("data")
        .join(LegacySource::Installed.app_directory())
        .join("agents/teams.json");
    write(path.clone(), teams("Before", "old text"));
    let stores = stores(dir.path());
    assert_eq!(
        stores.list().agents[0].team.as_ref().unwrap().name,
        "Before"
    );
    write(path.clone(), teams("After", "new text"));
    let (taken, _) = stores
        .take(PortSource::Installed, agent.pubkey(), &Memory::default())
        .unwrap();
    assert_eq!(
        taken.team,
        Some(OldTeam {
            id: "t".into(),
            name: "After".into(),
            instructions: "new text".into(),
        })
    );
    // Unreadable now: the agent still comes, with no team.
    std::fs::write(&path, "{").unwrap();
    let (taken, _) = stores
        .take(PortSource::Installed, agent.pubkey(), &Memory::default())
        .unwrap();
    assert_eq!(taken.team, None);
}
