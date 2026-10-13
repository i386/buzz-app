//! Credential primitives shared by human and agent identity owners.
//! Password encoding matches keyring's native Windows UTF-16 / Linux UTF-8 format.
//! Create-only writes are serialized across cooperating app processes, not profiles.
//! Locks contain no secrets; missing/locked/broken secure storage never falls back.
#[cfg(any(target_os = "windows", target_os = "linux", test))]
use sha2::{Digest, Sha256};
#[cfg(any(target_os = "windows", target_os = "linux", test))]
use std::fs::{self, File, OpenOptions};
#[cfg(any(target_os = "windows", target_os = "linux", test))]
use std::path::Path;
#[cfg(any(target_os = "windows", target_os = "linux", test))]
use zeroize::Zeroize;
use zeroize::Zeroizing;

pub const HUMAN_ACCOUNT: &str = "human";
pub const HUMAN_SERVICE: &str = human_service(cfg!(debug_assertions));

pub const fn human_service(debug: bool) -> &'static str {
    if debug {
        "dev.local.buzz.foundation.identity.debug"
    } else {
        "dev.local.buzz.foundation.identity"
    }
}

/// Sanitized outcomes. Only `Absent` permits creation of a new credential.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Absent,
    Occupied,
    Denied,
    Corrupt,
    Unavailable,
    Busy,
}
type Result<T> = std::result::Result<T, Error>;

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn error(value: keyring::Error) -> Error {
    match value {
        keyring::Error::NoEntry => Error::Absent,
        keyring::Error::NoStorageAccess(_) => Error::Denied,
        keyring::Error::BadEncoding(mut bytes) => {
            bytes.zeroize();
            Error::Corrupt
        }
        keyring::Error::Ambiguous(_) => Error::Corrupt,
        _ => Error::Unavailable,
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
trait Backend {
    fn read(&self) -> Result<Zeroizing<Vec<u8>>>;
    fn write(&self, value: &str) -> Result<()>;
    fn delete(&self) -> Result<()>;
}

// Unit tests cannot accidentally call the real OS adapter.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
impl Backend for keyring::Entry {
    fn read(&self) -> Result<Zeroizing<Vec<u8>>> {
        self.get_password()
            .map(|value| Zeroizing::new(value.into_bytes()))
            .map_err(error)
    }
    fn write(&self, value: &str) -> Result<()> {
        self.set_password(value).map_err(error)
    }
    fn delete(&self) -> Result<()> {
        self.delete_credential().map_err(error)
    }
}

#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
fn entry(service: &str, account: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(service, account).map_err(error)
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn lock_root() -> Result<std::path::PathBuf> {
    // Resolve the OS account, not HOME/XDG overrides, profile, worktree or temp
    // paths: all processes writing the same per-user entry must share its lock.
    #[cfg(unix)]
    let home = nix::unistd::User::from_uid(nix::unistd::Uid::effective())
        .map_err(|_| Error::Unavailable)?
        .map(|user| user.dir);
    #[cfg(windows)]
    let home = dirs::home_dir(); // Windows Known Folder API, not environment.
    home.filter(|path| path.is_absolute())
        .map(|path| path.join(".buzz-foundation/credential-locks"))
        .ok_or(Error::Unavailable)
}

/// Read an exact service/account without consulting any other credential.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn read(service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>> {
    entry(service, account)?.read()
}

/// Add a credential only if a fresh read under its interprocess lock is absent.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn add(service: &str, account: &str, value: &[u8]) -> Result<()> {
    add_entry(
        &entry(service, account)?,
        &lock_root()?,
        service,
        account,
        value,
    )
}

/// Write a credential whether or not one is saved, under the same lock as
/// creates and deletes. For settings a person replaces, never for identities.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn replace(service: &str, account: &str, value: &[u8]) -> Result<()> {
    replace_entry(
        &entry(service, account)?,
        &lock_root()?,
        service,
        account,
        value,
    )
}

/// Delete only the exact credential, serialized with this app's creates/deletes.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn delete(service: &str, account: &str) -> Result<()> {
    delete_entry(&entry(service, account)?, &lock_root()?, service, account)
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn add_entry(
    entry: &impl Backend,
    root: &Path,
    service: &str,
    account: &str,
    value: &[u8],
) -> Result<()> {
    let value = std::str::from_utf8(value).map_err(|_| Error::Corrupt)?;
    let _lock = acquire(root, service, account)?;
    match entry.read() {
        Ok(_) => return Err(Error::Occupied),
        Err(Error::Absent) => {}
        Err(error) => return Err(error),
    }
    entry.write(value)
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn replace_entry(
    entry: &impl Backend,
    root: &Path,
    service: &str,
    account: &str,
    value: &[u8],
) -> Result<()> {
    let value = std::str::from_utf8(value).map_err(|_| Error::Corrupt)?;
    let _lock = acquire(root, service, account)?;
    entry.write(value)
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn delete_entry(entry: &impl Backend, root: &Path, service: &str, account: &str) -> Result<()> {
    let _lock = acquire(root, service, account)?;
    entry.delete()
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
struct Lock(File);

#[cfg(any(target_os = "windows", target_os = "linux", test))]
impl Drop for Lock {
    fn drop(&mut self) {
        // fork/dup can retain the open-file description after our descriptor
        // closes. Explicitly release ownership when the operation finishes.
        let _ = self.0.unlock();
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn acquire(root: &Path, service: &str, account: &str) -> Result<Lock> {
    if !root.is_absolute() {
        return Err(Error::Unavailable);
    }
    fs::create_dir_all(root).map_err(|_| Error::Unavailable)?;
    let mut hash = Sha256::new();
    hash.update(service.as_bytes());
    hash.update([0]);
    hash.update(account.as_bytes());
    let path = root.join(format!("{:x}.lock", hash.finalize()));
    // The file is never read, written, truncated or removed; it contains no
    // secrets. These advisory locks coordinate this app, not hostile OS peers.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| Error::Unavailable)?;
    // Unlike a blocking lock, contention cannot strand an IPC worker behind a
    // second process's credential-consent dialog. Retry is explicitly user-driven.
    file.try_lock().map_err(|e| match e {
        std::fs::TryLockError::WouldBlock => Error::Busy,
        std::fs::TryLockError::Error(_) => Error::Unavailable,
    })?;
    Ok(Lock(file))
}

/// Read only the human identity used by the desktop app; never create or select another key.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn read_human() -> Result<Zeroizing<Vec<u8>>> {
    read(HUMAN_SERVICE, HUMAN_ACCOUNT)
}

#[cfg(all(not(test), target_os = "macos"))]
pub fn read_human() -> Result<Zeroizing<Vec<u8>>> {
    use security_framework::os::macos::keychain::SecKeychain;
    let keychain = SecKeychain::default().map_err(mac_error)?;
    keychain
        .find_generic_password(HUMAN_SERVICE, HUMAN_ACCOUNT)
        .map(|(password, _)| Zeroizing::new(password.to_vec()))
        .map_err(mac_error)
}

#[cfg(all(not(test), target_os = "macos"))]
fn mac_error(error: security_framework::base::Error) -> Error {
    match error.code() {
        -25300 => Error::Absent,
        -128 | -25293 | -25308 => Error::Denied,
        _ => Error::Unavailable,
    }
}

#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
pub fn read_human() -> Result<Zeroizing<Vec<u8>>> {
    Err(Error::Unavailable)
}

#[cfg(test)]
mod tests;
