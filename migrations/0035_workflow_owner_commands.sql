-- Durable, private state for owner-signed managed-workflow commands.
CREATE TYPE workflow_owner_command_status AS ENUM ('pending', 'applied', 'rejected');

CREATE TABLE workflow_owner_commands (
    community_id UUID NOT NULL REFERENCES communities(id),
    command_id UUID NOT NULL,
    command_sequence BIGSERIAL NOT NULL,
    event_id BYTEA NOT NULL CHECK (length(event_id) = 32),
    owner_pubkey BYTEA NOT NULL CHECK (length(owner_pubkey) = 32),
    agent_pubkey BYTEA NOT NULL CHECK (length(agent_pubkey) = 32),
    workflow_id UUID NOT NULL,
    expected_revision BYTEA NOT NULL CHECK (length(expected_revision) = 32),
    operation TEXT NOT NULL CHECK (operation IN ('start', 'pause', 'resume', 'cancel', 'restore')),
    status workflow_owner_command_status NOT NULL DEFAULT 'pending',
    result_event_id BYTEA CHECK (result_event_id IS NULL OR length(result_event_id) = 32),
    result_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (community_id, command_id),
    UNIQUE (community_id, event_id),
    FOREIGN KEY (community_id, workflow_id) REFERENCES workflows (community_id, id) ON DELETE CASCADE,
    CHECK ((status = 'pending') = (result_event_id IS NULL)),
    CHECK ((status = 'pending') = (completed_at IS NULL))
);

CREATE UNIQUE INDEX workflow_owner_commands_result_event_idx
    ON workflow_owner_commands (community_id, result_event_id)
    WHERE result_event_id IS NOT NULL;
CREATE INDEX workflow_owner_commands_agent_pending_idx
    ON workflow_owner_commands (community_id, agent_pubkey, command_sequence)
    WHERE status = 'pending';
CREATE UNIQUE INDEX workflow_owner_commands_workflow_pending_idx
    ON workflow_owner_commands (community_id, workflow_id)
    WHERE status = 'pending';

SELECT attach_community_write_fence('workflow_owner_commands');
