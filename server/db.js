'use strict';
/**
 * OpenRe's durable store: one SQLite database (WAL) shared by every OpenRe process.
 *
 *   openre-api                  definitions, keys, destinations (owner writes)
 *   openre-session-coordinator  worker liveness, drain, output assignment, recordings, event relay
 *   openre-rtmp-ingest          sessions it admits, their leases and transitions
 *   openre-restream-worker      output state, health and logs
 *
 * ADR-007: SQLite stays the documented store while the platform is single-host. Several writer
 * processes is the exact trigger ADR-007 names for moving to PostgreSQL; every statement lives
 * behind server/store/* so that move changes one layer. WAL + busy_timeout keeps the writers
 * safe today (each write is one short transaction).
 *
 * Every table is created idempotently on open. Times are epoch milliseconds.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stream_definitions (
    id                   TEXT PRIMARY KEY,
    owner_subject        TEXT NOT NULL,
    title                TEXT NOT NULL DEFAULT 'Untitled stream',
    description          TEXT NOT NULL DEFAULT '',
    protocols            TEXT NOT NULL DEFAULT '["rtmp"]',
    recording_mode       TEXT NOT NULL DEFAULT 'vod' CHECK (recording_mode IN ('vod', 'clips', 'none')),
    recording_visibility TEXT NOT NULL DEFAULT 'public' CHECK (recording_visibility IN ('public', 'unlisted', 'private')),
    playback_visibility  TEXT NOT NULL DEFAULT 'public' CHECK (playback_visibility IN ('public', 'unlisted', 'private')),
    mirror_to_live       INTEGER NOT NULL DEFAULT 0,
    state                TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'archived')),
    revision             INTEGER NOT NULL DEFAULT 1,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_definitions_owner ON stream_definitions(owner_subject, state);

-- Typed references to other services' entities (plan §29.3): never a foreign key into them.
-- A reference to a stream-like entity (e.g. live:managed_stream) belongs to one definition; owner
-- references (live:user, live:channel) may repeat across a person's definitions.
CREATE TABLE IF NOT EXISTS external_refs (
    definition_id TEXT NOT NULL REFERENCES stream_definitions(id) ON DELETE CASCADE,
    service       TEXT NOT NULL,
    type          TEXT NOT NULL,
    ref_id        TEXT NOT NULL,
    label         TEXT,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (definition_id, service, type, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_external_refs_ref ON external_refs(service, type, ref_id);

-- Ingest keys are stored as SHA-256 of a 256-bit random secret; the secret is shown once.
CREATE TABLE IF NOT EXISTS ingest_keys (
    id             TEXT PRIMARY KEY,
    definition_id  TEXT NOT NULL REFERENCES stream_definitions(id) ON DELETE CASCADE,
    key_hash       TEXT NOT NULL UNIQUE,
    hint           TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('active', 'grace', 'revoked')),
    created_by     TEXT,
    created_at     INTEGER NOT NULL,
    grace_until    INTEGER,
    revoked_at     INTEGER,
    revoked_reason TEXT,
    last_used_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ingest_keys_definition ON ingest_keys(definition_id, status);

CREATE TABLE IF NOT EXISTS workers (
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL,
    generation       INTEGER NOT NULL,
    release          TEXT,
    pid              INTEGER,
    host             TEXT,
    state            TEXT NOT NULL CHECK (state IN ('starting', 'ready', 'draining', 'stopped', 'lost')),
    endpoints        TEXT NOT NULL DEFAULT '{}',
    started_at       INTEGER NOT NULL,
    ready_at         INTEGER,
    heartbeat_at     INTEGER NOT NULL,
    drain_started_at INTEGER,
    drain_deadline   INTEGER,
    stopped_at       INTEGER,
    stop_reason      TEXT,
    UNIQUE (kind, generation)
);
CREATE INDEX IF NOT EXISTS idx_workers_kind_state ON workers(kind, state, generation);

CREATE TABLE IF NOT EXISTS ingest_sessions (
    id                TEXT PRIMARY KEY,
    definition_id     TEXT NOT NULL REFERENCES stream_definitions(id),
    key_id            TEXT,
    protocol          TEXT NOT NULL,
    state             TEXT NOT NULL CHECK (state IN ('starting', 'live', 'ending', 'ended', 'failed')),
    worker_id         TEXT,
    worker_kind       TEXT,
    worker_generation INTEGER,
    lease_expires_at  INTEGER,
    desired_state     TEXT NOT NULL DEFAULT 'run' CHECK (desired_state IN ('run', 'end')),
    end_requested_by  TEXT,
    end_reason        TEXT,
    failure_reason    TEXT,
    media_info        TEXT,
    revision          INTEGER NOT NULL DEFAULT 1,
    created_at        INTEGER NOT NULL,
    live_at           INTEGER,
    ending_at         INTEGER,
    ended_at          INTEGER,
    updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_definition ON ingest_sessions(definition_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_state ON ingest_sessions(state);
CREATE INDEX IF NOT EXISTS idx_sessions_worker ON ingest_sessions(worker_id, state);

CREATE TABLE IF NOT EXISTS session_transitions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES ingest_sessions(id) ON DELETE CASCADE,
    from_state TEXT,
    to_state   TEXT NOT NULL,
    reason     TEXT,
    actor      TEXT,
    at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transitions_session ON session_transitions(session_id, id);

CREATE TABLE IF NOT EXISTS destinations (
    id                     TEXT PRIMARY KEY,
    definition_id          TEXT NOT NULL REFERENCES stream_definitions(id) ON DELETE CASCADE,
    platform               TEXT NOT NULL CHECK (platform IN ('youtube', 'twitch', 'kick', 'custom')),
    name                   TEXT,
    server_url             TEXT NOT NULL,
    stream_key_enc         TEXT,
    key_hint               TEXT,
    srt_passphrase_enc     TEXT,
    srt_latency_ms         INTEGER,
    enabled                INTEGER NOT NULL DEFAULT 1,
    auto_start             INTEGER NOT NULL DEFAULT 1,
    quality_preset         TEXT NOT NULL DEFAULT 'auto',
    custom_video_bitrate   INTEGER,
    custom_audio_bitrate   INTEGER,
    custom_fps             INTEGER,
    custom_encoder_preset  TEXT,
    hold_reason            TEXT,
    consecutive_failures   INTEGER NOT NULL DEFAULT 0,
    cooldown_until         INTEGER,
    last_error             TEXT,
    last_failed_at         INTEGER,
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_destinations_definition ON destinations(definition_id);

-- One run of one destination inside one session. A destination failure only ever touches its
-- own row: nothing here can move the source session's state.
CREATE TABLE IF NOT EXISTS outputs (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES ingest_sessions(id),
    destination_id    TEXT NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
    desired           TEXT NOT NULL DEFAULT 'run' CHECK (desired IN ('run', 'stop')),
    state             TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'starting', 'live', 'error', 'failed', 'stopped')),
    worker_id         TEXT,
    worker_generation INTEGER,
    restart_attempts  INTEGER NOT NULL DEFAULT 0,
    next_restart_at   INTEGER,
    ever_live         INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    progress          TEXT,
    started_at        INTEGER,
    live_at           INTEGER,
    ended_at          INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE (session_id, destination_id)
);
CREATE INDEX IF NOT EXISTS idx_outputs_worker ON outputs(worker_id, state);
CREATE INDEX IF NOT EXISTS idx_outputs_session ON outputs(session_id);

-- Bounded per output (config.outputs.logsPerOutput); destination tests log with output_id NULL.
CREATE TABLE IF NOT EXISTS output_logs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    output_id      TEXT,
    destination_id TEXT NOT NULL,
    level          TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
    message        TEXT NOT NULL,
    at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_output_logs_output ON output_logs(output_id, id);
CREATE INDEX IF NOT EXISTS idx_output_logs_destination ON output_logs(destination_id, id);

-- Recording requests to OpenVibe.Media. Media records and finalises; OpenRe only asks.
CREATE TABLE IF NOT EXISTS recordings (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL UNIQUE REFERENCES ingest_sessions(id),
    mode            TEXT NOT NULL CHECK (mode IN ('vod', 'clips')),
    state           TEXT NOT NULL CHECK (state IN ('pending', 'requested', 'recording', 'finalizing', 'finalized', 'failed', 'cancelled')),
    media_app       TEXT,
    media_vod_id    TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recordings_state ON recordings(state, next_attempt_at);

-- Every imported (or deliberately not imported) source record: plan §8.1 "never silently dropped".
CREATE TABLE IF NOT EXISTS migration_map (
    source_system TEXT NOT NULL,
    source_type   TEXT NOT NULL,
    source_id     TEXT NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    status        TEXT NOT NULL CHECK (status IN ('imported', 'held', 'excluded')),
    reason        TEXT,
    imported_at   INTEGER NOT NULL,
    PRIMARY KEY (source_system, source_type, source_id)
);

-- Named leases (one session coordinator at a time).
CREATE TABLE IF NOT EXISTS leases (
    name       TEXT PRIMARY KEY,
    holder     TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
`;

function openDb(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    // busy_timeout first: several OpenRe processes open the database at the same time on boot,
    // and every statement after this one (the WAL switch, the schema) may have to wait for a lock.
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.exec(SCHEMA);
    return db;
}

module.exports = { openDb, SCHEMA };
