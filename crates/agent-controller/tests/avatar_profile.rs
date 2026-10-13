use buzz_agent_controller::{CreationProfile, Secret};
use secp256k1::{schnorr::Signature, Keypair, Secp256k1, SecretKey, XOnlyPublicKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
fn profile(picture: Option<&str>) -> CreationProfile {
    CreationProfile {
        credential_id: "isolated-test".into(),
        pubkey: PUB.into(),
        url: "https://relay.example/events".into(),
        auth: json!(["auth", "owner", "", "signature"]).to_string(),
        name: "New name".into(),
        picture: picture.map(str::to_owned),
        name_pending: false,
        about: None,
        revision: 2,
    }
}
fn signed(content: &str, at: u64, kind: u16) -> Value {
    let tags = vec![
        vec!["custom".to_owned(), "keep".to_owned()],
        vec!["auth".to_owned(), "old".to_owned()],
    ];
    let hash =
        Sha256::digest(serde_json::to_vec(&json!([0, PUB, at, kind, tags, content])).unwrap());
    let mut bytes = [0; 32];
    bytes[31] = 1;
    let pair = Keypair::from_secret_key(
        &Secp256k1::new(),
        &SecretKey::from_byte_array(bytes).unwrap(),
    );
    let sig = Secp256k1::new().sign_schnorr_no_aux_rand(&hash, &pair);
    json!({"id":format!("{hash:x}"), "pubkey":PUB, "created_at":at, "kind":kind, "tags":tags, "content":content, "sig":sig.to_string()})
}
fn verify(event: &Value) {
    let hash = Sha256::digest(
        serde_json::to_vec(&json!([
            0,
            event["pubkey"],
            event["created_at"],
            event["kind"],
            event["tags"],
            event["content"]
        ]))
        .unwrap(),
    );
    assert_eq!(event["id"], format!("{hash:x}"));
    let key: XOnlyPublicKey = PUB.parse().unwrap();
    let sig: Signature = event["sig"].as_str().unwrap().parse().unwrap();
    Secp256k1::verification_only()
        .verify_schnorr(&sig, &hash, &key)
        .unwrap();
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[test]
fn replacement_preserves_unowned_metadata_and_omitted_picture_but_can_clear() {
    let key = Secret::parse(KEY, PUB).unwrap();
    let old = signed(&json!({"name":"Old", "display_name":"External display", "bot":false, "picture":"https://images.example/old.png", "about":"Keep me", "nip05":"alice@example.com", "extension":{"nested":[1,2]}}).to_string(), now(), 0);
    for (picture, name_pending) in [
        (None, false),
        (Some("https://images.example/new.png"), false),
        (Some(""), false),
        (None, true),
    ] {
        let mut publication = profile(picture);
        publication.name_pending = name_pending;
        publication.name = "Luna".into();
        let event = publication.event(&key, std::slice::from_ref(&old)).unwrap();
        verify(&event);
        assert_eq!(
            event["tags"],
            json!([["custom", "keep"], ["auth", "owner", "", "signature"]])
        );
        let content: Value = serde_json::from_str(event["content"].as_str().unwrap()).unwrap();
        if picture == Some("") {
            assert!(content.get("picture").is_none());
        } else {
            assert_eq!(
                content["picture"],
                picture.unwrap_or("https://images.example/old.png")
            );
        }
        assert_eq!(content["about"], "Keep me");
        assert_eq!(content["nip05"], "alice@example.com");
        assert_eq!(content["extension"], json!({"nested":[1,2]}));
        if name_pending {
            assert_eq!(content["name"], "Luna");
            assert_eq!(content["display_name"], "Luna");
        } else {
            assert_eq!(content["name"], "Old");
            assert_eq!(content["display_name"], "External display");
        }
        assert_eq!(content["bot"], false);
        assert!(event["created_at"].as_u64().unwrap() > old["created_at"].as_u64().unwrap());
        publication
            .confirm(std::slice::from_ref(&event), event["id"].as_str().unwrap())
            .unwrap();
    }
    let initial = profile(None).event(&key, &[]).unwrap();
    verify(&initial);
    let content: Value = serde_json::from_str(initial["content"].as_str().unwrap()).unwrap();
    assert_eq!(
        content,
        json!({"name":"New name", "display_name":"New name", "bot":true})
    );
}

#[test]
fn replacement_uses_newest_profile_and_lower_id_for_equal_timestamps() {
    let key = Secret::parse(KEY, PUB).unwrap();
    let a = signed(r#"{"about":"A"}"#, 100, 0);
    let b = signed(r#"{"about":"B"}"#, 100, 0);
    let older = signed(r#"{"about":"Old"}"#, 99, 0);
    let expected = if a["id"].as_str() < b["id"].as_str() {
        "A"
    } else {
        "B"
    };
    for events in [vec![a.clone(), b.clone(), older.clone()], vec![older, b, a]] {
        let event = profile(None).event(&key, &events).unwrap();
        let content: Value = serde_json::from_str(event["content"].as_str().unwrap()).unwrap();
        assert_eq!(content["about"], expected);
    }
}

#[test]
fn malformed_wrong_identity_and_unverified_profiles_fail_closed() {
    let key = Secret::parse(KEY, PUB).unwrap();
    let valid = signed("{}", now(), 0);
    let mut wrong_author = valid.clone();
    wrong_author["pubkey"] = json!("ab".repeat(32));
    let mut tampered = valid.clone();
    tampered["content"] = json!(r#"{"about":"forged"}"#);
    let mut signature = valid.clone();
    signature["sig"] = json!("00".repeat(64));
    for event in [
        json!({}),
        wrong_author,
        tampered,
        signature,
        signed("{}", now() + 120, 0),
        signed("{}", now(), 1),
        signed("[]", now(), 0),
        signed("not json", now(), 0),
    ] {
        assert!(profile(None).event(&key, &[event]).is_err());
    }
    assert!(profile(None).event(&key, &vec![valid; 6]).is_err());
    let other = Secret::generate().unwrap();
    assert!(profile(None).event(&other, &[]).is_err());
}

#[test]
fn request_authentication_binds_the_exact_query_or_publication_and_body() {
    let key = Secret::parse(KEY, PUB).unwrap();
    let profile = profile(None);
    let body = br#"[{"kinds":[0]}]"#;
    assert_eq!(profile.query_url(), "https://relay.example/query");
    for (event, url) in [
        (
            profile.authenticate_query(&key, body).unwrap(),
            profile.query_url(),
        ),
        (
            profile.authenticate(&key, body).unwrap(),
            profile.url.clone(),
        ),
    ] {
        verify(&event);
        assert_eq!(event["kind"], 27235);
        let tags = event["tags"].as_array().unwrap();
        assert!(tags.contains(&json!(["u", url])));
        assert!(tags.contains(&json!(["method", "POST"])));
        assert!(tags.contains(&json!(["payload", format!("{:x}", Sha256::digest(body))])));
    }
}

#[test]
fn accepted_but_superseded_profile_is_not_confirmed() {
    let key = Secret::parse(KEY, PUB).unwrap();
    let profile = profile(Some("https://images.example/new.png"));
    let event = profile.event(&key, &[]).unwrap();
    let newer = signed("{}", event["created_at"].as_u64().unwrap() + 1, 0);
    let id = event["id"].as_str().unwrap();
    assert!(profile.confirm(&[newer, event.clone()], id).is_err());
    assert!(profile.confirm(&[], id).is_err());
    profile.confirm(std::slice::from_ref(&event), id).unwrap();
}
