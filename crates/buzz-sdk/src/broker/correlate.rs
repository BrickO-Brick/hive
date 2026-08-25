//! Response-to-request identity correlation.
//!
//! Split from [`super`] to keep that file within the repo's 1,000-line
//! ceiling; the rule it implements is part of response validation.

use super::{ActionArgs, ActionOutcome, AgentTarget, PubkeyHex, SdkError};

/// Reject an outcome that echoes back a different identity than the request
/// supplied.
///
/// The table of what is and is not compared, with the reasoning for each, is on
/// [`BrokerResponse::validate_for`][super::BrokerResponse::validate_for] — the
/// public entry point a host author reads. It is documented there rather than
/// here so there is one copy to keep true.
///
/// The match below is exhaustive over [`ActionArgs`], so adding an action is a
/// compile error here rather than a silent default to "not compared".
pub(super) fn correlate_identities(
    args: &ActionArgs,
    outcome: &ActionOutcome,
) -> Result<(), SdkError> {
    /// Compare one echoed identity, naming the field in the error.
    fn same(field: &str, requested: &str, returned: &str) -> Result<(), SdkError> {
        if requested == returned {
            return Ok(());
        }
        Err(SdkError::InvalidInput(format!(
            "response {field} \"{returned}\" does not match the requested \"{requested}\""
        )))
    }

    /// The pubkey a target names immutably, if it names one.
    fn targeted(target: &AgentTarget) -> Option<&PubkeyHex> {
        match target {
            AgentTarget::Pubkey(pubkey) => Some(pubkey),
            AgentTarget::Name(_) => None,
        }
    }

    match (args, outcome) {
        (ActionArgs::AgentsCreate(args), ActionOutcome::AgentsCreate(outcome)) => {
            same("channelId", &args.channel_id, &outcome.channel_id)
        }
        (ActionArgs::AgentsUpdate(args), ActionOutcome::AgentsUpdate(outcome)) => {
            match targeted(&args.target) {
                Some(requested) => same(
                    "agentPubkey",
                    requested.as_str(),
                    outcome.agent_pubkey.as_str(),
                ),
                None => Ok(()),
            }
        }
        (ActionArgs::AgentsDelete(args), ActionOutcome::AgentsDelete(outcome)) => {
            match targeted(&args.target) {
                Some(requested) => same(
                    "agentPubkey",
                    requested.as_str(),
                    outcome.agent_pubkey.as_str(),
                ),
                None => Ok(()),
            }
        }
        // These outcomes echo no identity the request supplied; see the table.
        (ActionArgs::ChannelRead(_), _)
        | (ActionArgs::MessagePost(_), _)
        | (ActionArgs::MessageReply(_), _)
        | (ActionArgs::ReactionAdd(_), _)
        | (ActionArgs::ProfileSet(_), _)
        | (ActionArgs::StorageAddress(_), _)
        | (ActionArgs::AgentsCreate(_), _)
        | (ActionArgs::AgentsUpdate(_), _)
        | (ActionArgs::AgentsDelete(_), _) => Ok(()),
    }
}
