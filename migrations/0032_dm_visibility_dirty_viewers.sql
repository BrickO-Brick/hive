-- Durable, bounded retry queue for relay-authored DM visibility projections.
-- The canonical channel_members mutation and this dirty marker commit together;
-- workers claim only indexed due rows instead of scanning DM membership history.
SET LOCAL lock_timeout = '5s';

CREATE TABLE dm_visibility_dirty_viewers (
    community_id   UUID        NOT NULL REFERENCES communities(id),
    viewer          BYTEA       NOT NULL CHECK (length(viewer) = 32),
    generation      BIGINT      NOT NULL DEFAULT 1 CHECK (generation > 0),
    state           TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (state IN ('pending', 'publishing')),
    dirty_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claim_id        UUID,
    lease_until     TIMESTAMPTZ,
    attempts        INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    PRIMARY KEY (community_id, viewer),
    CHECK (
        (state = 'pending' AND claim_id IS NULL AND lease_until IS NULL)
        OR (state = 'publishing' AND claim_id IS NOT NULL AND lease_until IS NOT NULL)
    )
);

CREATE INDEX dm_visibility_dirty_viewers_due
    ON dm_visibility_dirty_viewers (next_attempt_at, dirty_at, community_id, viewer)
    WHERE state = 'pending';

CREATE INDEX dm_visibility_dirty_viewers_recovery
    ON dm_visibility_dirty_viewers (lease_until, community_id, viewer)
    WHERE state = 'publishing';

SELECT attach_community_write_fence('dm_visibility_dirty_viewers');
