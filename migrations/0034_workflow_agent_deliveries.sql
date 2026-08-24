-- Durable, target-scoped inbox for workflow messages addressed to managed agents.
CREATE TYPE workflow_agent_delivery_status AS ENUM ('pending', 'claimed');

CREATE TABLE workflow_agent_deliveries (
    community_id UUID NOT NULL REFERENCES communities(id),
    id UUID NOT NULL,
    workflow_id UUID NOT NULL,
    run_id UUID NOT NULL,
    step_id VARCHAR(64) NOT NULL,
    definition_event_id BYTEA NOT NULL CHECK (octet_length(definition_event_id) = 32),
    message_event_id BYTEA NOT NULL CHECK (octet_length(message_event_id) = 32),
    message_event_created_at TIMESTAMPTZ NOT NULL,
    channel_id UUID NOT NULL,
    target_pubkey BYTEA NOT NULL CHECK (octet_length(target_pubkey) = 32),
    status workflow_agent_delivery_status NOT NULL DEFAULT 'pending',
    claim_token UUID,
    claimed_at TIMESTAMPTZ,
    execution_trace JSONB NOT NULL,
    trigger_context JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, id),
    UNIQUE (community_id, run_id, step_id, target_pubkey),
    FOREIGN KEY (community_id, workflow_id) REFERENCES workflows (community_id, id) ON DELETE CASCADE,
    FOREIGN KEY (community_id, run_id) REFERENCES workflow_runs (community_id, id) ON DELETE CASCADE,
    FOREIGN KEY (community_id, message_event_created_at, message_event_id)
        REFERENCES events (community_id, created_at, id) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_agent_deliveries_pending
    ON workflow_agent_deliveries (community_id, target_pubkey, created_at)
    WHERE status = 'pending';

SELECT attach_community_write_fence('workflow_agent_deliveries');
