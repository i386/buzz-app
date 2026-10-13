//! Identity validation shared by native agents, credentials and legacy imports.
use crate::Result;

pub(crate) const MAX_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_AGENTS: usize = 2000;

pub(crate) fn canonical_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(crate) fn canonical_relay(value: &str) -> Result<String> {
    let invalid =
        || "Choose a secure community origin without credentials, path or query".to_string();
    let mut url = url::Url::parse(value.trim()).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "https" | "wss")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    url.set_scheme("wss").map_err(|_| invalid())?;
    let host = url
        .host_str()
        .ok_or_else(invalid)?
        .trim_end_matches('.')
        .to_owned();
    url.set_host(Some(&host)).map_err(|_| invalid())?;
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
pub(crate) fn agent_id(pubkey: &str, relay: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{pubkey}-{:x}", Sha256::digest(relay.as_bytes()))
}
// Executable instructions must remain visible in both the preview and persisted config.
// Emoji joiners/selectors are allowed only when they compose visible emoji.
pub(crate) fn visible_agent_text(value: &str, prompt: bool) -> Result<()> {
    use std::sync::LazyLock;
    static PICTOGRAPHIC: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^\p{Extended_Pictographic}$").expect("Unicode property is supported")
    });
    static SCRIPT: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[\p{L}\p{M}]$").expect("Unicode property is supported")
    });
    static PUNCTUATION: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^\p{P}$").expect("Unicode property is supported"));
    let chars: Vec<char> = value.chars().collect();
    for (i, &ch) in chars.iter().enumerate() {
        let code = ch as u32;
        let pictographic = |c: char| PICTOGRAPHIC.is_match(&c.to_string());
        let emoji_format = match ch {
            '\u{fe0f}' | '\u{fe0e}' => {
                i > 0
                    && (pictographic(chars[i - 1]) || matches!(chars[i - 1], '#' | '*' | '0'..='9'))
            }
            '\u{200c}' | '\u{200d}'
                if i > 0
                    && chars
                        .get(i + 1)
                        .is_some_and(|c| !c.is_ascii() && SCRIPT.is_match(&c.to_string()))
                    && !chars[i - 1].is_ascii()
                    && SCRIPT.is_match(&chars[i - 1].to_string()) =>
            {
                true
            }
            '\u{200d}'
                if i >= 2
                    && chars[i - 1] == '\u{0d4d}'
                    && matches!(chars[i - 2] as u32, 0x0d15..=0x0d39)
                    && chars.get(i + 1).is_none_or(|c| {
                        c.is_whitespace()
                            || c.is_ascii_punctuation()
                            || PUNCTUATION.is_match(&c.to_string())
                    }) =>
            {
                true
            }
            '\u{200d}' => {
                let previous = chars[..i].iter().rev().find(|&&c| {
                    c != '\u{fe0f}' && c != '\u{fe0e}' && !matches!(c as u32, 0x1f3fb..=0x1f3ff)
                });
                previous.is_some_and(|&c| pictographic(c))
                    && chars.get(i + 1).is_some_and(|&c| pictographic(c))
            }
            _ => false,
        };
        let ignorable = matches!(code,
            0x00ad | 0x034f | 0x061c | 0x115f..=0x1160 | 0x17b4..=0x17b5 |
            0x180b..=0x180f | 0x200b..=0x200f | 0x202a..=0x202e |
            0x2060..=0x206f | 0x3164 | 0xfe00..=0xfe0f | 0xfeff |
            0xffa0 | 0xfff0..=0xfff8 | 0x1bca0..=0x1bca3 |
            0x1d173..=0x1d17a | 0xe0000..=0xe0fff);
        if (ch.is_control() && !(prompt && matches!(ch, '\n' | '\r' | '\t')))
            || (ignorable && !emoji_format)
        {
            return Err(format!(
                "Agent text contains prohibited invisible character U+{code:04X}"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod snapshot_visible_text_tests {
    use super::visible_agent_text;

    #[test]
    fn rejects_review_invisible_instruction_characters_but_preserves_visible_emoji() {
        for ch in ['\u{202e}', '\u{200b}', '\u{e0061}'] {
            assert!(visible_agent_text(&format!("Review{ch} code"), true).is_err());
            assert!(visible_agent_text(&format!("Reviewer{ch}"), false).is_err());
        }
        for value in ["Review 👩‍💻", "Review ❤️", "Review 🧑🏽‍💻", "“അവന്‍” അവന്‍।"]
        {
            assert!(visible_agent_text(value, true).is_ok());
        }
        assert!(visible_agent_text("Review\n\tcode", true).is_ok());
    }
}
