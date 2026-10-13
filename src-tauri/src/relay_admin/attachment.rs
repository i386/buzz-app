//! Feedback attachments: one validated fetch shared by preview and the native
//! save (blob downloads do not work in WKWebView).

use super::{
    classify, dispatch, expected_origin, read_capped, route, Category, Context, Failure, Net, Read,
};
use crate::identity::IdentityHost;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri_plugin_dialog::DialogExt;

pub(super) const ATTACHMENT_CAP: usize = 10 * 1024 * 1024;
/// The raster types the relay serves sniffed; never SVG, like other media.
const PREVIEW_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// See `AttachmentRef` in `contract.ts`; the values come from the feedback's `imeta`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AttachmentRef {
    pub(super) feedback_id: String,
    pub(super) sha256: String,
    pub(super) mime: String,
    pub(super) size: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Use {
    Preview,
    Save,
}

fn mismatch(status: u16, code: &str, message: &str) -> Failure {
    Failure {
        category: Category::Rejected,
        status: Some(status),
        body_complete: false,
        body_empty: false,
        code: Some(code.into()),
        not_sent: false,
        auth_lost: false,
        message: message.into(),
    }
}

fn mime(value: &str) -> String {
    value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

pub(super) async fn fetch(
    net: &Net,
    host: &IdentityHost,
    context: &Context,
    discovered: Option<String>,
    attachment: &AttachmentRef,
    purpose: Use,
) -> Result<Vec<u8>, Failure> {
    let id = route::uuid(&attachment.feedback_id).map_err(Failure::not_sent)?;
    let hash = route::hex64(&attachment.sha256).map_err(Failure::not_sent)?;
    let expected = mime(&attachment.mime);
    if attachment.size == 0 || attachment.size > ATTACHMENT_CAP {
        return Err(Failure::not_sent("The attachment size is out of range"));
    }
    if expected.is_empty() || expected.len() > 127 || expected.chars().any(char::is_control) {
        return Err(Failure::not_sent("The attachment type is invalid"));
    }
    if purpose == Use::Preview && !PREVIEW_TYPES.contains(&expected.as_str()) {
        return Err(Failure::not_sent("Only images can be previewed"));
    }
    let origin = expected_origin(host, context, discovered).await?;
    let built = route::Built {
        method: "GET",
        url: route::admin_url(&origin, &format!("/feedback/{id}/attachments/{hash}"), &[])
            .map_err(Failure::not_sent)?,
        body: Vec::new(),
        success_cap: ATTACHMENT_CAP,
    };
    let mut response = dispatch(net, host, context, &origin, &built).await?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(classify(response, 0, None)
            .await
            .expect_err("non-2xx is a failure"));
    }
    let actual = mime(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    );
    if actual != expected && !(purpose == Use::Save && actual == "application/octet-stream") {
        return Err(mismatch(
            status,
            "attachment_mime_mismatch",
            "The attachment type changed",
        ));
    }
    let bytes = match read_capped(&mut response, attachment.size).await {
        Read::Complete(bytes) => bytes,
        Read::Interrupted => {
            return Err(Failure::ambiguous(
                Some(status),
                false,
                "The attachment download was cut off",
            ))
        }
        Read::Oversized => {
            return Err(mismatch(
                status,
                "attachment_size_mismatch",
                "The attachment size changed",
            ))
        }
    };
    if bytes.len() != attachment.size {
        return Err(mismatch(
            status,
            "attachment_size_mismatch",
            "The attachment size changed",
        ));
    }
    if format!("{:x}", Sha256::digest(&bytes)) != hash {
        return Err(mismatch(
            status,
            "attachment_hash_mismatch",
            "The attachment content changed",
        ));
    }
    Ok(bytes)
}

/// Raw bytes (an `ArrayBuffer` in the webview), not a JSON number array.
#[tauri::command]
pub(crate) async fn relay_admin_attachment(
    host: tauri::State<'_, IdentityHost>,
    context: Context,
    attachment: AttachmentRef,
) -> Result<tauri::ipc::Response, Value> {
    let discovered = super::discover(&context.relay).await.ok().flatten();
    fetch(
        &Net::system(),
        host.inner(),
        &context,
        discovered,
        &attachment,
        Use::Preview,
    )
    .await
    .map(tauri::ipc::Response::new)
    .map_err(|failure| json!({ "failure": failure }))
}

/// Fetches first so failures surface before a dialog, then writes the bytes
/// to the destination the user picks.
#[tauri::command]
pub(crate) async fn relay_admin_save_attachment<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, IdentityHost>,
    context: Context,
    attachment: AttachmentRef,
) -> Result<Value, String> {
    let discovered = super::discover(&context.relay).await.ok().flatten();
    let bytes = match fetch(
        &Net::system(),
        host.inner(),
        &context,
        discovered,
        &attachment,
        Use::Save,
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(failure) => return Ok(json!({ "state": "failed", "failure": failure })),
    };
    let (name, extension) = file_name(&attachment.sha256, &attachment.mime);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&name)
        .add_filter(extension, &[extension])
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let chosen = receiver.await.ok().flatten().map(|path| {
        path.into_path()
            .map_err(|_| "The chosen location is not a file path".to_string())
    });
    Ok(save_to(chosen, &bytes))
}

/// `None` is a cancelled dialog.
pub(super) fn save_to(chosen: Option<Result<std::path::PathBuf, String>>, bytes: &[u8]) -> Value {
    let Some(path) = chosen else {
        return json!({ "state": "cancelled" });
    };
    match path.and_then(|path| write_marked(&path, bytes).map_err(|e| e.to_string())) {
        Ok(()) => json!({ "state": "saved" }),
        Err(message) => json!({
            "state": "failed",
            "failure": Failure::not_sent(format!("Could not save the attachment: {message}")),
        }),
    }
}

fn write_marked(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    replace_with(path, bytes, crate::relay::mark_download)
}

/// Writes a marked sibling temporary file, then renames it over `path`, so the
/// OS checks the saved file on open and a failed save never touches an existing
/// destination. Only the temporary file is removed on failure.
pub(super) fn replace_with(
    path: &std::path::Path,
    bytes: &[u8],
    mark: impl FnOnce(&std::fs::File, &std::path::Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    use std::io::Write as _;
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("not a file path"))?;
    let mut temp_name = std::ffi::OsString::from(".");
    temp_name.push(name);
    temp_name.push(format!(".{}.part", uuid::Uuid::new_v4()));
    let temp = path.with_file_name(temp_name);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let written = mark(&file, &temp)
        .and_then(|_| file.write_all(bytes))
        .and_then(|_| file.sync_all());
    drop(file);
    let replaced = written.and_then(|_| std::fs::rename(&temp, path));
    if replaced.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    replaced
}

/// `attachment-<hash prefix>.<ext>`; unknown types save as `.bin`.
pub(super) fn file_name(sha256: &str, mime_type: &str) -> (String, &'static str) {
    let extension = match mime(mime_type).as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "audio/mpeg" => "mp3",
        "audio/ogg" => "ogg",
        "audio/wav" => "wav",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "application/json" => "json",
        "text/plain" => "txt",
        "text/csv" => "csv",
        "text/markdown" => "md",
        _ => "bin",
    };
    let prefix: String = sha256
        .chars()
        .filter(char::is_ascii_hexdigit)
        .take(8)
        .collect();
    (format!("attachment-{prefix}.{extension}"), extension)
}
