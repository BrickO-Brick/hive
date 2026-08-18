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
/// The first bullet names the inference vectors (name, avatar, persona theme,
/// writing style) rather than only stating the rule, because that is the
/// observed failure: an agent reads a display name whose connotation feels
/// gendered and writes from that with no source. Naming the vector is what
/// makes the norm bite. It deliberately does not ask the agent to announce
/// that it is defaulting — in a channel that would draw attention to a
/// teammate's unstated identity, which is worse than the quiet correct
/// default.
///
/// The second bullet exists because Buzz agents have persistent memory
/// (`core` engrams) shared across all sessions of an agent: one session
/// recording a guessed gender poisons every future session, and the
/// mis-gendering outlives the conversation where it happened. Same-turn
/// correction matches the existing "evict completed work the same turn"
/// memory discipline in the base prompt.
pub(crate) const INTERACTION_NORMS_PREAMBLE: &str = "[Defaults]\n\
- Never infer anyone's gender or pronouns — the user, channel members, people mentioned, or other agents — from a name, avatar, persona theme, or writing style. Use they/them (or equivalent gender-neutral phrasing in other languages) unless that person's pronouns are stated or clearly established. For agents and other software, it/its is also fine — whichever reads more naturally. This is a default: pronouns someone states always win.\n\
- Record a person's pronouns in memory only when they are stated or clearly established — never a guess. If someone states pronouns that contradict your stored memory, correct the memory the same turn.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preamble_is_framed_as_an_overridable_default() {
        assert!(INTERACTION_NORMS_PREAMBLE.starts_with("[Defaults]\n"));
        assert!(INTERACTION_NORMS_PREAMBLE.contains("Never infer anyone's gender"));
        assert!(INTERACTION_NORMS_PREAMBLE.contains("they/them"));
        assert!(INTERACTION_NORMS_PREAMBLE.contains("pronouns someone states always win"));
    }

    #[test]
    fn preamble_names_the_inference_vectors() {
        // Stating the rule alone left the observed failure open: gender read
        // off a display name's connotation. The vectors must be explicit.
        for vector in ["name", "avatar", "persona theme", "writing style"] {
            assert!(
                INTERACTION_NORMS_PREAMBLE.contains(vector),
                "missing inference vector: {vector}"
            );
        }
    }

    #[test]
    fn preamble_does_not_ask_agents_to_announce_the_default() {
        // Announcing "you didn't state pronouns" in a channel spotlights a
        // teammate's unstated identity. The default stays quiet.
        let lowered = INTERACTION_NORMS_PREAMBLE.to_lowercase();
        for phrase in [
            "say so",
            "note that you",
            "explain that you",
            "tell them you",
        ] {
            assert!(
                !lowered.contains(phrase),
                "preamble must not ask agents to announce the default: {phrase}"
            );
        }
    }

    #[test]
    fn preamble_covers_persistent_memory() {
        // Buzz-specific: core memory is shared across sessions, so a guessed
        // gender recorded once would be re-asserted everywhere, forever.
        assert!(INTERACTION_NORMS_PREAMBLE.contains("never a guess"));
        assert!(INTERACTION_NORMS_PREAMBLE.contains("correct the memory the same turn"));
    }
}
