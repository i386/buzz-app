//! Private storage directory used by credential locking, which only macOS
//! (and tests) compile.
use crate::Result;
use std::path::Path;

pub(crate) fn private_directory(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
        Ok(_) => return Err("App storage must be a private directory, not a link".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path).map_err(|_| "Could not create private app storage")?;
        }
        Err(_) => return Err("Could not inspect private app storage".into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect app storage")?;
    }
    Ok(())
}
