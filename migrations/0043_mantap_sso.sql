-- OneBrick Mantap SSO bindings and durable one-time-ticket consumption.

CREATE TABLE mantap_sso_bindings (
    community_id UUID NOT NULL REFERENCES communities(id),
    subject TEXT NOT NULL,
    email TEXT NOT NULL,
    pubkey BYTEA NOT NULL CHECK (octet_length(pubkey) = 32),
    access TEXT NOT NULL CHECK (access IN ('reader', 'editor', 'admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    last_verified_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (community_id, subject, pubkey),
    UNIQUE (community_id, pubkey)
);

CREATE INDEX idx_mantap_sso_bindings_email
    ON mantap_sso_bindings (community_id, lower(email));

CREATE TABLE mantap_sso_ticket_uses (
    community_id UUID NOT NULL REFERENCES communities(id),
    jti TEXT NOT NULL,
    subject TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (community_id, jti)
);

CREATE INDEX idx_mantap_sso_ticket_uses_expiry
    ON mantap_sso_ticket_uses (expires_at);

SELECT attach_community_write_fence('mantap_sso_bindings');
SELECT attach_community_write_fence('mantap_sso_ticket_uses');
