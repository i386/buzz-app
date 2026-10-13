//! The closed admin route list. The webview supplies typed fields; this module
//! alone decides the method, path, query and JSON body.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use url::Url;

type Result<T> = std::result::Result<T, String>;

/// Largest successful JSON response (report and feedback lists).
pub(super) const SUCCESS_CAP: usize = 50 * 1024 * 1024;
/// `/probe` answers with a handful of fields.
pub(super) const PROBE_CAP: usize = 8 * 1024;
/// Error envelopes are small; anything bigger is not the relay's envelope.
pub(super) const ERROR_CAP: usize = 64 * 1024;
const REASON_MAX: usize = 1000;
/// beta's admin router refuses larger bodies before its handler runs
/// (`RequestBodyLimitLayer::new(4096)`), with no API envelope.
pub(super) const BODY_MAX: usize = 4096;
const QUERY_MAX: usize = 255;
const CURSOR_MAX: usize = 1024;
/// The relay caps timeouts at 365 days.
const MAX_EXPIRATION_SECS: u64 = 365 * 24 * 60 * 60;

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReportAction {
    Delete,
    Kick,
    Ban,
    Timeout,
    Dismiss,
    Escalate,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FeedbackStatus {
    New,
    Reviewed,
    Archived,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Role {
    Operator,
    Moderator,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Restriction {
    Ban,
    Timeout,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DirectAction {
    Ban,
    Timeout,
    Delete,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReportStatus {
    Open,
    Processing,
    Resolved,
    Dismissed,
    Escalated,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReportsQuery {
    community_id: Option<String>,
    status: Option<ReportStatus>,
    limit: Option<u32>,
    scope: Option<Scope>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum Scope {
    All,
}

/// Mirrors `StaffRequest` in `src/features/relay-staff/contract.ts`.
#[derive(Debug, Deserialize)]
#[serde(tag = "route", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum StaffRequest {
    Probe {},
    ListReports {
        query: ReportsQuery,
    },
    GetReport {
        id: String,
    },
    #[serde(rename_all = "camelCase")]
    ResolveReport {
        id: String,
        action: ReportAction,
        request_id: String,
        expiration_secs: Option<u64>,
        reason: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ReopenReport {
        id: String,
        request_id: String,
        reason: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    CancelReport {
        id: String,
        action_id: String,
    },
    ListFeedback {},
    GetFeedback {
        id: String,
    },
    SetFeedbackStatus {
        id: String,
        status: FeedbackStatus,
    },
    ListOperators {},
    PutOperator {
        pubkey: String,
        role: Role,
    },
    DeleteOperator {
        pubkey: String,
    },
    #[serde(rename_all = "camelCase")]
    ListRestrictions {
        community_host: String,
        cursor: Option<String>,
        limit: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    LiftRestriction {
        community_host: String,
        kind: Restriction,
        pubkey: String,
    },
    #[serde(rename_all = "camelCase")]
    DirectAction {
        community_host: String,
        action: DirectAction,
        target: String,
        request_id: String,
        reason: Option<String>,
        expiration_secs: Option<u64>,
    },
    ListCommunities {
        q: Option<String>,
        cursor: Option<String>,
        limit: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    SearchMembers {
        community_host: String,
        q: String,
        limit: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    GetMember {
        community_host: String,
        pubkey: String,
    },
    #[serde(rename_all = "camelCase")]
    GetEvent {
        community_host: String,
        id: String,
    },
}

/// A fully built admin call: exactly what is signed and sent.
#[derive(Debug)]
pub(super) struct Built {
    pub method: &'static str,
    pub url: Url,
    /// Serialized JSON body; empty for bodiless calls.
    pub body: Vec<u8>,
    pub success_cap: usize,
}

pub(super) fn hex64(value: &str) -> Result<&str> {
    (value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then_some(value)
    .ok_or_else(|| "Expected a lowercase 64-character hex value".into())
}

pub(super) fn uuid(value: &str) -> Result<String> {
    uuid::Uuid::parse_str(value)
        .ok()
        .filter(|_| value.len() == 36)
        .map(|id| id.hyphenated().to_string())
        .ok_or_else(|| "Expected a UUID".into())
}

fn text(value: &str, max: usize, what: &str) -> Result<()> {
    if value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(format!("{what} is too long or contains control characters"));
    }
    Ok(())
}

fn reason(value: &Option<String>) -> Result<()> {
    value
        .as_deref()
        .map_or(Ok(()), |r| text(r, REASON_MAX, "Reason"))
}

fn bounded(limit: Option<u32>, max: u32) -> Result<Option<u32>> {
    match limit {
        Some(n) if n == 0 || n > max => Err("Limit is out of range".into()),
        other => Ok(other),
    }
}

fn expiration(value: Option<u64>) -> Result<()> {
    match value {
        Some(0) => Err("Duration must be positive".into()),
        Some(n) if n > MAX_EXPIRATION_SECS => Err("Duration is too long".into()),
        _ => Ok(()),
    }
}

/// A community host as the relay names it: a bare lowercase hostname,
/// optionally with a port. Never a URL.
pub(super) fn community_host(value: &str) -> Result<&str> {
    let parsed = Url::parse(&format!("https://{value}/")).ok();
    let canonical = parsed.as_ref().and_then(|url| {
        let host = url.host_str()?;
        Some(match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        })
    });
    (value.len() <= 255 && canonical.as_deref() == Some(value))
        .then_some(value)
        .ok_or_else(|| "Invalid community host".into())
}

fn cursor(value: &Option<String>) -> Result<()> {
    value
        .as_deref()
        .map_or(Ok(()), |c| text(c, CURSOR_MAX, "Cursor"))
}

fn body(fields: Value) -> Vec<u8> {
    // Drop absent optionals so the relay's `deny_unknown_fields` sees only set keys.
    let Value::Object(map) = fields else {
        unreachable!()
    };
    let map: Map<String, Value> = map.into_iter().filter(|(_, v)| !v.is_null()).collect();
    serde_json::to_vec(&map).expect("JSON object serializes")
}

impl StaffRequest {
    /// Anything that may change relay state once sent.
    pub(super) fn is_write(&self) -> bool {
        !matches!(
            self,
            Self::Probe {}
                | Self::ListReports { .. }
                | Self::GetReport { .. }
                | Self::ListFeedback {}
                | Self::GetFeedback { .. }
                | Self::ListOperators {}
                | Self::ListRestrictions { .. }
                | Self::ListCommunities { .. }
                | Self::SearchMembers { .. }
                | Self::GetMember { .. }
                | Self::GetEvent { .. }
        )
    }

    /// The writes whose retry must reuse the same frozen request.
    pub(super) fn request_id(&self) -> Option<&str> {
        match self {
            Self::ResolveReport { request_id, .. }
            | Self::ReopenReport { request_id, .. }
            | Self::DirectAction { request_id, .. } => Some(request_id),
            _ => None,
        }
    }

    pub(super) fn build(&self, origin: &Url) -> Result<Built> {
        if let Some(id) = self.request_id() {
            uuid(id)?;
        }
        let mut query: Vec<(&str, String)> = Vec::new();
        let mut put = |key, value: Option<String>| {
            if let Some(value) = value {
                query.push((key, value));
            }
        };
        let (method, path, body, success_cap) = match self {
            Self::Probe {} => ("GET", "/probe".into(), None, PROBE_CAP),
            Self::ListReports { query: q } => {
                if let Some(id) = &q.community_id {
                    uuid(id)?;
                }
                put("communityId", q.community_id.clone());
                put("status", q.status.map(|s| enum_text(&s)));
                put("limit", bounded(q.limit, 200)?.map(|n| n.to_string()));
                put("scope", q.scope.map(|_| "all".into()));
                ("GET", "/reports".into(), None, SUCCESS_CAP)
            }
            Self::GetReport { id } => ("GET", format!("/reports/{}", uuid(id)?), None, SUCCESS_CAP),
            Self::ResolveReport {
                id,
                action,
                request_id,
                expiration_secs,
                reason: why,
            } => {
                reason(why)?;
                expiration(*expiration_secs)?;
                if (*action == ReportAction::Timeout) != expiration_secs.is_some() {
                    return Err(
                        "A duration is required for a timeout and only for a timeout".into(),
                    );
                }
                (
                    "POST",
                    format!("/reports/{}/resolve", uuid(id)?),
                    Some(json!({
                        "action": enum_text(action), "requestId": request_id,
                        "expirationSecs": expiration_secs, "reason": why,
                    })),
                    SUCCESS_CAP,
                )
            }
            Self::ReopenReport {
                id,
                request_id,
                reason: why,
            } => {
                reason(why)?;
                (
                    "POST",
                    format!("/reports/{}/reopen", uuid(id)?),
                    Some(json!({ "requestId": request_id, "reason": why })),
                    SUCCESS_CAP,
                )
            }
            Self::CancelReport { id, action_id } => (
                "POST",
                format!("/reports/{}/cancel", uuid(id)?),
                Some(json!({ "actionId": uuid(action_id)? })),
                SUCCESS_CAP,
            ),
            Self::ListFeedback {} => ("GET", "/feedback".into(), None, SUCCESS_CAP),
            Self::GetFeedback { id } => {
                ("GET", format!("/feedback/{}", uuid(id)?), None, SUCCESS_CAP)
            }
            Self::SetFeedbackStatus { id, status } => (
                "PATCH",
                format!("/feedback/{}", uuid(id)?),
                Some(json!({ "status": enum_text(status) })),
                SUCCESS_CAP,
            ),
            Self::ListOperators {} => ("GET", "/operators".into(), None, SUCCESS_CAP),
            Self::PutOperator { pubkey, role } => (
                "PUT",
                format!("/operators/{}", hex64(pubkey)?),
                Some(json!({ "role": enum_text(role) })),
                SUCCESS_CAP,
            ),
            Self::DeleteOperator { pubkey } => (
                "DELETE",
                format!("/operators/{}", hex64(pubkey)?),
                None,
                SUCCESS_CAP,
            ),
            Self::ListRestrictions {
                community_host: host,
                cursor: c,
                limit,
            } => {
                cursor(c)?;
                put("communityHost", Some(community_host(host)?.into()));
                put("limit", bounded(*limit, 200)?.map(|n| n.to_string()));
                put("cursor", c.clone());
                ("GET", "/members/restrictions".into(), None, SUCCESS_CAP)
            }
            Self::LiftRestriction {
                community_host: host,
                kind,
                pubkey,
            } => {
                put("communityHost", Some(community_host(host)?.into()));
                (
                    "DELETE",
                    format!("/members/{}/{}", hex64(pubkey)?, enum_text(kind)),
                    None,
                    SUCCESS_CAP,
                )
            }
            Self::DirectAction {
                community_host: host,
                action,
                target,
                request_id,
                reason: why,
                expiration_secs,
            } => {
                reason(why)?;
                expiration(*expiration_secs)?;
                match (action, expiration_secs) {
                    (DirectAction::Timeout, None) => {
                        return Err("A timeout needs a duration".into())
                    }
                    (DirectAction::Delete, Some(_)) => {
                        return Err("A delete takes no duration".into())
                    }
                    (DirectAction::Ban, Some(_)) => return Err("A ban takes no duration".into()),
                    _ => {}
                }
                put("communityHost", Some(community_host(host)?.into()));
                let target = hex64(target)?;
                let path = match action {
                    DirectAction::Ban => format!("/members/{target}/ban"),
                    DirectAction::Timeout => format!("/members/{target}/timeout"),
                    DirectAction::Delete => format!("/events/{target}/delete"),
                };
                (
                    "POST",
                    path,
                    Some(json!({
                        "requestId": request_id, "reason": why, "expirationSecs": expiration_secs,
                    })),
                    SUCCESS_CAP,
                )
            }
            Self::ListCommunities {
                q,
                cursor: c,
                limit,
            } => {
                if let Some(q) = q {
                    text(q, QUERY_MAX, "Search")?;
                }
                cursor(c)?;
                put("q", q.clone().filter(|q| !q.is_empty()));
                put("cursor", c.clone());
                put("limit", bounded(*limit, 100)?.map(|n| n.to_string()));
                ("GET", "/communities".into(), None, SUCCESS_CAP)
            }
            Self::SearchMembers {
                community_host: host,
                q,
                limit,
            } => {
                if q.is_empty() {
                    return Err("Search is empty".into());
                }
                text(q, 100, "Search")?;
                put("communityHost", Some(community_host(host)?.into()));
                put("q", Some(q.clone()));
                put("limit", bounded(*limit, 50)?.map(|n| n.to_string()));
                ("GET", "/members/search".into(), None, SUCCESS_CAP)
            }
            Self::GetMember {
                community_host: host,
                pubkey,
            } => {
                put("communityHost", Some(community_host(host)?.into()));
                (
                    "GET",
                    format!("/members/{}", hex64(pubkey)?),
                    None,
                    SUCCESS_CAP,
                )
            }
            Self::GetEvent {
                community_host: host,
                id,
            } => {
                put("communityHost", Some(community_host(host)?.into()));
                ("GET", format!("/events/{}", hex64(id)?), None, SUCCESS_CAP)
            }
        };
        let body = body.map(self::body).unwrap_or_default();
        if body.len() > BODY_MAX {
            // Only the free-text reason can grow a body this far.
            return Err("Reason is too long".into());
        }
        Ok(Built {
            method,
            url: admin_url(origin, &path, &query)?,
            body,
            success_cap,
        })
    }
}

pub(super) fn admin_url(origin: &Url, path: &str, query: &[(&str, String)]) -> Result<Url> {
    let mut url = origin
        .join(&format!("/api/admin/v1{path}"))
        .map_err(|_| "Invalid admin path")?;
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    Ok(url)
}

fn enum_text<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(Value::String(text)) => text,
        _ => unreachable!("wire enums serialize as strings"),
    }
}
