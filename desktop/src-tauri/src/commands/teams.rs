use tauri::AppHandle;
use uuid::Uuid;

use crate::{
    app_state::AppState,
    managed_agents::{
        delete_team_with_cascade, ensure_persona_ids_are_active, load_managed_agents,
        load_personas, load_teams, save_managed_agents, save_teams, try_regenerate_nest,
        CreateTeamRequest, TeamRecord, UpdateTeamRequest,
    },
    util::now_iso,
};

fn trim_required(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is required"));
    }
    Ok(trimmed.to_string())
}

fn trim_optional(value: Option<String>) -> Option<String> {
    value.and_then(|candidate| {
        let trimmed = candidate.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

/// Clear `team_id` on every instance that is bound to `team_id` but whose
/// persona is absent from `current_persona_ids` or unset. Reports whether
/// anything changed.
///
/// This reads the current roster, not a delta. That is what makes a failed
/// detach recoverable: after a failed agent-store write the team is already
/// saved with the new roster, so the prior→current delta is empty on the next
/// save and a delta-only pass would do nothing. The invariant here is
/// state-based — an instance bound to a team must have its persona on that
/// team's roster — so a second save still repairs the binding.
///
/// Bindings to other teams are untouched, and an unbound instance is left to
/// the delta's backfill branch.
fn detach_agents_outside_roster(
    records: &mut [crate::managed_agents::ManagedAgentRecord],
    team_id: &str,
    current_persona_ids: &[String],
) -> bool {
    let mut changed = false;
    for record in records.iter_mut() {
        if record.pubkey.is_empty() || record.team_id.as_deref() != Some(team_id) {
            continue;
        }
        if !current_persona_ids
            .iter()
            .any(|id| record.persona_id.as_deref() == Some(id))
        {
            record.team_id = None;
            changed = true;
        }
    }
    changed
}

/// Reports a membership propagation failure. The update command reports a
/// failure for a roster removal or a failed stale-binding detach. Other changes
/// keep the best-effort policy.
pub(in crate::commands) enum MembershipPropagationError {
    Load(String),
    Save { error: String, detached: bool },
}

impl MembershipPropagationError {
    fn must_report(&self) -> bool {
        matches!(self, Self::Save { detached: true, .. })
    }
}

impl std::fmt::Display for MembershipPropagationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Load(error) | Self::Save { error, .. } => formatter.write_str(error),
        }
    }
}

/// Propagate a team's membership to its members' already-running instances.
/// Loads the agent store, applies the roster delta via
/// [`apply_team_membership_delta`], reconciles stale bindings via
/// [`detach_agents_outside_roster`], and re-saves only when something changed.
/// Reports the failure type so the caller can choose its error policy.
pub(in crate::commands) fn propagate_membership(
    team_id: &str,
    previous_persona_ids: &[String],
    current_persona_ids: &[String],
    load_agents: impl FnOnce() -> Result<Vec<crate::managed_agents::ManagedAgentRecord>, String>,
    save_agents: impl FnOnce(&[crate::managed_agents::ManagedAgentRecord]) -> Result<(), String>,
) -> Result<(), MembershipPropagationError> {
    let mut records = load_agents().map_err(MembershipPropagationError::Load)?;
    let delta_changed = apply_team_membership_delta(
        &mut records,
        team_id,
        previous_persona_ids,
        current_persona_ids,
    );
    let detached = detach_agents_outside_roster(&mut records, team_id, current_persona_ids);
    if delta_changed || detached {
        save_agents(&records)
            .map_err(|error| MembershipPropagationError::Save { error, detached })?;
    }
    Ok(())
}

/// Propagate a team's membership *change* to its members' already-running
/// instances, best-effort: any load/save error is logged and swallowed.
///
/// Used by [`commit_team_create`] and by the inbound reconcile path. For a
/// create, the team write already landed, and failing the command would make a
/// UI retry mint a duplicate team; a missing backfill only costs a member the
/// team instructions until boot repair runs, and it blocks nothing.
///
/// [`commit_team_update`] does **not** use this policy. A removal that does not
/// reach the agent store leaves an agent bound to the team, and the delete guard
/// then refuses the team — so an update reports the failure instead.
///
/// `load_agents`/`save_agents` are injected so the command wiring (prior-roster
/// capture, delta direction, and this best-effort policy) is unit-testable
/// without an `AppHandle`; the commands pass the real store IO.
///
/// Shared with the inbound reconcile path (`commands::personas::inbound`): a
/// 30176 team edit arriving from another device must bind/detach instances the
/// same way a local edit does, so both call this one wrapper.
pub(in crate::commands) fn propagate_membership_best_effort(
    team_id: &str,
    previous_persona_ids: &[String],
    current_persona_ids: &[String],
    load_agents: impl FnOnce() -> Result<Vec<crate::managed_agents::ManagedAgentRecord>, String>,
    save_agents: impl FnOnce(&[crate::managed_agents::ManagedAgentRecord]) -> Result<(), String>,
) {
    if let Err(e) = propagate_membership(
        team_id,
        previous_persona_ids,
        current_persona_ids,
        load_agents,
        save_agents,
    ) {
        eprintln!("buzz-desktop: team-membership-propagate: {e}");
    }
}

/// In-memory core of [`create_team`]: push the built team, persist teams
/// authoritatively, then propagate its whole roster (no prior members ⇒ the
/// whole roster is the added delta) to live instances best-effort. Decoupled
/// from the `AppHandle` shell via injected persistence so the create wiring is
/// unit-testable. A `persist_teams` error propagates; agent IO is best-effort.
fn commit_team_create(
    teams: &mut Vec<TeamRecord>,
    team: TeamRecord,
    persist_teams: impl FnOnce(&[TeamRecord]) -> Result<(), String>,
    load_agents: impl FnOnce() -> Result<Vec<crate::managed_agents::ManagedAgentRecord>, String>,
    save_agents: impl FnOnce(&[crate::managed_agents::ManagedAgentRecord]) -> Result<(), String>,
) -> Result<TeamRecord, String> {
    teams.push(team.clone());
    persist_teams(teams)?;
    propagate_membership_best_effort(&team.id, &[], &team.persona_ids, load_agents, save_agents);
    Ok(team)
}

/// In-memory core of [`update_team`]: mutate the matching team, capturing its
/// roster *before* the edit, persist teams authoritatively, then propagate the
/// prior→current delta to live instances. The prior-roster capture
/// and its use as the delta baseline live here — not at a command call site —
/// so a miswire to the wrong baseline is caught by a test. Injected persistence
/// keeps it `AppHandle`-free; a `persist_teams` error propagates. Returns the
/// updated team.
///
/// Unlike [`commit_team_create`], an update reports an agent-store failure for
/// a roster removal or a failed stale-binding detach. A removal clears `team_id`
/// on the removed member. If that write does not land, the agent keeps the
/// binding and `delete_team_with_cascade` refuses the team, so the user gets an
/// empty team that they cannot delete — the exact defect this command must not
/// create. The command must not report success while the delete guard can still
/// refuse.
///
/// When this reports an agent-store error after the team write, `update_team`
/// does not retain the team for relay sync until a retry or the next launch
/// migration runs.
///
/// Reporting is safe here because an update is idempotent: it targets an
/// existing team by id, so a retry cannot mint a duplicate team. A create has no
/// id yet, which is why it keeps the best-effort policy.
#[allow(clippy::too_many_arguments)]
fn commit_team_update(
    teams: &mut [TeamRecord],
    id: &str,
    name: String,
    description: Option<String>,
    instructions: Option<String>,
    persona_ids: Vec<String>,
    now: String,
    persist_teams: impl FnOnce(&[TeamRecord]) -> Result<(), String>,
    load_agents: impl FnOnce() -> Result<Vec<crate::managed_agents::ManagedAgentRecord>, String>,
    save_agents: impl FnOnce(&[crate::managed_agents::ManagedAgentRecord]) -> Result<(), String>,
) -> Result<TeamRecord, String> {
    let team = teams
        .iter_mut()
        .find(|record| record.id == id)
        .ok_or_else(|| format!("team {id} not found"))?;

    // Capture the pre-edit roster before mutation: the propagation delta
    // (added → backfill, removed → detach) is computed against it.
    let previous_persona_ids = team.persona_ids.clone();
    team.name = name;
    team.description = description;
    team.instructions = instructions;
    team.persona_ids = persona_ids;
    team.updated_at = now;

    let updated = team.clone();
    persist_teams(teams)?;
    let has_removal = previous_persona_ids
        .iter()
        .any(|persona_id| !updated.persona_ids.contains(persona_id));
    if let Err(error) = propagate_membership(
        &updated.id,
        &previous_persona_ids,
        &updated.persona_ids,
        load_agents,
        save_agents,
    ) {
        if has_removal || error.must_report() {
            return Err(format!(
                "Saved the team, but could not update its agents: {error}. The team can refuse deletion \
                 until this succeeds. Save the team again."
            ));
        }
        eprintln!("buzz-desktop: team-membership-propagate: {error}");
    }
    Ok(updated)
}

/// Pure core of the membership propagation: apply the roster delta to `records`
/// in place and report whether anything changed. Decoupled from the store IO so
/// the binding rules are unit-testable.
///
/// Two directions, keyed on the delta between the pre-edit and post-edit
/// rosters:
///
/// - **Added** (`current` but not `previous`): backfill `team_id` on the
///   persona's *unbound* instances, so an added persona spawns with the team's
///   instructions (`spawn_snapshot::effective_team_instructions` keys on
///   `record.team_id`). Only an unset field is set — a shared persona keeps an
///   existing binding — and an explicit add is legitimate binding evidence even
///   when the persona belongs to several teams.
/// - **Removed** (`previous` but not `current`): clear `team_id` on instances
///   bound to *this* team, so a "keep agents" removal stops feeding a kept
///   instance the instructions of a team it no longer belongs to. Bindings to
///   other teams are untouched.
///
/// Delta-scoping is what keeps a metadata-only edit inert: with no roster
/// change both sets are empty and no instance is re-pointed — a shared unbound
/// persona is not silently bound to whichever team was last edited. `create`
/// has no prior roster, so it passes an empty `previous` and the whole roster is
/// "added" (the pre-fix whole-roster backfill). A persona both removed and
/// re-added in one edit appears in neither set (set difference, not
/// operation order), so its binding is left as-is.
fn apply_team_membership_delta(
    records: &mut [crate::managed_agents::ManagedAgentRecord],
    team_id: &str,
    previous_persona_ids: &[String],
    current_persona_ids: &[String],
) -> bool {
    let added: Vec<&str> = current_persona_ids
        .iter()
        .filter(|id| !previous_persona_ids.iter().any(|p| p == *id))
        .map(String::as_str)
        .collect();
    let removed: Vec<&str> = previous_persona_ids
        .iter()
        .filter(|id| !current_persona_ids.iter().any(|p| p == *id))
        .map(String::as_str)
        .collect();
    if added.is_empty() && removed.is_empty() {
        return false;
    }

    let mut changed = false;
    for record in records.iter_mut() {
        if record.pubkey.is_empty() {
            continue;
        }
        let Some(persona_id) = record.persona_id.as_deref() else {
            continue;
        };
        if record.team_id.is_none() && added.contains(&persona_id) {
            record.team_id = Some(team_id.to_string());
            changed = true;
        } else if record.team_id.as_deref() == Some(team_id) && removed.contains(&persona_id) {
            record.team_id = None;
            changed = true;
        }
    }
    changed
}

/// Retain a freshly authored team event in the local store, flagged for relay
/// sync. Called inside a command's `managed_agents_store_lock`-held body after
/// `save_teams`; the background flush loop publishes it out-of-band.
///
/// Mirrors `commands::personas::retain_persona_pending`. Built-in teams are not
/// owner-authored, so the caller skips them — this helper assumes the team is
/// publishable. Best-effort: a failure here is logged and swallowed so a
/// retention hiccup never blocks the disk-authoritative write.
///
/// Unlike `retain_managed_agent_pending`, this has no projection-equality
/// short-circuit: teams have no start/stop runtime churn, so a republish only
/// happens on an actual user edit. The guard is intentionally omitted.
pub(super) fn retain_team_pending(app: &AppHandle, state: &AppState, team: &TeamRecord) {
    use crate::managed_agents::{
        persona_events::monotonic_created_at,
        retention::{get_retained_event, open_retention_db, retain_event, RetainedEvent},
        team_events::build_team_event,
    };
    use buzz_core_pkg::kind::KIND_TEAM;
    use nostr::JsonUtil;

    let result = (|| -> Result<(), String> {
        let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
        let conn = open_retention_db(&scope.db_path)?;
        let pubkey = scope.owner_keys.public_key().to_hex();
        // Monotonic created_at: bump past the retained head (NIP-AP step 3).
        let prior =
            get_retained_event(&conn, KIND_TEAM, &pubkey, &team.id)?.map(|row| row.created_at);
        let event = build_team_event(team)?
            .custom_created_at(monotonic_created_at(prior))
            .sign_with_keys(&scope.owner_keys)
            .map_err(|e| format!("failed to sign team event: {e}"))?;
        retain_event(
            &conn,
            &RetainedEvent {
                kind: KIND_TEAM,
                pubkey,
                d_tag: team.id.clone(),
                content: event.content.to_string(),
                created_at: event.created_at.as_secs() as i64,
                raw_event: event.as_json(),
                pending_sync: true,
            },
        )
    })();
    if let Err(e) = result {
        eprintln!("buzz-desktop: team-retain: {e}");
    }
}

/// Purge a deleted team's pending row and enqueue a NIP-09 tombstone, both
/// inside the `managed_agents_store_lock`-held delete body.
///
/// Mirrors `commands::personas::tombstone_persona_pending`: the team row is
/// purged first so an unpublished edit can never resurrect it after the
/// tombstone publishes, then the kind:5 tombstone is retained at its own
/// `(5, pubkey, d_tag)` coordinate with `pending_sync = 1`. Best-effort: a
/// failure is logged and swallowed so a retention hiccup never blocks the
/// disk-authoritative delete.
fn tombstone_team_pending(app: &AppHandle, state: &AppState, d_tag: &str) {
    use crate::managed_agents::{
        retention::{
            delete_retained_event, open_retention_db, retain_event, tombstone_retention_d_tag,
            RetainedEvent,
        },
        team_events::build_team_delete,
    };
    use buzz_core_pkg::kind::KIND_TEAM;
    use nostr::JsonUtil;

    const KIND_DELETE: u32 = 5;

    let result = (|| -> Result<(), String> {
        let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
        let pubkey = scope.owner_keys.public_key().to_hex();
        let event = build_team_delete(d_tag, &pubkey)?
            .sign_with_keys(&scope.owner_keys)
            .map_err(|e| format!("failed to sign team tombstone: {e}"))?;
        let conn = open_retention_db(&scope.db_path)?;
        delete_retained_event(&conn, KIND_TEAM, &pubkey, d_tag)?;
        retain_event(
            &conn,
            &RetainedEvent {
                kind: KIND_DELETE,
                pubkey,
                // Key by the target coordinate so cross-kind d-tag tombstones
                // occupy distinct rows (F2c).
                d_tag: tombstone_retention_d_tag(KIND_TEAM, d_tag),
                content: event.content.to_string(),
                created_at: event.created_at.as_secs() as i64,
                raw_event: event.as_json(),
                pending_sync: true,
            },
        )
    })();
    if let Err(e) = result {
        eprintln!("buzz-desktop: team-tombstone: {e}");
    }
}

#[tauri::command]
pub async fn list_teams(app: AppHandle) -> Result<Vec<TeamRecord>, String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        load_teams(&app)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[tauri::command]
pub async fn create_team(input: CreateTeamRequest, app: AppHandle) -> Result<TeamRecord, String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let name = trim_required(&input.name, "Team name")?;
        let description = trim_optional(input.description);
        let instructions = trim_optional(input.instructions);
        let now = now_iso();

        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let personas = load_personas(&app)?;
        ensure_persona_ids_are_active(&personas, &input.persona_ids)?;
        let mut teams = load_teams(&app)?;
        let team = TeamRecord {
            id: Uuid::new_v4().to_string(),
            name,
            description,
            instructions,
            persona_ids: input.persona_ids,
            is_builtin: false,
            source_dir: None,
            is_symlink: false,
            symlink_target: None,
            version: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let team = commit_team_create(
            &mut teams,
            team,
            |teams| save_teams(&app, teams),
            || load_managed_agents(&app),
            |records| save_managed_agents(&app, records),
        )?;
        // Created teams are always non-builtin; publish to the relay.
        retain_team_pending(&app, &state, &team);
        Ok(team)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[tauri::command]
pub async fn update_team(input: UpdateTeamRequest, app: AppHandle) -> Result<TeamRecord, String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let name = trim_required(&input.name, "Team name")?;
        let description = trim_optional(input.description);
        let instructions = trim_optional(input.instructions);

        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let personas = load_personas(&app)?;
        ensure_persona_ids_are_active(&personas, &input.persona_ids)?;
        let mut teams = load_teams(&app)?;
        let updated = commit_team_update(
            &mut teams,
            &input.id,
            name,
            description,
            instructions,
            input.persona_ids,
            now_iso(),
            |teams| save_teams(&app, teams),
            || load_managed_agents(&app),
            |records| save_managed_agents(&app, records),
        )?;
        // Built-in teams are not owner-authored — never publish them.
        if !updated.is_builtin {
            retain_team_pending(&app, &state, &updated);
        }
        Ok(updated)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[cfg(test)]
#[path = "teams_tests.rs"]
mod tests;

#[tauri::command]
pub async fn delete_team(id: String, app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let cascaded_persona_d_tags = delete_team_with_cascade(&app, &id)?;
        // delete_team_with_cascade rejects built-in teams via validate_team_deletion,
        // so reaching here means this team was owner-published — tombstone it. The
        // d_tag is the team id, captured before the record left the store.
        tombstone_team_pending(&app, &state, &id);
        // Tombstone the cascaded personas too, so their orphaned kind:30175 heads
        // don't linger on the relay (F4). Each d-tag was captured pre-removal.
        for persona_d_tag in &cascaded_persona_d_tags {
            super::personas::tombstone_persona_pending(&app, &state, persona_d_tag);
        }
        try_regenerate_nest(&app);
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}
