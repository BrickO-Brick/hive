//! buzz-agent's own agent loop, built from goose components.
//!
//! # Who owns what
//!
//! This is the deliberate inversion of the earlier design, where the turn was
//! `goose::agents::Agent::reply` and buzz-agent only translated the resulting
//! event stream onto the ACP wire. **buzz-agent owns the loop.** goose is a
//! parts bin:
//!
//! | concern | goose API used |
//! |---|---|
//! | model call | `Provider::stream` (via `Agent::provider`) |
//! | tool surface | `Agent::list_tools` |
//! | tool execution | `Agent::dispatch_tool_call` |
//! | system prompt | `Agent::build_turn_system_prompt` → `PromptManager` |
//! | compaction | `goose::context_mgmt::{check_if_compaction_needed, compact_messages}` |
//! | conversation store | buzz's own [`crate::turn_state::TurnState`], in memory |
//!
//! Everything that decides *turn shape* stays here: round structure, the
//! `_Stop` veto, `[Reflect]` on tool failure, `[PostCompact]` re-injection,
//! steer draining, cancellation semantics, and the ACP `session/update`
//! emission.
//!
//! # Why own the loop
//!
//! `Agent::reply` bakes in goose's own turn policy — its compaction trigger,
//! its stop-hook handling, its steer drain points, its max-turns rule. Every
//! buzz-specific behaviour then has to be smuggled in around the edges
//! (see the old `run_turn`: an outer loop purely to re-enter `reply()` for the
//! `_Stop` veto, and `[Reflect]` delivered as a *steer* because the tool
//! result itself was out of reach). Driving the components directly removes
//! the smuggling: the veto is a branch, `[Reflect]` is appended to the tool
//! result where buzz-agent originally put it.
//!
//! # Round structure
//!
//! One round is: build prompt+tools → stream from the provider → persist the
//! assistant message → if it asked for tools, run them, append results, and
//! loop; otherwise the turn wants to end, at which point `_Stop` may veto it.
//!
//! Compaction is checked at the top of each round rather than mid-stream, so a
//! rewrite of history can never race a partially-consumed response.

use std::sync::Arc;

use futures::StreamExt;
use tokio_util::sync::CancellationToken;

use goose::agents::Agent;
use goose::session::session_manager::Session;
use goose_provider_types::conversation::message::{Message, MessageContent, ToolRequest};
use goose_provider_types::conversation::Conversation;

use crate::types::{AgentError, StopReason};
use goose::agents::state_machine::Emitter;

use crate::wire::WireSender;

/// Appended to every failed tool result so the model diagnoses the failure
/// instead of blindly retrying it.
///
/// This is buzz-agent's original behaviour, restored. Under `Agent::reply` the
/// tool result was owned by goose and unreachable, so the text had to be
/// delivered as a steer instead; owning the loop means we can put it back on
/// the result where the model reads it in context.
const ERROR_REFLECTION: &str =
    "[Reflect] Before retrying, identify the cause and change your approach.";

/// Cap on reflections per turn, so a tool failing in a loop cannot flood the
/// conversation.
const MAX_REFLECTIONS: usize = 8;

/// Rounds allowed when the caller sets no limit.
///
/// buzz-agent's loop was previously bounded by goose's `max_turns`. Owning the
/// loop means owning the bound, and an unbounded loop against a model that
/// tool-calls forever is a runaway spend.
const DEFAULT_MAX_ROUNDS: u32 = 1000;

/// Outcome of a single round, as decided by this loop.
enum Round {
    /// The model asked for tools; they ran and their results are in history.
    Continued,
    /// The model produced a final answer.
    WantsToEnd,
    /// A terminal condition the loop must surrender to.
    Stopped(StopReason),
}

/// Everything a round needs that does not change between rounds.
pub struct TurnContext<'a> {
    pub agent: &'a Arc<Agent>,
    pub session_id: &'a str,
    pub wire_tx: &'a WireSender,
    pub cancel: &'a CancellationToken,
    pub hook_extension: Option<&'a str>,
    pub max_rounds: Option<u32>,
    /// This session's system prompt. buzz-agent owns it because goose's own
    /// `PromptManager` is only reachable from `Agent::reply`.
    pub prompt: &'a crate::prompt::SessionPrompt,
    /// Messages injected mid-turn by `session/steer`. Drained at the round
    /// boundary; a pending steer also blocks the end of the turn.
    pub steers: &'a crate::steer::SteerQueue,
    /// The session's working directory, for tool dispatch and hint tracking.
    pub working_dir: std::path::PathBuf,
    /// Conversation carried over from earlier turns in this session.
    ///
    /// buzz-agent holds this across turns itself now that the turn's
    /// conversation is in memory rather than in goose's database.
    pub history: &'a [Message],
    /// Whether the reply guard is armed for this session
    /// (`BUZZ_AGENT_REQUIRE_REPLY`). Desktop turns it on by default for
    /// shared-compute agents.
    pub require_reply: bool,
    /// Provider and model config for this turn. Read from here rather than
    /// from goose's `Agent`, which resolves the config out of its session
    /// store; see [`crate::model`].
    pub model: &'a crate::model::SessionModel,
}

/// Drive one `session/prompt` turn to completion.
///
/// Returns the ACP stop reason, the turn's token counts, and the conversation
/// as it stands at the end of the turn — the caller keeps that for the next
/// prompt, since no database does it for us. The caller emits `usage_update`
/// *before* the `session/prompt` response: that ordering is load-bearing for
/// kind-44200 metrics.
pub async fn run_turn(
    ctx: TurnContext<'_>,
    prompt: Message,
) -> (
    Result<StopReason, AgentError>,
    super::agent::TurnTokens,
    Vec<Message>,
) {
    let mut tokens = super::agent::TurnTokens::default();

    // The turn's conversation lives here, not in a database. See
    // `crate::turn_state` for why goose never needed one.
    let model_config = ctx
        .agent
        .model_config_for_session(ctx.session_id)
        .await
        .ok();
    let mut state = crate::turn_state::TurnState::new(
        ctx.session_id.to_string(),
        ctx.working_dir.clone(),
        model_config,
    );
    for message in ctx.history.iter().cloned() {
        state.push(message);
    }
    state.push(prompt);

    let max_rounds = ctx.max_rounds.unwrap_or(DEFAULT_MAX_ROUNDS);
    let mut reflections = 0usize;

    // Every loop decision is a goose `Operation` -- see
    // `PLANS/BUZZ_OPERATIONS_MIGRATION.md`. Two machines, because they run at
    // different points: `start_machine` before inference, `machine` at the
    // round gate and again when a turn wants to end.
    let outcome = crate::ops::Outcome::new();
    let machine = crate::ops::round_gate(
        max_rounds,
        outcome.clone(),
        ctx.cancel.clone(),
        ctx.hook_extension
            .map(|extension| (Arc::clone(ctx.agent), extension.to_string())),
        ctx.require_reply,
    );
    let start_machine = crate::ops::round_start(
        ctx.steers.clone(),
        crate::ops::BuzzCompactionOperation::new(
            ctx.model.clone(),
            Arc::clone(ctx.agent),
            ctx.hook_extension.map(str::to_string),
            ctx.session_id.to_string(),
        ),
        ctx.cancel.clone(),
    );
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(16);
    // Operations may emit; nothing in this step does, but a dropped receiver
    // would silently swallow events from the ones that follow.
    tokio::spawn(async move { while event_rx.recv().await.is_some() {} });
    let emitter = Emitter::new(event_tx, ctx.cancel.clone());

    loop {
        if ctx.cancel.is_cancelled() {
            return (
                Ok(StopReason::Cancelled),
                tokens,
                state.conversation().messages().to_vec(),
            );
        }

        // Ask the machine before doing any work. `step` returns the first
        // operation that applies, or `None` when the loop below should run.
        match gate(&machine, state.session(), &emitter).await {
            Gate::Ended => {
                let reason = outcome.take().unwrap_or(StopReason::EndTurn);
                return (Ok(reason), tokens, state.conversation().messages().to_vec());
            }
            Gate::Applied(effects) => {
                apply_effects(&mut state, effects);
            }
            Gate::Open => {}
        }

        // Steering and compaction, both at the round boundary and never
        // mid-inference where they would race a partially streamed response.
        // Run to exhaustion: `step` stops at the first operation that applies,
        // so a turn that both steers and compacts needs more than one pass.
        loop {
            let Gate::Applied(effects) = gate(&start_machine, state.session(), &emitter).await
            else {
                break;
            };
            if !apply_effects(&mut state, effects) {
                break;
            }
        }

        match round(&ctx, &mut state, &mut tokens, &mut reflections).await {
            Err(e) => return (Err(e), tokens, state.conversation().messages().to_vec()),
            Ok(Round::Continued) => continue,
            Ok(Round::Stopped(reason)) => {
                return (Ok(reason), tokens, state.conversation().messages().to_vec())
            }
            Ok(Round::WantsToEnd) => {
                // A steer that arrived while the model was finishing must be
                // answered, not dropped — so it also blocks the end of turn.
                if ctx.steers.is_pending().await && !ctx.cancel.is_cancelled() {
                    continue;
                }

                // The turn wants to end, so ask the machine again. This is
                // the call `BuzzStopVetoOperation` exists for: it only applies
                // to a conversation whose last message ends the turn, which is
                // true here and false at the top of a round.
                //
                // Cancellation short-circuits it -- dispatching a hook tool
                // for a turn the user already abandoned would delay the
                // cancel for no gain.
                if !ctx.cancel.is_cancelled() {
                    match gate(&machine, state.session(), &emitter).await {
                        Gate::Applied(effects) => {
                            if apply_effects(&mut state, effects) {
                                continue;
                            }
                            // Applied without changing state: the model has no
                            // new work, so the turn still ends rather than the
                            // loop spinning.
                        }
                        Gate::Ended => {
                            let reason = outcome.take().unwrap_or(StopReason::EndTurn);
                            ctx.steers.clear().await;
                            return (Ok(reason), tokens, state.conversation().messages().to_vec());
                        }
                        Gate::Open => {}
                    }
                }

                // A steer arriving after this point belongs to no run.
                ctx.steers.clear().await;
                return (
                    Ok(StopReason::EndTurn),
                    tokens,
                    state.conversation().messages().to_vec(),
                );
            }
        }
    }
}

/// What the operation gate decided.
enum Gate {
    /// No operation applied; the loop proceeds.
    Open,
    /// An operation applied; the loop continues with its effects in state
    /// rather than ending.
    Applied(Vec<goose::agents::state_machine::StateEffect>),
    /// An operation ended the turn.
    Ended,
}

/// Run the operation gate once.
///
/// Called at the top of every round, and again when a round wants to end --
/// that second call is what gives `_Stop` its veto, since its operation only
/// applies to a conversation whose last message ends the turn.
async fn gate(
    machine: &goose::agents::state_machine::StateMachine<'_>,
    session: &Session,
    emitter: &Emitter,
) -> Gate {
    match machine.step(session, emitter).await {
        Ok(Some(result)) if result.yield_to_client => Gate::Ended,
        Ok(Some(result)) => Gate::Applied(result.effects),
        Ok(None) => Gate::Open,
        // A failing gate must not take the turn down with it: the operations
        // here are guards, and a guard that errors should let the round
        // proceed rather than strand the user's prompt unanswered.
        Err(e) => {
            tracing::warn!(error = %e, "operation gate failed; continuing");
            Gate::Open
        }
    }
}

/// Apply an operation's effects to the turn's state.
///
/// buzz's operations produce two kinds: appended messages (objections,
/// reminders, steers) and a whole replaced conversation (compaction). Other
/// `StateEffect` variants belong to goose's own operations -- recipes,
/// approval, extension data -- and have no meaning in this loop, so ignoring
/// them is correct rather than lossy.
///
/// Returns whether anything was actually applied: an operation that applied
/// without changing state has given the model no new work, and treating that
/// as progress would spin the loop.
fn apply_effects(
    state: &mut crate::turn_state::TurnState,
    effects: Vec<goose::agents::state_machine::StateEffect>,
) -> bool {
    use goose::agents::state_machine::StateEffect;

    let mut changed = false;
    for effect in effects {
        match effect {
            StateEffect::AppendMessage(message) => {
                state.push(message);
                changed = true;
            }
            StateEffect::ReplaceConversation { conversation, .. } => {
                state.replace(conversation);
                // The running total described a conversation that no longer
                // exists; let goose re-estimate from the compacted messages.
                state.set_total_tokens(None);
                changed = true;
            }
            _ => {}
        }
    }
    changed
}

/// One inference plus, if the model asked for them, one batch of tool calls.
async fn round(
    ctx: &TurnContext<'_>,
    state: &mut crate::turn_state::TurnState,
    tokens: &mut super::agent::TurnTokens,
    reflections: &mut usize,
) -> Result<Round, AgentError> {
    let conversation = state.conversation();

    let assistant = match infer(ctx, state.session(), &conversation, tokens).await? {
        Some(message) => message,
        // A provider that returns nothing is not a turn we can continue.
        None => return Ok(Round::Stopped(StopReason::EndTurn)),
    };

    state.push(assistant.clone());
    // Keep the running total current: goose's compaction check prefers it
    // over re-estimating the conversation.
    // i32 because that is the width goose's `Usage` uses; a total beyond
    // i32::MAX means something has gone very wrong upstream, and saturating is
    // better than wrapping into a negative that reads as "no usage".
    state.set_total_tokens(tokens.total.map(|t| i32::try_from(t).unwrap_or(i32::MAX)));

    let requests: Vec<ToolRequest> = assistant
        .content
        .iter()
        .filter_map(|content| match content {
            MessageContent::ToolRequest(req) => Some(req.clone()),
            _ => None,
        })
        .collect();

    if requests.is_empty() {
        return Ok(Round::WantsToEnd);
    }

    if ctx.cancel.is_cancelled() {
        // Announced tool calls must still reach a terminal state or the
        // desktop renders a spinner forever.
        let results = crate::tools::cancelled_results(&requests);
        for request in &requests {
            crate::agent::emit_tool_call_update(ctx.wire_tx, ctx.session_id, &request.id, true)
                .await;
        }
        push_tool_results(state, results);
        return Ok(Round::Stopped(StopReason::Cancelled));
    }

    // Tool arguments feed goose's subdirectory-hint tracker, so the next
    // round's prompt picks up an AGENTS.md in a directory we just touched.
    for request in &requests {
        if let Ok(call) = &request.tool_call {
            ctx.prompt
                .record_tool_arguments(&call.arguments, &state.session().working_dir)
                .await;
        }
    }

    let results = crate::tools::execute(
        ctx.agent,
        state.session(),
        ctx.wire_tx,
        ctx.cancel,
        &requests,
        reflections,
    )
    .await;
    push_tool_results(state, results);

    Ok(Round::Continued)
}

/// Stream one assistant response, emitting chunks onto the ACP wire as they
/// arrive and accumulating usage.
async fn infer(
    ctx: &TurnContext<'_>,
    session: &Session,
    conversation: &Conversation,
    tokens: &mut super::agent::TurnTokens,
) -> Result<Option<Message>, AgentError> {
    let provider = ctx.model.provider().await;
    let model_config = ctx.model.config().await;

    let system_prompt = ctx.prompt.build(&session.working_dir).await;
    let tools = ctx.agent.list_tools(ctx.session_id, None).await;

    let mut stream = provider
        .stream(
            &model_config,
            &system_prompt,
            conversation.messages(),
            &tools,
        )
        .await
        .map_err(|e| classify_provider_error(&e.to_string()))?;

    let mut accumulated: Option<Message> = None;
    let mut keepalive = tokio::time::interval(crate::agent::KEEPALIVE_INTERVAL);
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    keepalive.tick().await; // first tick is immediate; discard it

    loop {
        tokio::select! {
            // Keep the harness idle clock alive during provider silence.
            _ = keepalive.tick() => {
                crate::agent::emit_keepalive(ctx.session_id, ctx.wire_tx).await;
            }

            // Cancelling the model call is safe to do abruptly: unlike tool
            // dispatch there is no child process to notify, and the partial
            // response is discarded rather than persisted.
            _ = ctx.cancel.cancelled() => {
                return Ok(accumulated);
            }

            next = stream.next() => {
                let Some(item) = next else { break };
                let (message, usage) = item.map_err(|e| classify_provider_error(&e.to_string()))?;

                if let Some(usage) = usage {
                    accumulate_usage(tokens, &usage);
                }

                let Some(chunk) = message else { continue };
                for content in &chunk.content {
                    crate::agent::emit_content(content, ctx.session_id, ctx.wire_tx).await;
                }
                accumulated = Some(match accumulated {
                    None => chunk,
                    Some(mut prev) => {
                        merge_chunk(&mut prev, chunk);
                        prev
                    }
                });
            }
        }
    }

    Ok(accumulated)
}

/// Fold a streamed chunk into the message being accumulated.
///
/// Text arrives fragmented and must be coalesced or the persisted history
/// contains one message per token; tool calls arrive whole and are appended.
fn merge_chunk(target: &mut Message, chunk: Message) {
    for content in chunk.content {
        match (target.content.last_mut(), &content) {
            (Some(MessageContent::Text(last)), MessageContent::Text(new)) => {
                last.text.push_str(&new.text);
            }
            (Some(MessageContent::Thinking(last)), MessageContent::Thinking(new)) => {
                last.thinking.push_str(&new.thinking);
            }
            _ => target.content.push(content),
        }
    }
}

fn accumulate_usage(
    tokens: &mut super::agent::TurnTokens,
    usage: &goose::providers::base::ProviderUsage,
) {
    let u = &usage.usage;
    if let Some(i) = u.input_tokens {
        tokens.input = Some(tokens.input.unwrap_or(0) + i.max(0) as u64);
    }
    if let Some(o) = u.output_tokens {
        tokens.output = Some(tokens.output.unwrap_or(0) + o.max(0) as u64);
    }
    if u.cache_read_input_tokens.is_some() || u.cache_write_input_tokens.is_some() {
        let cached = u.cache_read_input_tokens.unwrap_or(0).max(0) as u64
            + u.cache_write_input_tokens.unwrap_or(0).max(0) as u64;
        tokens.cached_input = Some(tokens.cached_input.unwrap_or(0) + cached);
    }
    if let Some(t) = u.total_tokens {
        tokens.total = Some(tokens.total.unwrap_or(0) + t.max(0) as u64);
    }
}

/// Append tool results as a single user message, matching the shape every
/// provider wire format expects (one result per outstanding request).
fn push_tool_results(
    state: &mut crate::turn_state::TurnState,
    results: Vec<(
        String,
        goose_provider_types::conversation::message::ToolResult<rmcp::model::CallToolResult>,
    )>,
) {
    if results.is_empty() {
        return;
    }
    let mut message = Message::user();
    for (id, result) in results {
        message = message.with_tool_response(id, result);
    }
    state.push(message);
}

/// Preserve buzz-agent's error taxonomy so the harness's JSON-RPC code mapping
/// stays meaningful.
fn classify_provider_error(msg: &str) -> AgentError {
    let lower = msg.to_lowercase();
    if lower.contains("auth") || lower.contains("401") {
        AgentError::LlmAuth(msg.to_string())
    } else if lower.contains("model") && lower.contains("not found") {
        AgentError::LlmModelNotFound(msg.to_string())
    } else {
        AgentError::Llm(msg.to_string())
    }
}

/// Text appended to a failed tool result, exposed for the tool module.
pub(crate) fn reflection_text() -> &'static str {
    ERROR_REFLECTION
}

pub(crate) fn max_reflections() -> usize {
    MAX_REFLECTIONS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_coalesces_consecutive_text() {
        let mut target = Message::assistant().with_text("hel");
        merge_chunk(&mut target, Message::assistant().with_text("lo"));
        assert_eq!(target.as_concat_text(), "hello");
        assert_eq!(target.content.len(), 1, "text must coalesce, not append");
    }

    #[test]
    fn merge_appends_distinct_content_kinds() {
        let mut target = Message::assistant().with_text("thinking about it");
        merge_chunk(
            &mut target,
            Message::assistant()
                .with_tool_response("id", Ok(rmcp::model::CallToolResult::success(vec![]))),
        );
        assert_eq!(target.content.len(), 2);
    }

    #[test]
    fn provider_errors_keep_buzz_agents_taxonomy() {
        assert!(matches!(
            classify_provider_error("401 Unauthorized"),
            AgentError::LlmAuth(_)
        ));
        assert!(matches!(
            classify_provider_error("model gpt-9 not found"),
            AgentError::LlmModelNotFound(_)
        ));
        assert!(matches!(
            classify_provider_error("connection reset"),
            AgentError::Llm(_)
        ));
    }
}
