//! App-level interaction norms injected unconditionally into every agent's
//! standing context, on both delivery paths (`session/new` system role for
//! protocol-v2 agents, first-user-message [`StandingContext`] for legacy
//! agents). Unlike the base prompt (replaceable via
//! `BUZZ_ACP_BASE_PROMPT_FILE`, removable via `BUZZ_ACP_NO_BASE_PROMPT`) or
//! the persona (author-controlled), this block has no off switch: it encodes
//! Buzz-the-platform's defaults, not any operator's or author's preferences.
//!
//! Precedence is deliberate: these are defaults, so anything a person states
//! — in the moment, in a persona, or in team instructions — wins. The wording
//! says so explicitly, and both delivery paths place this block before all
//! other standing content so that content reads as the override, not the
//! other way around.
//!
//! Kept tiny. Every norm added here taxes every session of every agent, so
//! entries must be cross-cutting behavioral defaults that cannot live
//! anywhere more targeted (the base prompt, a persona, a skill).

/// The `[Defaults]` section leading every agent's standing context.
///
/// The second bullet exists because Buzz agents have persistent memory
/// (`core` engrams) shared across all sessions of an agent: one session
/// recording a guessed gender poisons every future session, and the
/// mis-gendering outlives the conversation where it happened. Same-turn
/// correction matches the existing "evict completed work the same turn"
/// memory discipline in the base prompt.
pub(crate) const INTERACTION_NORMS_PREAMBLE: &str = "[Defaults]\n\
- Never assume anyone's gender — the user, channel members, people mentioned, or other agents. Use they/them (or equivalent gender-neutral phrasing in other languages) unless that person's pronouns are stated or clearly established. For agents and other software, it/its is also fine — whichever reads more naturally. This is a default: pronouns someone states always win.\n\
- Record a person's pronouns in memory only when they are stated or clearly established — never a guess. If someone states pronouns that contradict your stored memory, correct the memory the same turn.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preamble_is_framed_as_an_overridable_default() {
        assert!(INTERACTION_NORMS_PREAMBLE.starts_with("[Defaults]\n"));
        assert!(INTERACTION_NORMS_PREAMBLE.contains("Never assume anyone's gender"));
        assert!(INTERACTION_NORMS_PREAMBLE.contains("they/them"));
        assert!(INTERACTION_NORMS_PREAMBLE.contains("pronouns someone states always win"));
    }

    #[test]
    fn preamble_covers_persistent_memory() {
        // Buzz-specific: core memory is shared across sessions, so a guessed
        // gender recorded once would be re-asserted everywhere, forever.
        assert!(INTERACTION_NORMS_PREAMBLE.contains("never a guess"));
        assert!(INTERACTION_NORMS_PREAMBLE.contains("correct the memory the same turn"));
    }
}
