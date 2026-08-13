use nostr::Event;
use serde::Deserialize;

use crate::models::{ThreadCursor, ThreadRepliesResponse};

#[derive(Deserialize)]
struct BoundsCursor {
    created_at: i64,
    id: String,
}

#[derive(Deserialize)]
struct BoundsPayload {
    has_more: bool,
    next_cursor: Option<BoundsCursor>,
}

pub(super) fn parse(
    events: Vec<Event>,
    root_event_id: &str,
) -> Result<ThreadRepliesResponse, String> {
    let mut replies = Vec::new();
    let mut bounds = None;
    for event in events {
        if event.kind.as_u16() as u32 == buzz_core_pkg::kind::KIND_THREAD_BOUNDS {
            if bounds.is_some() {
                return Err("Thread response contained multiple bounds overlays".to_string());
            }
            let matches_root = event.tags.iter().any(|tag| {
                let values = tag.as_slice();
                values.first().map(String::as_str) == Some("e")
                    && values.get(1).map(String::as_str) == Some(root_event_id)
            });
            if !matches_root {
                return Err("Thread bounds overlay does not match the requested root".to_string());
            }
            bounds = Some(
                serde_json::from_str::<BoundsPayload>(&event.content)
                    .map_err(|error| format!("Invalid thread bounds overlay: {error}"))?,
            );
        } else if let Ok(value) = serde_json::to_value(&event) {
            replies.push(value);
        }
    }
    let bounds = bounds.ok_or_else(|| "Thread response omitted its bounds overlay".to_string())?;
    let next_cursor = bounds.next_cursor.map(|cursor| ThreadCursor {
        created_at: cursor.created_at,
        event_id: cursor.id,
    });
    if bounds.has_more != next_cursor.is_some() {
        return Err("Thread bounds has_more and next_cursor disagree".to_string());
    }
    Ok(ThreadRepliesResponse {
        events: replies,
        has_more: bounds.has_more,
        next_cursor,
    })
}
