//! Goose-specific binding of the shared Databricks connection. Goose owns all
//! model requests; this writes its supported command-auth configuration.
use serde_json::{json, Value};
use std::path::PathBuf;

type Result<T> = std::result::Result<T, String>;

// The gateway's Chat route rejects reasoning_effort alongside tools (GPT-6),
// so a user's goose-wide thinking effort must not reach it.
fn env(model: &str) -> Value {
    json!({"GOOSE_PROVIDER":"buzz_databricks", "GOOSE_MODEL":model, "GOOSE_THINKING_EFFORT":"none"})
}
fn definition() -> Result<PathBuf> {
    Ok(goose_config_directory()?.join("custom_providers/buzz_databricks.json"))
}
fn helper() -> Result<PathBuf> {
    std::env::current_exe().map_err(|_| "Could not find the Buzz credential helper".into())
}

/// The launch environment when the written configuration already offers this
/// model through this Buzz binary, so starting an agent needs no catalog fetch.
pub(crate) fn reuse(model: &str) -> Option<Value> {
    let saved: Value = serde_json::from_slice(&std::fs::read(definition().ok()?).ok()?).ok()?;
    let listed = saved["models"]
        .as_array()?
        .iter()
        .any(|m| m["name"] == model);
    let current = saved["auth"]["command"].as_str()? == helper().ok()?.to_str()?;
    (listed && current).then(|| env(model))
}

pub(crate) fn prepare(host: &str, models: &[Value], model: &str) -> Result<Value> {
    // Other Chat routes (notably Claude) reject fields Goose adds to tool
    // schemas. Expose GPT only until their native adapters can use shared auth.
    let catalog: Vec<_> = models.iter().filter(|m| m["family"] == "gpt").collect();
    if !catalog.iter().any(|m| m["id"] == model) {
        return Err("This Databricks model is unavailable or has no Goose-supported GPT Chat Completions route".into());
    }
    // Allow the 15s storage-lock wait plus two 10s OAuth requests.
    let config = json!({
        "name":"buzz_databricks", "engine":"openai", "display_name":"Databricks in Buzz",
        "base_url":format!("{host}/ai-gateway/mlflow/v1/chat/completions"),
        "models":catalog.iter().map(|m| json!({"name":m["id"]})).collect::<Vec<_>>(),
        "supports_streaming":true, "dynamic_models":false,
        "auth":{"command":helper()?,"args":["--databricks-provider-token"],"refresh_interval":30,"timeout_seconds":45}
    });
    crate::databricks_provider::write_file(
        definition()?,
        &serde_json::to_vec(&config).map_err(|_| "Could not encode Goose provider")?,
    )?;
    Ok(env(model))
}

// Match Goose's Paths::config_dir (XDG on macOS/Linux). Keeping its ordinary
// root also keeps history readable after sign-out or changing providers.
fn goose_config_directory() -> Result<PathBuf> {
    if let Some(root) = std::env::var_os("GOOSE_PATH_ROOT")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
    {
        return Ok(root.join("config"));
    }
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| dirs::home_dir().map(|p| p.join(".config")))
        .ok_or("Goose configuration storage is unavailable")?;
    Ok(base.join("goose"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launches_reuse_a_written_catalog_only_for_listed_models_and_this_binary() {
        let root = tempfile::tempdir().unwrap();
        std::env::set_var("GOOSE_PATH_ROOT", root.path());
        assert_eq!(reuse("served-gpt"), None);
        let catalog = [json!({"id":"served-gpt", "family":"gpt"})];
        prepare("https://workspace.example", &catalog, "served-gpt").unwrap();
        assert_eq!(reuse("served-gpt"), Some(env("served-gpt")));
        assert_eq!(reuse("other-model"), None);
        let path = definition().unwrap();
        let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        saved["auth"]["command"] = json!("/deleted/worktree/buzz");
        std::fs::write(&path, saved.to_string()).unwrap();
        assert_eq!(reuse("served-gpt"), None);
        std::env::remove_var("GOOSE_PATH_ROOT");
    }
}
