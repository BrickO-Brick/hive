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
/// # Identities are compared parsed, never as strings
///
/// Both identities in this contract have more than one legal spelling: a UUID
/// may be uppercase, unhyphenated, braced, or `urn:uuid:`-prefixed, and hex may
/// be either case. A byte comparison would therefore reject a *correct* answer
/// whenever the caller and the host spelled the same identity differently —
/// which is a worse failure than the one this function exists to catch, because
/// it makes a working host unusable.
///
/// Canonicalization at the validators and at the wire doors (see
/// [`channel_id`][super::actions::channel_id]) means both sides normally arrive
/// canonical already. This function does not rely on that: it parses each side
/// into the identity's own type and compares those, so a spelling variant that
/// reached here by any route still correlates. The two guards are deliberately
/// independent — neither is load-bearing alone.
///
/// The match below is exhaustive over [`ActionArgs`], so adding an action is a
/// compile error here rather than a silent default to "not compared".
pub(super) fn correlate_identities(
    args: &ActionArgs,
    outcome: &ActionOutcome,
) -> Result<(), SdkError> {
    /// Compare two channel ids as UUIDs, so two spellings of one channel match.
    ///
    /// An unparseable id on either side is a mismatch rather than an error:
    /// `validate`/`validated` already reject a malformed channel id with a
    /// precise message, and duplicating that verdict here would report a
    /// correlation failure for what is really a malformed payload.
    fn same_channel(requested: &str, returned: &str) -> Result<(), SdkError> {
        let parse = |value: &str| uuid::Uuid::parse_str(value).ok();
        match (parse(requested), parse(returned)) {
            (Some(requested_id), Some(returned_id)) if requested_id == returned_id => Ok(()),
            _ => Err(mismatch("channelId", requested, returned)),
        }
    }

    /// Compare two pubkeys.
    ///
    /// [`PubkeyHex`] lowercases in [`PubkeyHex::parse`], which is its only
    /// constructor and also its `Deserialize` path, so a value of this type is
    /// already canonical however it was built. Comparing the typed values is
    /// therefore the parsed comparison, not a string one.
    fn same_pubkey(requested: &PubkeyHex, returned: &PubkeyHex) -> Result<(), SdkError> {
        if requested == returned {
            return Ok(());
        }
        Err(mismatch(
            "agentPubkey",
            requested.as_str(),
            returned.as_str(),
        ))
    }

    /// The error every mismatch reports, naming the field and both spellings.
    fn mismatch(field: &str, requested: &str, returned: &str) -> SdkError {
        SdkError::InvalidInput(format!(
            "response {field} \"{returned}\" does not match the requested \"{requested}\""
        ))
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
            same_channel(&args.channel_id, &outcome.channel_id)
        }
        (ActionArgs::AgentsUpdate(args), ActionOutcome::AgentsUpdate(outcome)) => {
            match targeted(&args.target) {
                Some(requested) => same_pubkey(requested, &outcome.agent_pubkey),
                None => Ok(()),
            }
        }
        (ActionArgs::AgentsDelete(args), ActionOutcome::AgentsDelete(outcome)) => {
            match targeted(&args.target) {
                Some(requested) => same_pubkey(requested, &outcome.agent_pubkey),
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
