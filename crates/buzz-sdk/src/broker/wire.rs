//! The strict wire form of a [`BrokerResponse`].
//!
//! Split from [`super`] to keep that file within the repo's 1,000-line ceiling.
//! This is the response side's only reader, so it is the one place the envelope's
//! strictness is defined.

use serde::Deserialize;

use super::{absent_or_valued, ActionOutcome, BrokerError, BrokerResponse, BrokerResult};

/// The strict wire form of a [`BrokerResponse`]: every key spelled out, no
/// `flatten`, so `deny_unknown_fields` is actually in force.
///
/// The status-specific members are `Option` here only because one struct has to
/// describe three shapes; [`BrokerResponse::deserialize`] then requires the exact
/// set for the declared status, so `error` beside a succeeded outcome — or a
/// missing `outcome` under `succeeded` — is a parse failure rather than a field
/// nobody reads.
///
/// Those members deserialize through [`absent_or_valued`] rather than plain
/// `#[serde(default)]`, because the status match below reads `None` as *absent*
/// and `#[serde(default)] Option<T>` also produces `None` for an explicit
/// `null`. Without it, `{"status":"failed","action":null,"outcome":null}` — or a
/// succeeded response with `"error":null` — parsed as well-formed and skipped the
/// contradiction check entirely. `null` is now rejected for these members whether
/// or not the declared status admits them, so there is exactly one way for a
/// member to be absent.
///
/// `outcome` is held as a `serde_json::Value` and re-deserialized under its
/// action tag, so this reader is JSON-specific. That is not a narrowing: the HTTP
/// binding in [`client`] declares `application/json`, and JSON is the only
/// encoding this contract has ever specified.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireResponse {
    r#type: String,
    protocol_version: u16,
    request_id: String,
    status: String,
    #[serde(default, deserialize_with = "absent_or_valued")]
    action: Option<String>,
    #[serde(default, deserialize_with = "absent_or_valued")]
    outcome: Option<Box<serde_json::value::RawValue>>,
    #[serde(default, deserialize_with = "absent_or_valued")]
    error: Option<BrokerError>,
    #[serde(default)]
    replayed: bool,
}

impl<'de> Deserialize<'de> for BrokerResponse {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::Error as _;

        let wire = WireResponse::deserialize(deserializer)?;

        // One arm per status, each naming the members that status may carry.
        // Anything present that this status does not admit is rejected here, so
        // "succeeded with an error" cannot be parsed and then ignored.
        let result = match wire.status.as_str() {
            "succeeded" => {
                if wire.error.is_some() {
                    return Err(D::Error::custom(
                        "a succeeded response must not carry an error",
                    ));
                }
                let action = wire
                    .action
                    .ok_or_else(|| D::Error::missing_field("action"))?;
                let outcome = wire
                    .outcome
                    .ok_or_else(|| D::Error::missing_field("outcome"))?;
                // Re-deserialize the outcome under its action tag, which is how
                // the adjacently-tagged `ActionOutcome` — and the
                // `deny_unknown_fields` on each outcome type — get applied.
                // Re-deserialize from the original bytes, not from a
                // `serde_json::Value`: buffering through `Value` collapses
                // duplicate keys last-wins, which would let `outcome` carry a
                // duplicate that no other part of this contract accepts.
                let tagged = format!(
                    "{{\"action\":{},\"outcome\":{}}}",
                    serde_json::to_string(&action).map_err(D::Error::custom)?,
                    outcome.get()
                );
                let outcome: ActionOutcome =
                    serde_json::from_str(&tagged).map_err(D::Error::custom)?;
                BrokerResult::Succeeded { outcome }
            }
            status @ ("failed" | "indeterminate") => {
                if wire.action.is_some() || wire.outcome.is_some() {
                    return Err(D::Error::custom(format!(
                        "a {status} response must not carry an action or outcome"
                    )));
                }
                let error = wire.error.ok_or_else(|| D::Error::missing_field("error"))?;
                if status == "failed" {
                    BrokerResult::Failed { error }
                } else {
                    BrokerResult::Indeterminate { error }
                }
            }
            other => {
                return Err(D::Error::custom(format!(
                    "unknown broker result status \"{other}\""
                )))
            }
        };

        Ok(Self {
            r#type: wire.r#type,
            protocol_version: wire.protocol_version,
            request_id: wire.request_id,
            result,
            replayed: wire.replayed,
        })
    }
}
