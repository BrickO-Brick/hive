//! Tests for team membership updates.
//!
//! Kept in a sibling file so `teams.rs` stays under the file-size limit.

use super::{
    apply_team_membership_delta, commit_team_create, commit_team_update,
    detach_agents_outside_roster, pending_team_membership_state, propagate_membership,
    PendingTeamMembershipState, PendingTeamMembershipUpdate,
};
use crate::managed_agents::{ManagedAgentRecord, TeamRecord};
use std::cell::RefCell;

/// A running instance: `pubkey` set, linked to a persona, optional binding.
fn instance(seed: char, persona_id: &str, team_id: Option<&str>) -> ManagedAgentRecord {
    let mut record = serde_json::from_value::<ManagedAgentRecord>(serde_json::json!({
        "pubkey": seed.to_string().repeat(64),
        "name": persona_id,
        "persona_id": persona_id,
        "relay_url": "ws://localhost:3000",
        "acp_command": "buzz-acp",
        "agent_command": "goose",
        "agent_args": [],
        "mcp_command": "",
        "turn_timeout_seconds": 320,
        "system_prompt": "prompt",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }))
    .unwrap();
    record.team_id = team_id.map(str::to_string);
    record
}

fn instance_without_persona(seed: char, team_id: Option<&str>) -> ManagedAgentRecord {
    let mut record = instance(seed, "unassigned", team_id);
    record.persona_id = None;
    record
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// A metadata-only edit (no roster change) never re-points an instance —
/// including an unbound instance of a persona this team shares with another.
#[test]
fn metadata_only_edit_leaves_bindings_untouched() {
    let mut records = vec![instance('a', "duncan", None)];
    let roster = ids(&["duncan"]);
    assert!(!apply_team_membership_delta(
        &mut records,
        "team-a",
        &roster,
        &roster
    ));
    assert_eq!(records[0].team_id, None);
}

/// Only the *added* persona's unbound instance is bound; an untouched member
/// already present in the previous roster is not re-pointed.
#[test]
fn added_persona_backfills_only_its_unbound_instance() {
    let mut records = vec![
        instance('a', "duncan", None),
        instance('b', "paul", Some("team-b")),
    ];
    assert!(apply_team_membership_delta(
        &mut records,
        "team-a",
        &ids(&["paul"]),
        &ids(&["paul", "duncan"]),
    ));
    assert_eq!(records[0].team_id.as_deref(), Some("team-a"));
    // Paul was already on the team and bound elsewhere — untouched.
    assert_eq!(records[1].team_id.as_deref(), Some("team-b"));
}

/// An added persona binds even when shared across teams: an explicit add is
/// legitimate evidence (unlike the boot-repair's order-blind case).
#[test]
fn added_shared_persona_binds_to_the_edited_team() {
    let mut records = vec![instance('a', "duncan", None)];
    assert!(apply_team_membership_delta(
        &mut records,
        "team-a",
        &[],
        &ids(&["duncan"]),
    ));
    assert_eq!(records[0].team_id.as_deref(), Some("team-a"));
}

/// Removing a persona ("keep agents") clears its binding to *this* team so a
/// kept instance stops drawing the team's instructions at spawn.
#[test]
fn removed_persona_detaches_instance_bound_to_this_team() {
    let mut records = vec![instance('a', "duncan", Some("team-a"))];
    assert!(apply_team_membership_delta(
        &mut records,
        "team-a",
        &ids(&["duncan"]),
        &[],
    ));
    assert_eq!(records[0].team_id, None);
}

/// Removal only clears a binding pointing at *this* team — an instance of
/// the same persona bound to a different team is left alone.
#[test]
fn removed_persona_leaves_other_team_binding_untouched() {
    let mut records = vec![instance('a', "duncan", Some("team-b"))];
    assert!(!apply_team_membership_delta(
        &mut records,
        "team-a",
        &ids(&["duncan"]),
        &[],
    ));
    assert_eq!(records[0].team_id.as_deref(), Some("team-b"));
}

/// A minimal owner-authored team record for wiring tests.
fn team(id: &str, persona_ids: &[&str]) -> TeamRecord {
    TeamRecord {
        id: id.to_string(),
        name: id.to_string(),
        description: None,
        instructions: None,
        persona_ids: ids(persona_ids),
        is_builtin: false,
        source_dir: None,
        is_symlink: false,
        symlink_target: None,
        version: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

/// Records the injected store IO a commit performs, so a test can assert
/// the wiring saved (or deliberately did not) the agent store.
#[derive(Default)]
struct StoreSpy {
    saved: Option<Vec<ManagedAgentRecord>>,
}

/// Metadata-only `update_team` must pass the TRUE prior roster into the
/// delta, so an unchanged roster is an empty delta and no agent write fires.
/// The `&previous_persona_ids` → `&[]` miswire would drop the prior roster,
/// making the whole roster look "added" and re-pointing the unbound instance.
#[test]
fn commit_team_update_uses_true_prior_roster() {
    let mut teams = vec![team("team-a", &["duncan"])];
    let existing = vec![instance('a', "duncan", None)];
    let spy = RefCell::new(StoreSpy::default());

    let updated = commit_team_update(
        &mut teams,
        "team-a",
        "Team A".to_string(),
        None,
        Some("new instructions".to_string()),
        ids(&["duncan"]),
        "2026-02-02T00:00:00Z".to_string(),
        |_| Ok(()),
        || Ok(existing.clone()),
        |records| {
            spy.borrow_mut().saved = Some(records.to_vec());
            Ok(())
        },
    )
    .expect("metadata-only update succeeds");

    assert_eq!(updated.instructions.as_deref(), Some("new instructions"));
    // Empty delta ⇒ nothing changed ⇒ no save (the true-prior-roster gate).
    assert!(
        spy.borrow().saved.is_none(),
        "metadata-only edit must not write the agent store"
    );
}

/// A metadata-only update keeps its disk-authoritative result when the
/// agent store cannot load. Boot repair restores any missing backfill.
#[test]
fn commit_update_ignores_agent_load_failure_for_metadata_only_edit() {
    let mut teams = vec![team("team-a", &["duncan"])];

    let updated = commit_team_update(
        &mut teams,
        "team-a",
        "Renamed team".to_string(),
        None,
        None,
        ids(&["duncan"]),
        "2026-02-02T00:00:00Z".to_string(),
        |_| Ok(()),
        || Err("corrupt managed-agents.json".to_string()),
        |_| Ok(()),
    )
    .expect("metadata-only update keeps the best-effort policy");

    assert_eq!(updated.name, "Renamed team");
    assert_eq!(teams[0].name, "Renamed team");
}

/// An add-only update reports an agent-store load failure. The staged delta
/// remains available for replay on the next save or launch.
#[test]
fn commit_update_reports_agent_load_failure_for_add_only_edit() {
    let mut teams = vec![team("team-a", &["duncan"])];

    let error = commit_team_update(
        &mut teams,
        "team-a",
        "team-a".to_string(),
        None,
        None,
        ids(&["duncan", "ada"]),
        "2026-02-02T00:00:00Z".to_string(),
        |_| Ok(()),
        || Err("corrupt managed-agents.json".to_string()),
        |_| Ok(()),
    )
    .expect_err("an add-only update must report the lost binding");

    assert!(error.contains("could not update its agents"), "{error}");
    assert_eq!(teams[0].persona_ids, ids(&["duncan", "ada"]));
}

/// A roster removal remains strict when the agent store cannot load. The
/// command cannot prove that it cleared stale bindings in that case.
#[test]
fn commit_update_reports_agent_load_failure_for_removal() {
    let mut teams = vec![team("team-a", &["duncan"])];

    let err = commit_team_update(
        &mut teams,
        "team-a",
        "team-a".to_string(),
        None,
        None,
        ids(&[]),
        "2026-02-02T00:00:00Z".to_string(),
        |_| Ok(()),
        || Err("corrupt managed-agents.json".to_string()),
        |_| Ok(()),
    )
    .expect_err("a removal must report an agent-store load failure");

    assert!(err.contains("could not update its agents"), "{err}");
    assert!(teams[0].persona_ids.is_empty());
}

/// A stale binding makes an otherwise metadata-only update strict. The
/// command must report a failed detach because the delete guard still sees
/// the agent after the team write.
#[test]
fn commit_update_reports_agent_save_failure_for_stale_detach() {
    let mut teams = vec![team("team-a", &[])];

    let err = commit_team_update(
        &mut teams,
        "team-a",
        "Renamed team".to_string(),
        None,
        None,
        ids(&[]),
        "2026-02-02T00:00:00Z".to_string(),
        |_| Ok(()),
        || Ok(vec![instance('a', "duncan", Some("team-a"))]),
        |_| Err("disk full".to_string()),
    )
    .expect_err("a failed stale detach must not report success");

    assert!(err.contains("could not update its agents"), "{err}");
    assert_eq!(teams[0].name, "Renamed team");
}

/// Removing a persona from the roster must reach the detach branch through
/// the command wiring: the instance bound to this team is cleared and saved.
#[test]
fn commit_team_update_removal_detaches_through_wiring() {
    let mut teams = vec![team("team-a", &["duncan"])];
    let existing = vec![instance('a', "duncan", Some("team-a"))];
    let spy = RefCell::new(StoreSpy::default());

    commit_team_update(
        &mut teams,
        "team-a",
        "team-a".to_string(),
        None,
        None,
        ids(&[]),
        "2026-02-02T00:00:00Z".to_string(),
        |_| Ok(()),
        || Ok(existing.clone()),
        |records| {
            spy.borrow_mut().saved = Some(records.to_vec());
            Ok(())
        },
    )
    .expect("removal update succeeds");

    let saved = spy.borrow().saved.clone().expect("detach must save");
    assert_eq!(saved[0].team_id, None, "removed persona detaches from team");
}

/// `create_team` has no prior roster, so its whole roster is the added delta:
/// the unbound instance of a listed persona is bound through the wiring.
#[test]
fn commit_team_create_treats_full_roster_as_added() {
    let mut teams: Vec<TeamRecord> = Vec::new();
    let existing = vec![instance('a', "duncan", None)];
    let spy = RefCell::new(StoreSpy::default());

    let created = commit_team_create(
        &mut teams,
        team("team-a", &["duncan"]),
        |_| Ok(()),
        || Ok(existing.clone()),
        |records| {
            spy.borrow_mut().saved = Some(records.to_vec());
            Ok(())
        },
    )
    .expect("create succeeds");

    assert_eq!(created.id, "team-a");
    let saved = spy.borrow().saved.clone().expect("backfill must save");
    assert_eq!(
        saved[0].team_id.as_deref(),
        Some("team-a"),
        "whole roster is the added delta on create"
    );
}

/// A failing secondary agent write after successful `save_teams` is
/// swallowed by `create`: it still returns the persisted team. Otherwise a UI
/// retry of a create whose team already landed would mint a duplicate.
#[test]
fn commit_create_returns_ok_when_agent_save_fails() {
    let mut teams: Vec<TeamRecord> = Vec::new();
    let created = commit_team_create(
        &mut teams,
        team("team-a", &["duncan"]),
        |_| Ok(()),
        || Ok(vec![instance('a', "duncan", None)]),
        |_| Err("disk full".to_string()),
    )
    .expect("create swallows secondary-store failure");
    assert_eq!(created.id, "team-a");
}

/// `update` must NOT swallow an agent-store failure while emptying a roster.
///
/// The removal clears `team_id` on the removed member. If that write fails
/// and the command reports success, the team is empty on disk but the agent
/// still points to it, so `delete_team_with_cascade` refuses the team. That
/// is the empty-and-undeletable state this feature exists to remove, so the
/// command must report the failure. The team write itself has landed, and an
/// update is idempotent, so a retry is safe.
#[test]
fn commit_update_reports_agent_save_failure_when_emptying_a_roster() {
    let mut teams = vec![team("team-a", &["duncan"])];
    let err = commit_team_update(
        &mut teams,
        "team-a",
        "team-a".to_string(),
        None,
        None,
        ids(&[]),
        "2026-02-02T00:00:00Z".to_string(),
        |_| Ok(()),
        || Ok(vec![instance('a', "duncan", Some("team-a"))]),
        |_| Err("disk full".to_string()),
    )
    .expect_err("an update must not report success when the detach is lost");

    assert!(err.contains("could not update its agents"), "{err}");
    assert!(err.contains("Save the team again"), "{err}");
    // The team write is authoritative and already landed.
    assert!(teams[0].persona_ids.is_empty());
}

/// A retry after a lost detach must repair the binding.
///
/// This is the recovery path of the test above. The team is already saved
/// empty, so the prior→current delta is empty and a delta-only pass would do
/// nothing. `detach_agents_outside_roster` reconciles against the current
/// roster instead, so saving the same empty roster again still clears the
/// stale `team_id` and makes the team deletable.
#[test]
fn resaving_an_already_empty_roster_repairs_a_lost_detach() {
    let mut teams = vec![team("team-a", &[])];
    let spy = RefCell::new(StoreSpy::default());

    commit_team_update(
        &mut teams,
        "team-a",
        "team-a".to_string(),
        None,
        None,
        ids(&[]),
        "2026-02-03T00:00:00Z".to_string(),
        |_| Ok(()),
        // The agent kept its binding because the earlier write was lost.
        || Ok(vec![instance('a', "duncan", Some("team-a"))]),
        |records| {
            spy.borrow_mut().saved = Some(records.to_vec());
            Ok(())
        },
    )
    .expect("the retry succeeds");

    let saved = spy
        .borrow()
        .saved
        .clone()
        .expect("the retry must write the agent store");
    assert_eq!(
        saved[0].team_id, None,
        "a stale binding is cleared against the current roster, not a delta"
    );
}

/// End to end at the command seam, measured by the real delete guard.
///
/// This test starts with a bound agent and empties the roster. It applies
/// `agents_referencing_team` — the predicate `delete_team_with_cascade` uses
/// — to the agent store that the command left behind. It pins both halves of
/// the contract:
///
/// 1. The failed save reports an error. It never claims success while the
///    delete guard still sees the agent.
/// 2. The retry succeeds, and the guard then sees no agent. Delete is
///    possible without an app restart.
#[test]
fn update_never_reports_success_while_the_delete_guard_sees_the_agent() {
    let mut teams = vec![team("team-a", &["duncan"])];
    // The store on disk. A failed save leaves it as it was.
    let store = RefCell::new(vec![instance('a', "duncan", Some("team-a"))]);

    // Attempt 1: the agent write fails.
    let err = commit_team_update(
        &mut teams,
        "team-a",
        "team-a".to_string(),
        None,
        None,
        ids(&[]),
        "2026-02-02T00:00:00Z".to_string(),
        |_| Ok(()),
        || Ok(store.borrow().clone()),
        |_| Err("disk full".to_string()),
    )
    .expect_err("the command must report the lost detach");
    assert!(err.contains("could not update its agents"), "{err}");

    // The team is empty on disk, but the guard still refuses deletion. The
    // command reported this state instead of hiding it.
    assert!(teams[0].persona_ids.is_empty());
    assert_eq!(
        crate::managed_agents::agents_referencing_team(&store.borrow(), &teams[0]),
        vec!["duncan"],
        "the guard still sees the agent, so the report was required"
    );

    // Attempt 2: the same save, and now the write lands.
    commit_team_update(
        &mut teams,
        "team-a",
        "team-a".to_string(),
        None,
        None,
        ids(&[]),
        "2026-02-03T00:00:00Z".to_string(),
        |_| Ok(()),
        || Ok(store.borrow().clone()),
        |records| {
            *store.borrow_mut() = records.to_vec();
            Ok(())
        },
    )
    .expect("the retry succeeds");

    assert!(
        crate::managed_agents::agents_referencing_team(&store.borrow(), &teams[0]).is_empty(),
        "the retry must make the team deletable"
    );
}

/// This test starts with a bound persona-less agent and empties the roster. It
/// applies `agents_referencing_team` — the predicate `delete_team_with_cascade`
/// uses — to the agent store that the update saved. The update must clear this
/// direct-command record because the delete guard does not require a persona.
#[test]
fn emptying_a_roster_detaches_a_bound_persona_less_agent() {
    let mut teams = vec![team("team-a", &["duncan"])];
    let store = RefCell::new(vec![instance_without_persona('a', Some("team-a"))]);

    commit_team_update(
        &mut teams,
        "team-a",
        "team-a".to_string(),
        None,
        None,
        ids(&[]),
        "2026-02-02T00:00:00Z".to_string(),
        |_| Ok(()),
        || Ok(store.borrow().clone()),
        |records| {
            *store.borrow_mut() = records.to_vec();
            Ok(())
        },
    )
    .expect("the update must detach a bound persona-less agent");

    assert!(
        crate::managed_agents::agents_referencing_team(&store.borrow(), &teams[0]).is_empty(),
        "the delete guard must not see the detached agent"
    );
}

/// The reconcile is scoped: it clears a binding to *this* team when the
/// persona is absent or unset, and it leaves a listed persona alone.
#[test]
fn detach_outside_roster_is_scoped_to_this_team_and_absent_personas() {
    let mut records = vec![
        instance('a', "duncan", Some("team-a")),
        instance('b', "paul", Some("team-b")),
        instance('c', "ada", Some("team-a")),
        instance_without_persona('d', Some("team-a")),
    ];

    assert!(detach_agents_outside_roster(
        &mut records,
        "team-a",
        &ids(&["ada"]),
    ));

    assert_eq!(records[0].team_id, None, "absent from this team's roster");
    assert_eq!(
        records[3].team_id, None,
        "an unset persona cannot remain bound to this team"
    );
    assert_eq!(
        records[1].team_id.as_deref(),
        Some("team-b"),
        "another team's binding is untouched"
    );
    assert_eq!(
        records[2].team_id.as_deref(),
        Some("team-a"),
        "still on the roster, so the binding stays"
    );
}

/// A staged update replays only when the team keeps the staged roster. The
/// prior roster means the team write did not land. A missing team or a different
/// roster means an inbound event superseded the stage. Each stale stage is safe
/// to clear without a membership change.
#[test]
fn pending_membership_state_distinguishes_replay_and_stale_stages() {
    let pending = PendingTeamMembershipUpdate {
        team_id: "team-a".to_string(),
        previous_persona_ids: ids(&["duncan"]),
        current_persona_ids: ids(&["ada"]),
    };

    assert!(matches!(
        pending_team_membership_state(&pending, &[team("team-a", &["ada"])]),
        Ok(PendingTeamMembershipState::Pending)
    ));
    assert!(matches!(
        pending_team_membership_state(&pending, &[team("team-a", &["duncan"])]),
        Ok(PendingTeamMembershipState::Superseded)
    ));
    assert!(matches!(
        pending_team_membership_state(&pending, &[]),
        Ok(PendingTeamMembershipState::MissingTeam)
    ));
    assert!(matches!(
        pending_team_membership_state(&pending, &[team("team-a", &["paul"])]),
        Ok(PendingTeamMembershipState::UnexpectedRoster)
    ));
}

/// The durable replay uses the original replace delta after the first agent
/// save fails. It binds Ada on retry even though the persisted roster already
/// contains Ada and therefore supplies no new delta.
#[test]
fn replayed_replace_delta_binds_the_added_instance() {
    let previous = ids(&["duncan"]);
    let current = ids(&["ada"]);
    let store = RefCell::new(vec![
        instance('a', "duncan", Some("team-a")),
        instance('b', "ada", None),
    ]);

    let error = propagate_membership(
        "team-a",
        &previous,
        &current,
        || Ok(store.borrow().clone()),
        |_| Err("disk full".to_string()),
    )
    .expect_err("the first save fails");
    assert!(error.to_string().contains("disk full"));

    propagate_membership(
        "team-a",
        &previous,
        &current,
        || Ok(store.borrow().clone()),
        |records| {
            *store.borrow_mut() = records.to_vec();
            Ok(())
        },
    )
    .expect("the durable replay succeeds");

    assert_eq!(store.borrow()[0].team_id, None);
    assert_eq!(store.borrow()[1].team_id.as_deref(), Some("team-a"));
}

/// A roster with every binding already correct writes nothing.
#[test]
fn detach_outside_roster_is_inert_when_nothing_is_stale() {
    let mut records = vec![instance('a', "duncan", Some("team-a"))];
    assert!(!detach_agents_outside_roster(
        &mut records,
        "team-a",
        &ids(&["duncan"]),
    ));
    assert_eq!(records[0].team_id.as_deref(), Some("team-a"));
}
