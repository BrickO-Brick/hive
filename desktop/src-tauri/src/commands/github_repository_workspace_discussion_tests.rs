use super::inspect_workspace_blocking;
use std::path::Path;
use std::process::{Command, Output};

fn test_git(repo: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .args(["-C", repo.to_str().expect("repository path")])
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("run git")
}

#[test]
fn discussion_ids_resolve_distinct_worktrees_from_one_mirror() {
    let root = tempfile::tempdir().expect("temporary repositories root");
    let seed = root.path().join("seed");
    std::fs::create_dir(&seed).expect("create seed");
    assert!(test_git(&seed, &["init", "--initial-branch=main"])
        .status
        .success());
    assert!(test_git(
        &seed,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/BrickO-Brick/hive.git",
        ],
    )
    .status
    .success());
    std::fs::write(seed.join("README.md"), "shared base\n").expect("write seed");
    assert!(test_git(&seed, &["add", "README.md"]).status.success());
    assert!(test_git(
        &seed,
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

    let managed = root.path().join(".hive-workspaces");
    let mirror = managed.join("mirrors/BrickO-Brick--hive.git");
    std::fs::create_dir_all(mirror.parent().expect("mirror parent")).expect("create mirror parent");
    assert!(test_git(
        root.path(),
        &[
            "clone",
            "--bare",
            seed.to_str().expect("seed path"),
            mirror.to_str().expect("mirror path"),
        ],
    )
    .status
    .success());
    assert!(test_git(
        &mirror,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/BrickO-Brick/hive.git",
        ],
    )
    .status
    .success());
    let worktrees = managed.join("worktrees/BrickO-Brick--hive");
    std::fs::create_dir_all(&worktrees).expect("create worktree parent");
    for discussion in ["discussion-a", "discussion-b"] {
        assert!(test_git(
            &mirror,
            &[
                "worktree",
                "add",
                "-b",
                &format!("hive/{discussion}"),
                worktrees.join(discussion).to_str().expect("worktree path"),
                "main",
            ],
        )
        .status
        .success());
    }

    let first = inspect_workspace_blocking(
        "BrickO-Brick",
        "hive",
        root.path().to_str(),
        Some("discussion-a"),
    )
    .expect("inspect first")
    .expect("first workspace");
    let second = inspect_workspace_blocking(
        "BrickO-Brick",
        "hive",
        root.path().to_str(),
        Some("discussion-b"),
    )
    .expect("inspect second")
    .expect("second workspace");
    assert_ne!(first.path, second.path);
    assert_eq!(first.branch, "hive/discussion-a");
    assert_eq!(second.branch, "hive/discussion-b");
    assert_eq!(first.base_commit, second.base_commit);

    assert!(test_git(
        Path::new(&first.path),
        &["branch", "-m", "users/buzz-user/discussion-a"],
    )
    .status
    .success());
    let transitioned = inspect_workspace_blocking(
        "BrickO-Brick",
        "hive",
        root.path().to_str(),
        Some("discussion-a"),
    )
    .expect("inspect transitioned publication branch")
    .expect("transitioned workspace");
    assert_eq!(transitioned.branch, "users/buzz-user/discussion-a");
    assert_eq!(transitioned.path, first.path);
}
