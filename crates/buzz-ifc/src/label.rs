use std::fmt;
use uuid::Uuid;

/// The community established by the trusted broker for an operation.
///
/// This UUID has the same representation as `buzz-core::CommunityId` in
/// `block/buzz`. Keeping the small type here avoids a dependency on the relay.
/// Callers must obtain it from trusted host configuration or host resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CommunityId(Uuid);

impl CommunityId {
    /// Wrap a UUID the broker has already established as a community ID.
    pub const fn from_uuid(id: Uuid) -> Self {
        Self(id)
    }

    /// Return the underlying UUID.
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl fmt::Display for CommunityId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

pub use ifc_core::LabelError;
use nostr::key::PublicKey;

/// A person, agent, or relay identified by a valid Nostr public key.
///
/// The key is validated and stored in binary form. Hexadecimal case does not
/// affect equality of principals or execution domains.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Principal(PublicKey);

impl Principal {
    /// Parse a hexadecimal Nostr public key, rejecting invalid curve points.
    pub fn from_hex(value: &str) -> Result<Self, PrincipalError> {
        let key = PublicKey::from_hex(value).map_err(|_| PrincipalError::InvalidPublicKey)?;
        Self::from_public_key(&key)
    }

    /// Convert a Nostr key after checking that it is a valid curve point.
    ///
    /// `PublicKey` can hold 32 bytes that do not represent an x-only secp256k1
    /// point. Reject those values before using them as reader identities.
    pub fn from_public_key(value: &PublicKey) -> Result<Self, PrincipalError> {
        value
            .xonly()
            .map_err(|_| PrincipalError::InvalidPublicKey)?;
        Ok(Self(*value))
    }

    /// Return the public key as lowercase hexadecimal.
    pub fn to_hex(&self) -> String {
        self.0.to_hex()
    }
}

/// Invalid Nostr public-key input.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum PrincipalError {
    /// The value is not a valid Nostr public key.
    #[error("invalid Nostr public key")]
    InvalidPublicKey,
}

/// Who may read a value in one Buzz community.
///
/// A public label allows everyone in that community; a restricted label names
/// the allowed readers. Labels from different communities cannot be combined.
pub type ConfidentialityLabel = ifc_core::ConfidentialityLabel<CommunityId, Principal>;

pub(crate) type ReaderSet = ifc_core::ReaderSet<Principal>;
