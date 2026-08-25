//! Dormant agent-side executor for signed workflow lifecycle commands.
//!
//! This module deliberately has no production ingestion or polling hook. The
//! activation layer may construct an enabled executor only after relay-side
//! command persistence and replay protection are available.

use std::collections::HashMap;

use buzz_core::kind::KIND_WORKFLOW_DEF;
use buzz_core::workflow_owner_command::{
    parse_owner_command, WorkflowOwnerCommand, WorkflowOwnerError, WorkflowOwnerOperation,
    WorkflowOwnerResultStatus, WORKFLOW_OWNER_MAX_REASON_BYTES,
};
use nostr::{Event, EventId, Keys, PublicKey};
use thiserror::Error;
use uuid::Uuid;

/// Explicit capability state for the dormant lifecycle executor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkflowLifecycleCapability {
    /// Reject every command without invoking the lifecycle backend.
    Disabled,
    /// Permit validated commands to reach the lifecycle backend.
    Enabled,
}

/// Exact, agent-authorized command binding passed to a lifecycle backend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowLifecycleRequest {
    command_id: Uuid,
    command_event_id: EventId,
    owner_pubkey: PublicKey,
    agent_pubkey: PublicKey,
    workflow_id: Uuid,
    expected_revision: EventId,
    operation: WorkflowOwnerOperation,
}

impl WorkflowLifecycleRequest {
    /// Stable replay identity chosen by the owner.
    pub fn command_id(&self) -> Uuid {
        self.command_id
    }
    /// Exact owner-signed command event.
    pub fn command_event_id(&self) -> EventId {
        self.command_event_id
    }
    /// Immutable human owner authorized to issue the command.
    pub fn owner_pubkey(&self) -> PublicKey {
        self.owner_pubkey
    }
    /// Agent whose signing authority owns the workflow.
    pub fn agent_pubkey(&self) -> PublicKey {
        self.agent_pubkey
    }
    /// Workflow d-tag.
    pub fn workflow_id(&self) -> Uuid {
        self.workflow_id
    }
    /// Exact agent-signed workflow revision checked by the executor.
    pub fn expected_revision(&self) -> EventId {
        self.expected_revision
    }
    /// Requested lifecycle operation.
    pub fn operation(&self) -> WorkflowOwnerOperation {
        self.operation
    }
}

/// Result returned by the isolated lifecycle backend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowLifecycleOutcome {
    status: WorkflowOwnerResultStatus,
    reason: Option<String>,
}

impl WorkflowLifecycleOutcome {
    /// Report that the operation was applied.
    pub fn applied() -> Self {
        Self {
            status: WorkflowOwnerResultStatus::Applied,
            reason: None,
        }
    }

    /// Report that the operation was rejected without applying it.
    pub fn rejected(reason: impl Into<String>) -> Result<Self, WorkflowLifecycleOutcomeError> {
        let reason = reason.into();
        if reason.len() > WORKFLOW_OWNER_MAX_REASON_BYTES {
            return Err(WorkflowLifecycleOutcomeError::ReasonTooLarge);
        }
        Ok(Self {
            status: WorkflowOwnerResultStatus::Rejected,
            reason: Some(reason),
        })
    }
}

/// Invalid backend outcomes rejected before a lifecycle transition can run.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkflowLifecycleOutcomeError {
    /// Terminal context would exceed the signed protocol limit.
    #[error("workflow lifecycle outcome reason is too large")]
    ReasonTooLarge,
}

/// Isolated owner of the five workflow lifecycle transitions.
///
/// Implementations must make each command ID idempotent in durable state. The
/// executor also caches the exact signed terminal event so response loss within
/// a process lifetime replays identical bytes.
pub trait WorkflowLifecycleBackend {
    /// Apply one fully validated lifecycle request.
    fn execute(&mut self, request: &WorkflowLifecycleRequest) -> WorkflowLifecycleOutcome;
}

#[derive(Debug, Clone)]
struct CompletedCommand {
    command_event_id: EventId,
    result: Event,
}

/// Capability-gated executor that retains the agent's signing authority.
pub struct WorkflowLifecycleExecutor<B> {
    capability: WorkflowLifecycleCapability,
    keys: Keys,
    immutable_owner: PublicKey,
    backend: B,
    completed: HashMap<Uuid, CompletedCommand>,
}

impl<B: WorkflowLifecycleBackend> WorkflowLifecycleExecutor<B> {
    /// Construct a dormant executor. Callers must opt in explicitly before any
    /// backend operation can run.
    pub fn new(keys: Keys, immutable_owner: PublicKey, backend: B) -> Self {
        Self {
            capability: WorkflowLifecycleCapability::Disabled,
            keys,
            immutable_owner,
            backend,
            completed: HashMap::new(),
        }
    }

    /// Set the explicit capability state. Production wiring is intentionally
    /// outside this module and absent from this slice.
    pub fn set_capability(&mut self, capability: WorkflowLifecycleCapability) {
        self.capability = capability;
    }

    /// Validate, apply, and sign a terminal result for one owner command.
    ///
    /// `definition` must be the exact event named by the command's revision
    /// tag. Supplying a newer replaceable head is rejected rather than silently
    /// retargeting the owner's signed intent.
    pub fn execute(
        &mut self,
        command_event: &Event,
        definition: &Event,
    ) -> Result<Event, WorkflowLifecycleExecutorError> {
        if self.capability != WorkflowLifecycleCapability::Enabled {
            return Err(WorkflowLifecycleExecutorError::CapabilityDisabled);
        }
        let command = parse_owner_command(command_event)
            .map_err(WorkflowLifecycleExecutorError::InvalidCommand)?;
        self.validate_command_binding(&command, definition)?;

        if let Some(completed) = self.completed.get(&command.command_id) {
            if completed.command_event_id != command.event_id {
                return Err(WorkflowLifecycleExecutorError::ReplayConflict);
            }
            return Ok(completed.result.clone());
        }

        let request = WorkflowLifecycleRequest {
            command_id: command.command_id,
            command_event_id: command.event_id,
            owner_pubkey: command.owner_pubkey,
            agent_pubkey: command.agent_pubkey,
            workflow_id: command.workflow_id,
            expected_revision: command.expected_revision,
            operation: command.operation,
        };
        let outcome = self.backend.execute(&request);
        let builder = buzz_sdk::build_workflow_owner_result(
            command.command_id,
            &command.owner_pubkey.to_hex(),
            &command.agent_pubkey.to_hex(),
            command.workflow_id,
            &command.expected_revision.to_hex(),
            command.operation,
            outcome.status,
            outcome.reason.as_deref(),
        )
        .map_err(|error| WorkflowLifecycleExecutorError::ResultBuild(error.to_string()))?;
        // Bind the terminal event timestamp to the signed command so its event ID
        // is stable across process restarts. Schnorr signatures may still use
        // fresh auxiliary randomness; relay persistence owns exact-event replay.
        let result = builder
            .custom_created_at(command_event.created_at)
            .sign_with_keys(&self.keys)
            .map_err(|error| WorkflowLifecycleExecutorError::ResultSigning(error.to_string()))?;
        self.completed.insert(
            command.command_id,
            CompletedCommand {
                command_event_id: command.event_id,
                result: result.clone(),
            },
        );
        Ok(result)
    }

    fn validate_command_binding(
        &self,
        command: &WorkflowOwnerCommand,
        definition: &Event,
    ) -> Result<(), WorkflowLifecycleExecutorError> {
        let agent = self.keys.public_key();
        if command.owner_pubkey != self.immutable_owner {
            return Err(WorkflowLifecycleExecutorError::OwnerMismatch);
        }
        if command.agent_pubkey != agent || command.recipient != agent {
            return Err(WorkflowLifecycleExecutorError::AgentMismatch);
        }
        definition.verify().map_err(|error| {
            WorkflowLifecycleExecutorError::InvalidDefinitionSignature(error.to_string())
        })?;
        if definition.id != command.expected_revision {
            return Err(WorkflowLifecycleExecutorError::StaleRevision);
        }
        if definition.kind.as_u16() as u32 != KIND_WORKFLOW_DEF {
            return Err(WorkflowLifecycleExecutorError::WrongDefinitionKind);
        }
        if definition.pubkey != agent {
            return Err(WorkflowLifecycleExecutorError::DefinitionAuthorMismatch);
        }
        require_exact_tag(definition, "d", &command.workflow_id.to_string())?;
        require_one_canonical_tag(definition, "h")?;
        Ok(())
    }
}

fn require_exact_tag(
    event: &Event,
    name: &'static str,
    expected: &str,
) -> Result<(), WorkflowLifecycleExecutorError> {
    let value = require_one_canonical_tag(event, name)?;
    if value != expected {
        return Err(WorkflowLifecycleExecutorError::DefinitionTagMismatch(name));
    }
    Ok(())
}

fn require_one_canonical_tag<'a>(
    event: &'a Event,
    name: &'static str,
) -> Result<&'a str, WorkflowLifecycleExecutorError> {
    let matches = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|value| value == name))
        .collect::<Vec<_>>();
    if matches.len() != 1 || matches[0].as_slice().len() != 2 {
        return Err(WorkflowLifecycleExecutorError::DefinitionTagMismatch(name));
    }
    Ok(matches[0].as_slice()[1].as_str())
}

/// Fail-closed lifecycle execution errors.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkflowLifecycleExecutorError {
    /// The dormant capability has not been activated.
    #[error("workflow lifecycle executor capability is disabled")]
    CapabilityDisabled,
    /// The owner command failed its signed wire contract.
    #[error("invalid workflow lifecycle command: {0}")]
    InvalidCommand(WorkflowOwnerError),
    /// The command signer is not the agent's immutable human owner.
    #[error("workflow lifecycle command owner mismatch")]
    OwnerMismatch,
    /// The command does not target this agent exactly.
    #[error("workflow lifecycle command agent mismatch")]
    AgentMismatch,
    /// The supplied definition signature is invalid.
    #[error("invalid workflow definition signature: {0}")]
    InvalidDefinitionSignature(String),
    /// The supplied definition is not the exact signed revision requested.
    #[error("stale workflow definition revision")]
    StaleRevision,
    /// The supplied event is not a workflow definition.
    #[error("workflow lifecycle target must be kind 30620")]
    WrongDefinitionKind,
    /// The workflow definition was not signed by this agent.
    #[error("workflow definition author mismatch")]
    DefinitionAuthorMismatch,
    /// A definition identity tag was missing, duplicated, malformed, or wrong.
    #[error("workflow definition {0} tag mismatch")]
    DefinitionTagMismatch(&'static str),
    /// The same replay key was reused for a different signed command.
    #[error("workflow lifecycle command replay conflict")]
    ReplayConflict,
    /// A terminal result could not be constructed.
    #[error("workflow lifecycle result build failed: {0}")]
    ResultBuild(String),
    /// The agent could not sign its terminal result.
    #[error("workflow lifecycle result signing failed: {0}")]
    ResultSigning(String),
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use buzz_core::workflow_owner_command::{parse_owner_result, WorkflowOwnerResultStatus};
    use nostr::{EventBuilder, Kind, Tag};

    use super::*;

    #[derive(Clone, Default)]
    struct RecordingBackend {
        calls: Rc<RefCell<Vec<WorkflowLifecycleRequest>>>,
    }

    impl WorkflowLifecycleBackend for RecordingBackend {
        fn execute(&mut self, request: &WorkflowLifecycleRequest) -> WorkflowLifecycleOutcome {
            self.calls.borrow_mut().push(request.clone());
            WorkflowLifecycleOutcome::applied()
        }
    }

    fn definition(agent: &Keys, workflow_id: Uuid, channel_id: Uuid) -> Event {
        EventBuilder::new(Kind::Custom(KIND_WORKFLOW_DEF as u16), "name: managed")
            .tags([
                Tag::parse(["d", &workflow_id.to_string()]).unwrap(),
                Tag::parse(["h", &channel_id.to_string()]).unwrap(),
            ])
            .sign_with_keys(agent)
            .unwrap()
    }

    fn command(
        owner: &Keys,
        agent: &Keys,
        workflow_id: Uuid,
        revision: EventId,
        command_id: Uuid,
        operation: WorkflowOwnerOperation,
    ) -> Event {
        buzz_sdk::build_workflow_owner_command(
            command_id,
            &agent.public_key().to_hex(),
            workflow_id,
            &revision.to_hex(),
            operation,
        )
        .unwrap()
        .sign_with_keys(owner)
        .unwrap()
    }

    fn enabled_executor(
        agent: &Keys,
        owner: &Keys,
        backend: RecordingBackend,
    ) -> WorkflowLifecycleExecutor<RecordingBackend> {
        let mut executor =
            WorkflowLifecycleExecutor::new(agent.clone(), owner.public_key(), backend);
        executor.set_capability(WorkflowLifecycleCapability::Enabled);
        executor
    }

    #[test]
    fn capability_is_disabled_by_default_and_backend_is_untouched() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let workflow = Uuid::new_v4();
        let definition = definition(&agent, workflow, Uuid::new_v4());
        let command = command(
            &owner,
            &agent,
            workflow,
            definition.id,
            Uuid::new_v4(),
            WorkflowOwnerOperation::Start,
        );
        let backend = RecordingBackend::default();
        let calls = backend.calls.clone();
        let mut executor = WorkflowLifecycleExecutor::new(agent, owner.public_key(), backend);
        assert_eq!(
            executor.execute(&command, &definition),
            Err(WorkflowLifecycleExecutorError::CapabilityDisabled)
        );
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn executes_all_five_operations_through_one_uniform_path() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let workflow = Uuid::new_v4();
        let definition = definition(&agent, workflow, Uuid::new_v4());
        let backend = RecordingBackend::default();
        let calls = backend.calls.clone();
        let mut executor = enabled_executor(&agent, &owner, backend);
        for operation in [
            WorkflowOwnerOperation::Start,
            WorkflowOwnerOperation::Pause,
            WorkflowOwnerOperation::Resume,
            WorkflowOwnerOperation::Cancel,
            WorkflowOwnerOperation::Restore,
        ] {
            let command = command(
                &owner,
                &agent,
                workflow,
                definition.id,
                Uuid::new_v4(),
                operation,
            );
            let result = executor.execute(&command, &definition).unwrap();
            let parsed = parse_owner_result(&result).unwrap();
            assert_eq!(parsed.operation, operation);
            assert_eq!(parsed.status, WorkflowOwnerResultStatus::Applied);
            assert_eq!(parsed.agent_pubkey, agent.public_key());
            assert_eq!(parsed.owner_pubkey, owner.public_key());
        }
        assert_eq!(calls.borrow().len(), 5);
        assert_eq!(
            calls.borrow()[4].operation(),
            WorkflowOwnerOperation::Restore
        );
    }

    #[test]
    fn response_loss_replays_identical_signed_result_without_reexecution() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let workflow = Uuid::new_v4();
        let definition = definition(&agent, workflow, Uuid::new_v4());
        let command = command(
            &owner,
            &agent,
            workflow,
            definition.id,
            Uuid::new_v4(),
            WorkflowOwnerOperation::Restore,
        );
        let backend = RecordingBackend::default();
        let calls = backend.calls.clone();
        let mut executor = enabled_executor(&agent, &owner, backend);
        let first = executor.execute(&command, &definition).unwrap();
        let replay = executor.execute(&command, &definition).unwrap();
        assert_eq!(first, replay);
        assert_eq!(calls.borrow().len(), 1);
    }

    #[test]
    fn rejects_wrong_owner_agent_revision_and_definition_identity_before_backend() {
        let owner = Keys::generate();
        let other_owner = Keys::generate();
        let agent = Keys::generate();
        let other_agent = Keys::generate();
        let workflow = Uuid::new_v4();
        let definition = definition(&agent, workflow, Uuid::new_v4());
        let backend = RecordingBackend::default();
        let calls = backend.calls.clone();
        let mut executor = enabled_executor(&agent, &owner, backend);

        let wrong_owner = command(
            &other_owner,
            &agent,
            workflow,
            definition.id,
            Uuid::new_v4(),
            WorkflowOwnerOperation::Start,
        );
        assert_eq!(
            executor.execute(&wrong_owner, &definition),
            Err(WorkflowLifecycleExecutorError::OwnerMismatch)
        );

        let wrong_agent = command(
            &owner,
            &other_agent,
            workflow,
            definition.id,
            Uuid::new_v4(),
            WorkflowOwnerOperation::Pause,
        );
        assert_eq!(
            executor.execute(&wrong_agent, &definition),
            Err(WorkflowLifecycleExecutorError::AgentMismatch)
        );

        let stale = self::tests::definition(&agent, workflow, Uuid::new_v4());
        let resume_command = command(
            &owner,
            &agent,
            workflow,
            definition.id,
            Uuid::new_v4(),
            WorkflowOwnerOperation::Resume,
        );
        assert_eq!(
            executor.execute(&resume_command, &stale),
            Err(WorkflowLifecycleExecutorError::StaleRevision)
        );

        let wrong_workflow = self::tests::definition(&agent, Uuid::new_v4(), Uuid::new_v4());
        let command = command(
            &owner,
            &agent,
            workflow,
            wrong_workflow.id,
            Uuid::new_v4(),
            WorkflowOwnerOperation::Cancel,
        );
        assert_eq!(
            executor.execute(&command, &wrong_workflow),
            Err(WorkflowLifecycleExecutorError::DefinitionTagMismatch("d"))
        );
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn completion_event_id_is_stable_across_executor_restarts() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let workflow = Uuid::new_v4();
        let definition = definition(&agent, workflow, Uuid::new_v4());
        let command = command(
            &owner,
            &agent,
            workflow,
            definition.id,
            Uuid::new_v4(),
            WorkflowOwnerOperation::Restore,
        );
        let first = enabled_executor(&agent, &owner, RecordingBackend::default())
            .execute(&command, &definition)
            .unwrap();
        let after_restart = enabled_executor(&agent, &owner, RecordingBackend::default())
            .execute(&command, &definition)
            .unwrap();
        assert_eq!(first.id, after_restart.id);
        first.verify().unwrap();
        after_restart.verify().unwrap();
    }

    #[test]
    fn replay_key_cannot_be_rebound_to_a_different_signed_command() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let workflow = Uuid::new_v4();
        let definition = definition(&agent, workflow, Uuid::new_v4());
        let command_id = Uuid::new_v4();
        let first = command(
            &owner,
            &agent,
            workflow,
            definition.id,
            command_id,
            WorkflowOwnerOperation::Pause,
        );
        let conflict = command(
            &owner,
            &agent,
            workflow,
            definition.id,
            command_id,
            WorkflowOwnerOperation::Cancel,
        );
        let backend = RecordingBackend::default();
        let calls = backend.calls.clone();
        let mut executor = enabled_executor(&agent, &owner, backend);
        executor.execute(&first, &definition).unwrap();
        assert_eq!(
            executor.execute(&conflict, &definition),
            Err(WorkflowLifecycleExecutorError::ReplayConflict)
        );
        assert_eq!(calls.borrow().len(), 1);
    }

    #[test]
    fn oversized_backend_reason_is_rejected_before_execution() {
        let reason = "x".repeat(WORKFLOW_OWNER_MAX_REASON_BYTES + 1);
        assert_eq!(
            WorkflowLifecycleOutcome::rejected(reason),
            Err(WorkflowLifecycleOutcomeError::ReasonTooLarge)
        );
    }

    #[test]
    fn backend_rejection_is_agent_signed_and_reason_is_preserved() {
        struct Rejecting;
        impl WorkflowLifecycleBackend for Rejecting {
            fn execute(&mut self, _: &WorkflowLifecycleRequest) -> WorkflowLifecycleOutcome {
                WorkflowLifecycleOutcome::rejected("not_applicable").unwrap()
            }
        }
        let owner = Keys::generate();
        let agent = Keys::generate();
        let workflow = Uuid::new_v4();
        let definition = definition(&agent, workflow, Uuid::new_v4());
        let command = command(
            &owner,
            &agent,
            workflow,
            definition.id,
            Uuid::new_v4(),
            WorkflowOwnerOperation::Cancel,
        );
        let mut executor =
            WorkflowLifecycleExecutor::new(agent.clone(), owner.public_key(), Rejecting);
        executor.set_capability(WorkflowLifecycleCapability::Enabled);
        let result = parse_owner_result(&executor.execute(&command, &definition).unwrap()).unwrap();
        assert_eq!(result.status, WorkflowOwnerResultStatus::Rejected);
        assert_eq!(result.reason.as_deref(), Some("not_applicable"));
        assert_eq!(result.agent_pubkey, agent.public_key());
    }
}
