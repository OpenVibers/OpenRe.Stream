-- phase: expand
-- OpenVibe.OpenRe on PostgreSQL (ADR-035, roadmap WS-X2): the tables as they were on SQLite (converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint, identities keep their ids),
-- then the openvibe-publishing stores and the openvibe-sdk inbox and outbox. Generated once on 2026-09-28; never edited after it runs.
CREATE TABLE stream_definitions (
    id text COLLATE "C" PRIMARY KEY,
    owner_subject text COLLATE "C" NOT NULL,
    title text COLLATE "C" NOT NULL DEFAULT 'Untitled stream',
    description text COLLATE "C" NOT NULL DEFAULT '',
    protocols text COLLATE "C" NOT NULL DEFAULT '["rtmp"]',
    recording_mode text COLLATE "C" NOT NULL DEFAULT 'vod' CHECK (recording_mode IN ('vod', 'clips', 'none')),
    recording_visibility text COLLATE "C" NOT NULL DEFAULT 'public' CHECK (recording_visibility IN ('public', 'unlisted', 'private')),
    playback_visibility text COLLATE "C" NOT NULL DEFAULT 'public' CHECK (playback_visibility IN ('public', 'unlisted', 'private')),
    mirror_to_live bigint NOT NULL DEFAULT 0,
    state text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'archived')),
    revision bigint NOT NULL DEFAULT 1,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

CREATE TABLE external_refs (
    definition_id text COLLATE "C" NOT NULL REFERENCES stream_definitions(id) ON DELETE CASCADE,
    service text COLLATE "C" NOT NULL,
    type text COLLATE "C" NOT NULL,
    ref_id text COLLATE "C" NOT NULL,
    label text COLLATE "C",
    created_at bigint NOT NULL,
    PRIMARY KEY (definition_id, service, type, ref_id)
);

CREATE TABLE definition_lineage (
    definition_id text COLLATE "C" PRIMARY KEY REFERENCES stream_definitions(id) ON DELETE CASCADE,
    resolution text COLLATE "C" NOT NULL,
    checked_at bigint NOT NULL
);

CREATE TABLE ingest_keys (
    id text COLLATE "C" PRIMARY KEY,
    definition_id text COLLATE "C" NOT NULL REFERENCES stream_definitions(id) ON DELETE CASCADE,
    key_hash text COLLATE "C" NOT NULL UNIQUE,
    hint text COLLATE "C" NOT NULL,
    status text COLLATE "C" NOT NULL CHECK (status IN ('active', 'grace', 'revoked')),
    created_by text COLLATE "C",
    created_at bigint NOT NULL,
    grace_until bigint,
    revoked_at bigint,
    revoked_reason text COLLATE "C",
    last_used_at bigint
);

CREATE TABLE workers (
    id text COLLATE "C" PRIMARY KEY,
    kind text COLLATE "C" NOT NULL,
    generation bigint NOT NULL,
    release text COLLATE "C",
    pid bigint,
    host text COLLATE "C",
    state text COLLATE "C" NOT NULL CHECK (state IN ('starting', 'ready', 'draining', 'stopped', 'lost')),
    endpoints text COLLATE "C" NOT NULL DEFAULT '{}',
    started_at bigint NOT NULL,
    ready_at bigint,
    heartbeat_at bigint NOT NULL,
    drain_started_at bigint,
    drain_deadline bigint,
    stopped_at bigint,
    stop_reason text COLLATE "C",
    UNIQUE (kind, generation)
);

CREATE TABLE ingest_sessions (
    id text COLLATE "C" PRIMARY KEY,
    definition_id text COLLATE "C" NOT NULL REFERENCES stream_definitions(id),
    key_id text COLLATE "C",
    protocol text COLLATE "C" NOT NULL,
    state text COLLATE "C" NOT NULL CHECK (state IN ('starting', 'live', 'ending', 'ended', 'failed')),
    worker_id text COLLATE "C",
    worker_kind text COLLATE "C",
    worker_generation bigint,
    lease_expires_at bigint,
    desired_state text COLLATE "C" NOT NULL DEFAULT 'run' CHECK (desired_state IN ('run', 'end')),
    end_requested_by text COLLATE "C",
    end_reason text COLLATE "C",
    failure_reason text COLLATE "C",
    media_info text COLLATE "C",
    revision bigint NOT NULL DEFAULT 1,
    created_at bigint NOT NULL,
    live_at bigint,
    ending_at bigint,
    ended_at bigint,
    updated_at bigint NOT NULL
);

CREATE TABLE session_transitions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id text COLLATE "C" NOT NULL REFERENCES ingest_sessions(id) ON DELETE CASCADE,
    from_state text COLLATE "C",
    to_state text COLLATE "C" NOT NULL,
    reason text COLLATE "C",
    actor text COLLATE "C",
    at bigint NOT NULL
);

CREATE TABLE destinations (
    id text COLLATE "C" PRIMARY KEY,
    definition_id text COLLATE "C" NOT NULL REFERENCES stream_definitions(id) ON DELETE CASCADE,
    platform text COLLATE "C" NOT NULL CHECK (platform IN ('youtube', 'twitch', 'kick', 'custom')),
    name text COLLATE "C",
    server_url text COLLATE "C" NOT NULL,
    stream_key_enc text COLLATE "C",
    key_hint text COLLATE "C",
    srt_passphrase_enc text COLLATE "C",
    srt_latency_ms bigint,
    enabled bigint NOT NULL DEFAULT 1,
    auto_start bigint NOT NULL DEFAULT 1,
    quality_preset text COLLATE "C" NOT NULL DEFAULT 'auto',
    custom_video_bitrate bigint,
    custom_audio_bitrate bigint,
    custom_fps bigint,
    custom_encoder_preset text COLLATE "C",
    hold_reason text COLLATE "C",
    consecutive_failures bigint NOT NULL DEFAULT 0,
    cooldown_until bigint,
    last_error text COLLATE "C",
    last_failed_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

CREATE TABLE outputs (
    id text COLLATE "C" PRIMARY KEY,
    session_id text COLLATE "C" NOT NULL REFERENCES ingest_sessions(id),
    destination_id text COLLATE "C" NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
    desired text COLLATE "C" NOT NULL DEFAULT 'run' CHECK (desired IN ('run', 'stop')),
    state text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'starting', 'live', 'error', 'failed', 'stopped')),
    worker_id text COLLATE "C",
    worker_generation bigint,
    restart_attempts bigint NOT NULL DEFAULT 0,
    next_restart_at bigint,
    ever_live bigint NOT NULL DEFAULT 0,
    last_error text COLLATE "C",
    progress text COLLATE "C",
    started_at bigint,
    live_at bigint,
    ended_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    UNIQUE (session_id, destination_id)
);

CREATE TABLE output_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    output_id text COLLATE "C",
    destination_id text COLLATE "C" NOT NULL,
    level text COLLATE "C" NOT NULL CHECK (level IN ('info', 'warn', 'error')),
    message text COLLATE "C" NOT NULL,
    at bigint NOT NULL
);

CREATE TABLE recordings (
    id text COLLATE "C" PRIMARY KEY,
    session_id text COLLATE "C" NOT NULL UNIQUE REFERENCES ingest_sessions(id),
    mode text COLLATE "C" NOT NULL CHECK (mode IN ('vod', 'clips')),
    state text COLLATE "C" NOT NULL CHECK (state IN ('pending', 'requested', 'recording', 'finalizing', 'finalized', 'failed', 'cancelled')),
    media_app text COLLATE "C",
    media_vod_id text COLLATE "C",
    attempts bigint NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    last_error text COLLATE "C",
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

CREATE TABLE migration_map (
    source_system text COLLATE "C" NOT NULL,
    source_type text COLLATE "C" NOT NULL,
    source_id text COLLATE "C" NOT NULL,
    target_type text COLLATE "C",
    target_id text COLLATE "C",
    status text COLLATE "C" NOT NULL CHECK (status IN ('imported', 'held', 'excluded')),
    reason text COLLATE "C",
    imported_at bigint NOT NULL,
    PRIMARY KEY (source_system, source_type, source_id)
);

CREATE TABLE leases (
    name text COLLATE "C" PRIMARY KEY,
    holder text COLLATE "C" NOT NULL,
    expires_at bigint NOT NULL
);

CREATE INDEX idx_definitions_owner ON stream_definitions(owner_subject, state);
CREATE INDEX idx_external_refs_ref ON external_refs(service, type, ref_id);
CREATE INDEX idx_ingest_keys_definition ON ingest_keys(definition_id, status);
CREATE INDEX idx_workers_kind_state ON workers(kind, state, generation);
CREATE INDEX idx_sessions_definition ON ingest_sessions(definition_id, created_at);
CREATE INDEX idx_sessions_state ON ingest_sessions(state);
CREATE INDEX idx_sessions_worker ON ingest_sessions(worker_id, state);
CREATE INDEX idx_transitions_session ON session_transitions(session_id, id);
CREATE INDEX idx_destinations_definition ON destinations(definition_id);
CREATE INDEX idx_outputs_worker ON outputs(worker_id, state);
CREATE INDEX idx_outputs_session ON outputs(session_id);
CREATE INDEX idx_output_logs_output ON output_logs(output_id, id);
CREATE INDEX idx_output_logs_destination ON output_logs(destination_id, id);
CREATE INDEX idx_recordings_state ON recordings(state, next_attempt_at);

-- openvibe-sdk/events PostgreSQL outbox
CREATE TABLE IF NOT EXISTS event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;
