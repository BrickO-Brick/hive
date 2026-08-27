#!/usr/bin/env bash
# Select a stable, isolated Collections database profile for local development.
# Source this from Desktop launchers and local CLI wrappers. An explicit caller
# choice wins, and BUZZ_COLLECTIONS_DB remains the lower-level test/prototype
# override inside the Rust store.

if [[ -z "${BUZZ_COLLECTIONS_PROFILE:-}" ]]; then
    collections_repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
    collections_instance_slug="${BUZZ_INSTANCE_SLUG:-}"

    if [[ -z "$collections_instance_slug" ]] && git -C "$collections_repo_root" rev-parse --is-inside-work-tree &>/dev/null; then
        collections_git_dir=$(git -C "$collections_repo_root" rev-parse --git-dir)
        collections_common_dir=$(git -C "$collections_repo_root" rev-parse --git-common-dir 2>/dev/null)
        if [[ -n "$collections_common_dir" && "$collections_git_dir" != "$collections_common_dir" ]]; then
            collections_branch=$(git -C "$collections_repo_root" rev-parse --abbrev-ref HEAD)
            collections_instance_slug=$(printf '%s' "$collections_branch" \
                | tr '[:upper:]' '[:lower:]' \
                | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')
        fi
    fi

    export BUZZ_COLLECTIONS_PROFILE="dev.${collections_instance_slug:-main}"
fi
