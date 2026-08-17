use std::path::{Path, PathBuf};
use tempfile::TempDir;

/// Session-scoped shim directory providing tools and git config to shell children.
///
/// On install:
/// 1. Creates a 0700 tempdir with symlinks back to our binary (multicall)
/// 2. If `NOSTR_PRIVATE_KEY` is set: writes a 0600 keyfile, derives the pubkey,
///    builds ephemeral `GIT_CONFIG_*` env vars, then removes the env var
/// 3. Prepends the shim dir to PATH
///
/// Shell children receive `path_env`, `git_env`, and `BUZZ_PRIVATE_KEY` (for
/// the buzz CLI). `NOSTR_PRIVATE_KEY` is removed from the process env after
/// the keyfile is written — git helpers read from the keyfile only.
/// Cleaned up on drop (TempDir).
pub struct Shim {
    _dir: TempDir,
    pub path_env: String,
    pub git_env: Vec<(String, String)>,
}

impl Shim {
    pub fn install() -> std::io::Result<Self> {
        let dir = tempfile::Builder::new().prefix("buzz-dev-mcp-").tempdir()?;
        set_owner_only(dir.path())?;

        let self_exe = std::env::current_exe()?;

        // Multicall symlinks — all resolve back to this binary. `git` is the
        // enforcement wrapper (see git_wrapper.rs): it rejects identity
        // overrides and verifies commit authorship before exec'ing real git.
        for name in [
            "rg",
            "tree",
            "buzz",
            "git",
            "git-credential-nostr",
            "git-sign-nostr",
        ] {
            symlink(&self_exe, &dir.path().join(name))?;
        }

        let original = std::env::var_os("PATH").unwrap_or_default();
        let mut entries = vec![PathBuf::from(dir.path())];
        entries.extend(std::env::split_paths(&original));
        // join_paths uses the platform separator (':' on Unix, ';' on Windows).
        let path_env = std::env::join_paths(entries)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?
            .to_string_lossy()
            .into_owned();

        // Ephemeral git config: NOSTR_PRIVATE_KEY → 0600 keyfile (and removed
        // from this process's env so children never see it) → derive identity →
        // build the GIT_CONFIG_* env for nostr auth + signing. The identity
        // primitives live in `buzz-git-identity`, shared with the harness so an
        // agent commits under the same identity regardless of which surface
        // applied it.
        let git_env = match buzz_git_identity::take_key_and_write(dir.path()) {
            Some(id) => {
                let mut entries = buzz_git_identity::identity_signing_entries(&id);
                entries.extend(buzz_git_identity::nostr_credential_entries());
                buzz_git_identity::to_git_config_env(&entries)
            }
            None => Vec::new(),
        };

        Ok(Self {
            _dir: dir,
            path_env,
            git_env,
        })
    }
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o700);
    std::fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn set_owner_only(_: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

#[cfg(not(unix))]
fn symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    // No symlinks without elevation on Windows; copy instead. The target needs
    // a .exe extension or PATH lookup (via PATHEXT) won't treat it as runnable.
    let dst = dst.with_extension("exe");
    std::fs::copy(src, dst).map(|_| ())
}

pub fn artifact_dir(session_root: &Path) -> PathBuf {
    let p = session_root.join("artifacts");
    let _ = std::fs::create_dir_all(&p);
    p
}
