use super::{inspect_workspace_blocking, validate_object_id, GitHubRepositoryWorkspace};
use serde::Serialize;
use std::fs::Permissions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const MAX_WORKSPACE_FILE_BYTES: usize = 1024 * 1024;

#[derive(Serialize)]
pub struct GitHubRepositoryWorkspaceFile {
    path: String,
    content: String,
    result_tree: String,
}

fn editable_workspace_path(repo_dir: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative_path.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || relative
            .components()
            .next()
            .is_some_and(|component| component.as_os_str() == ".git")
    {
        return Err("The proposal file path is not a safe workspace-relative path.".to_string());
    }
    let canonical_repo = repo_dir
        .canonicalize()
        .map_err(|error| format!("resolve proposal workspace: {error}"))?;
    let target = canonical_repo.join(relative);
    let parent = target
        .parent()
        .ok_or_else(|| "The proposal file has no parent directory.".to_string())?
        .canonicalize()
        .map_err(|error| format!("resolve proposal file parent: {error}"))?;
    if !parent.starts_with(&canonical_repo) {
        return Err("The proposal file resolves outside its workspace.".to_string());
    }
    let metadata = std::fs::symlink_metadata(&target)
        .map_err(|error| format!("read proposal file metadata: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Only regular, non-symlink proposal files can be edited.".to_string());
    }
    Ok(target)
}

fn require_editable_workspace(
    owner: &str,
    name: &str,
    repos_dir: Option<&str>,
    workspace_id: Option<&str>,
    path: &str,
    expected_result_tree: &str,
) -> Result<(GitHubRepositoryWorkspace, PathBuf), String> {
    validate_object_id(expected_result_tree, "Expected result tree")?;
    let workspace = inspect_workspace_blocking(owner, name, repos_dir, workspace_id)?
        .ok_or_else(|| "Prepare the local repository before editing files.".to_string())?;
    if workspace.result_tree != expected_result_tree {
        return Err("The workspace changed. Refresh the proposal before editing.".to_string());
    }
    if !workspace.files.iter().any(|file| file.path == path) {
        return Err("Only files already included in this proposal can be edited.".to_string());
    }
    let target = editable_workspace_path(Path::new(&workspace.path), path)?;
    Ok((workspace, target))
}

pub(super) fn read_workspace_file_blocking(
    owner: &str,
    name: &str,
    repos_dir: Option<&str>,
    workspace_id: Option<&str>,
    path: &str,
    expected_result_tree: &str,
) -> Result<GitHubRepositoryWorkspaceFile, String> {
    let (workspace, target) = require_editable_workspace(
        owner,
        name,
        repos_dir,
        workspace_id,
        path,
        expected_result_tree,
    )?;
    let bytes = std::fs::read(&target).map_err(|error| format!("read proposal file: {error}"))?;
    if bytes.len() > MAX_WORKSPACE_FILE_BYTES {
        return Err(
            "Proposal files larger than 1 MiB must be edited in an external IDE.".to_string(),
        );
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "Binary proposal files must be edited in an external IDE.".to_string())?;
    Ok(GitHubRepositoryWorkspaceFile {
        path: path.to_string(),
        content,
        result_tree: workspace.result_tree,
    })
}

pub(super) fn write_workspace_file_blocking(
    owner: &str,
    name: &str,
    repos_dir: Option<&str>,
    workspace_id: Option<&str>,
    path: &str,
    content: &str,
    expected_result_tree: &str,
) -> Result<GitHubRepositoryWorkspace, String> {
    if content.len() > MAX_WORKSPACE_FILE_BYTES || content.contains('\0') {
        return Err("Proposal file content must be UTF-8 text no larger than 1 MiB.".to_string());
    }
    let (before, target) = require_editable_workspace(
        owner,
        name,
        repos_dir,
        workspace_id,
        path,
        expected_result_tree,
    )?;
    let existing =
        std::fs::read(&target).map_err(|error| format!("read proposal file: {error}"))?;
    if existing == content.as_bytes() {
        return Ok(before);
    }
    let permissions: Permissions = std::fs::metadata(&target)
        .map_err(|error| format!("read proposal file permissions: {error}"))?
        .permissions();
    let parent = target
        .parent()
        .ok_or_else(|| "The proposal file has no parent directory.".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("create atomic proposal file: {error}"))?;
    temporary
        .write_all(content.as_bytes())
        .and_then(|()| temporary.flush())
        .map_err(|error| format!("write atomic proposal file: {error}"))?;
    temporary
        .as_file()
        .set_permissions(permissions)
        .map_err(|error| format!("preserve proposal file permissions: {error}"))?;
    temporary
        .persist(&target)
        .map_err(|error| format!("replace proposal file atomically: {}", error.error))?;
    inspect_workspace_blocking(owner, name, repos_dir, workspace_id)?
        .ok_or_else(|| "The local repository disappeared after editing.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Output};

    fn test_git(repo: &Path, args: &[&str]) -> Output {
        Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .expect("run test git command")
    }

    fn editable_repository() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().expect("temporary repositories root");
        let repo = root.path().join("BrickO-Brick--hive");
        std::fs::create_dir(&repo).expect("create repository");
        assert!(test_git(&repo, &["init", "--initial-branch=main"])
            .status
            .success());
        assert!(test_git(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/BrickO-Brick/hive.git",
            ],
        )
        .status
        .success());
        std::fs::write(repo.join("proposal.txt"), "before\n").expect("write proposal file");
        assert!(test_git(&repo, &["add", "proposal.txt"]).status.success());
        assert!(test_git(
            &repo,
            &[
                "-c",
                "user.name=Buzz Test",
                "-c",
                "user.email=buzz@example.test",
                "commit",
                "-m",
                "Initial",
            ],
        )
        .status
        .success());
        std::fs::write(repo.join("proposal.txt"), "agent recommendation\n")
            .expect("modify proposal file");
        (root, repo)
    }

    #[test]
    fn file_edits_are_bound_to_the_exact_proposal_tree() {
        let (root, repo) = editable_repository();
        let before = inspect_workspace_blocking("BrickO-Brick", "hive", root.path().to_str(), None)
            .expect("inspect workspace")
            .expect("workspace exists");
        let opened = read_workspace_file_blocking(
            "BrickO-Brick",
            "hive",
            root.path().to_str(),
            None,
            "proposal.txt",
            &before.result_tree,
        )
        .expect("read proposal file");
        assert_eq!(opened.content, "agent recommendation\n");
        assert_eq!(opened.result_tree, before.result_tree);

        let after = write_workspace_file_blocking(
            "BrickO-Brick",
            "hive",
            root.path().to_str(),
            None,
            "proposal.txt",
            "user revision\n",
            &before.result_tree,
        )
        .expect("write proposal file");
        assert_eq!(
            std::fs::read_to_string(repo.join("proposal.txt")).expect("read updated file"),
            "user revision\n"
        );
        assert_ne!(after.result_tree, before.result_tree);
        assert!(test_git(&repo, &["diff", "--cached", "--quiet"])
            .status
            .success());

        let stale = write_workspace_file_blocking(
            "BrickO-Brick",
            "hive",
            root.path().to_str(),
            None,
            "proposal.txt",
            "stale overwrite\n",
            &before.result_tree,
        );
        let Err(stale) = stale else {
            panic!("stale result tree must be rejected");
        };
        assert!(stale.contains("workspace changed"));
        assert_eq!(
            std::fs::read_to_string(repo.join("proposal.txt")).expect("read preserved file"),
            "user revision\n"
        );
    }

    #[test]
    fn file_editor_rejects_git_metadata_and_parent_traversal() {
        let (_root, repo) = editable_repository();
        assert!(editable_workspace_path(&repo, ".git/config").is_err());
        assert!(editable_workspace_path(&repo, "../outside.txt").is_err());
        assert!(editable_workspace_path(&repo, "/tmp/outside.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn file_editor_rejects_symlinks() {
        use std::os::unix::fs::symlink;

        let (root, repo) = editable_repository();
        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, "outside\n").expect("write outside file");
        std::fs::remove_file(repo.join("proposal.txt")).expect("remove proposal file");
        symlink(&outside, repo.join("proposal.txt")).expect("link proposal file");
        assert!(editable_workspace_path(&repo, "proposal.txt").is_err());
    }
}
