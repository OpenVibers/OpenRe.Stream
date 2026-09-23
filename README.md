# OpenRe.Stream

> Ingest and restream: stream definitions, keys, sessions, transport workers, outputs and output health.

**Status:** alpha (roadmap Wave 7). Runs and is tested end to end with real RTMP; not deployed, and no broadcaster uses it yet. The domain keeps its placeholder page on OpenVibe.Sites until the launch rule below is met.
**Domain:** `openre.stream` (UI + API), `ingest.openre.stream` (RTMP, DNS only)
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §10, §10.5, §15.10; ADR-009 (binding), ADR-004, ADR-006, ADR-007.
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

The ingest/restream control plane and runtime extracted from OpenVibe.Live. Live keeps the creator/channel product and observes sessions through OpenRe APIs and events; transport workers survive Live deploys **and OpenRe API deploys**. This is the permanent fix for "restarting Live drops live RTMP streams" (hazard H1).

## Owns

- stream (input) definitions, owned by a canonical subject (`usr_…`), with typed references to other services' entities (`live:managed_stream:12`, `live:user:45`)
- ingest keys: SHA-256 only, shown once at creation/rotation; rotation revokes the old key immediately or after a grace period (`openre.key.rotate`)
- ingest sessions: `starting → live → ending → ended | failed`, with the owning worker, its generation and a lease
- transport workers and their generations (who owns which session; new sessions reach the newest ready generation; old ones drain)
- restream destinations (URL + key sealed with AES-256-GCM, never returned in full), outputs with health, progress and bounded logs, a circuit breaker per destination
- recording *requests* to OpenVibe.Media, and the migration map from Live ids
- the lifecycle events `openre.session.started|ended|failed`, `openre.output.healthy|failed`, `openre.recording.requested`, `openre.key.rotated`

## Does not own

- channel presentation, discovery, watch pages, the creator dashboard (Live)
- recording bytes and finalisation (Media: it records, finalises, thumbnails and fires `vod.ready`)
- chat, money, identity

## Depends on

- OpenVibe.Network (JWKS for service tokens and user JWTs; OAuth client `openre`; client-credentials tokens for Events/Media)
- OpenVibe.Events (event relay; optional: rows wait in the outbox)
- OpenVibe.Media (recording requests; optional: sessions work without it)
- OpenVibe.Contracts (ids, problem+json, capability checks), OpenVibe.SDK v0.2.2 (outbox, token client), OpenVibe.Shared (chrome)
- node-media-server 2.7.4 (the RTMP session code Live runs) and the system ffmpeg

## What is ported, per protocol

| Transport | Live source | In OpenRe | State |
|---|---|---|---|
| RTMP ingest | `server/streaming/rtmp-server.js` (node-media-server) | `workers/rtmp-ingest.js` — same NMS session code; OpenRe's own keys; publish renamed to `/live/<session id>` so no key reaches a play URL; loopback RTMP play + HTTP-FLV per generation; SO_REUSEPORT drain | **ported, tested with real ffmpeg** |
| Restream (RTMP source) | `server/streaming/restream-manager.js` | `workers/restream/*` — same ffmpeg arguments (codec copy from HTTP-FLV), Twitch→RTMPS, Kick `/app`, SRT options, live ACK by `-progress`, backoff, rapid-crash circuit breaker, destination cooldown | **ported, tested with real ffmpeg** |
| Restream from JSMPEG / WebRTC sources | same | encoder args ported (`encodingArgs`), sources not (they need those ingests) | not ported |
| Recording | `server/streaming/recorder.js` + `server/media-client.js` | `server/store/recordings.js` + `server/media-client.js` — same Media API v1 calls (create VOD, `ingest/rtmp`, finalize, delete shell / clips-only) driven by the coordinator; Media pulls the loopback play URL | **ported (RTMP)**, tested against a stub Media that really pulls the URL |
| WHIP / WebRTC ingest | `whip-handler.js` (werift) | `workers/webrtc-ingest.js`: worker interface + coordinator registration only | **not ported** |
| SFU | `webrtc-sfu.js` + `broadcast-server.js` (mediasoup) | `workers/sfu.js`: worker interface only | **not ported** |
| JSMPEG | `jsmpeg-relay.js` | `workers/jsmpeg.js`: worker interface only | **not ported** |
| OAuth-linked destinations (per go-live Twitch/YouTube key refresh, YouTube broadcast creation) | `restream-manager._refreshDestFromConnection` | no (Live owns platform OAuth); OpenRe pushes to the stored key | **not ported** |
| Viewer counts from platforms, chat relay, PowerChat | restream-manager / integrations | no (product features, stay in Live) | not in scope |

## Processes

```
                ┌───────────────── one SQLite database (WAL), /var/lib/openre/openre.db ─────────────────┐
openre-api (4500)            openre-session-coordinator        openre-rtmp-ingest@<release>      openre-restream-worker@<release>
 API + UI + /play proxy       leases, generations, drain,       0.0.0.0:1936 publish (reuseport)  one ffmpeg per output, pulls the
 definitions, keys,           output assignment, recording      127.0.0.1 play + HTTP-FLV         session's HTTP-FLV from its worker
 destinations, end requests   requests (Media), event relay     per generation
```

- **No process depends on another at runtime.** Workers need only the database. The API owns no transport; restarting it never touches a session (`test/api-restart.test.js`, `test/rtmp-e2e.test.js`).
- **Generations.** Each worker process registers as generation N+1 of its kind. When a newer generation is `ready`, the coordinator marks older ones `draining` (deadline `OPENRE_DRAIN_MAX_MS`, default 24 h). A draining RTMP worker closes its public listener (the kernel sends new encoder connections to the new generation through the shared port) and keeps its publishers; a draining restream worker keeps its outputs. Idle → the process exits 0 by itself. At the deadline, remaining sessions are ended (encoders reconnect to the newest generation) and remaining outputs are handed over.
- **Leases.** Every heartbeat (2 s) renews the worker and the lease of every session it owns in one transaction. A worker silent for `OPENRE_WORKER_LEASE_MS` (15 s) is `lost`: its sessions fail (`openre.session.failed`), its outputs go back to `pending` for another worker. A lost worker that wakes up drops its transports and exits.
- **Isolation.** An output only ever changes its own row. A dead destination fails (`openre.output.failed`, destination cooldown 15 min → 24 h) and the session stays live (`test/rtmp-e2e.test.js`, `test/sessions.test.js`, `test/coordinator.test.js`).
- **Store.** SQLite per ADR-007 (single host). Several writer processes is the trigger ADR-007 names for PostgreSQL; all SQL is in `server/store/*`, so that move replaces one layer. Redis/etcd are not used; leases live in the same database.

## Running it

```bash
npm install
cp .env.example .env              # set OPENRE_SECRETS_KEY (openssl rand -hex 32)
npm run dev                       # openre-api on http://127.0.0.1:4500
npm run coordinator               # in other terminals
npm run rtmp-ingest
npm run restream-worker
npm test                          # every test/*.test.js; the RTMP e2e test needs ffmpeg on PATH
```

Node 22 (≥ 22.12 for `reusePort`): `fnm exec --using=22.22.1 npm test`.

## Auth

Services call with an OpenVibe.Network client-credentials token (audience `openvibe.openre`), verified offline against the Network JWKS; each route checks one capability. A service may send `X-OV-Subject: usr_…` to act for one owner (it is then limited to that owner's streams). Browsers/owners use the Network user JWT (`ov_token` cookie from `/auth/login`, or Bearer) and act on their own streams; Network role `admin` is staff (read all, end sessions).

| Capability | Routes |
|---|---|
| `openre.stream.read` | `GET /api/v1/streams[?external_ref=live:managed_stream:12]`, `GET /api/v1/streams/:id`, `GET /api/v1/streams/:id/keys` |
| `openre.stream.write` | `POST /api/v1/streams` (first key, shown once), `PATCH`/`DELETE /api/v1/streams/:id` |
| `openre.key.rotate` | `POST /api/v1/streams/:id/keys/rotate {grace_seconds, end_sessions}` (new key, shown once) |
| `openre.session.read` | `GET /api/v1/sessions`, `GET /api/v1/sessions/:id`, `GET /api/v1/sessions/:id/playback`, `GET /api/v1/workers` |
| `openre.session.end` | `POST /api/v1/sessions/:id/end` |
| `openre.output.read` | `GET /api/v1/streams/:id/destinations`, `GET /api/v1/sessions/:id/outputs`, `GET /api/v1/destinations/:id/logs`, `GET /api/v1/outputs/:id/logs` |
| `openre.output.write` | `POST /api/v1/streams/:id/destinations`, `PATCH`/`DELETE /api/v1/destinations/:id`, `POST /api/v1/destinations/:id/test|start|stop` |

The ids are proposed in [docs/capabilities-proposal/](docs/capabilities-proposal/) with the service manifest ([docs/service-manifest-proposal.json](docs/service-manifest-proposal.json)); they are not in `openvibe-contracts` yet. Until that release, `server/auth/index.js` grants them with the contracts rule (exact id or `family.*`) and defers to `capabilities.check()` once contracts know the id. Errors are RFC 9457 problem+json with a stable `code`.

**Grants the lead adds in Network** (`[client, capability, audience]`):

- `[live, openre.stream.read, openvibe.openre]`, `[live, openre.stream.write, openvibe.openre]`, `[live, openre.key.rotate, openvibe.openre]`, `[live, openre.session.read, openvibe.openre]`
- `[openre, events.event.publish, openvibe.events]`
- `[live, events.subscription.manage, openvibe.events]` if Live creates its own `openre.session.*` subscription (or an operator creates it)
- Media, only when `OPENRE_MEDIA_AUTH=service`: `[openre, media.object.upload, openvibe.media]` with namespace `live` — and Media must first name that capability on its VOD create/ingest/finalize/delete routes (today they accept only the tenant app key; see "Recording").
- OAuth client `openre` (authorization code + client credentials) with redirect `https://openre.stream/auth/callback`.

## Events

Written to `event_outbox` in the same SQLite transaction as the change (openvibe-sdk `createOutbox`); the coordinator's relay publishes them with OpenRe's service token. Envelopes validate against `events.event-envelope@1`; `visibility: internal`; no payload ever carries an ingest key or a destination key.

| Type | Subject | When |
|---|---|---|
| `openre.session.started` | `ingest_session` | a session reached live (payload: owner, protocol, worker + generation, `external_refs`, `mirror_to_live`, playback descriptor) |
| `openre.session.ended` | `ingest_session` | a session that had been live ended (duration, reason) |
| `openre.session.failed` | `ingest_session` | worker lost, lease expired, … (`was_live`, reason) |
| `openre.output.healthy` / `openre.output.failed` | `output` | an output confirmed live / gave up (error, cooldown) |
| `openre.recording.requested` | `recording` | Media accepted the recording request (Media app + VOD id) |
| `openre.key.rotated` | `stream` | new key id + hint, retired key ids, grace end |

## Playback

`GET /api/v1/sessions/:id/playback` returns a descriptor: `flv.internal_url` (loopback HTTP-FLV on the worker that holds the session — for services on this host), `flv.public_url` (`https://openre.stream/play/<session>.flv`, proxied by the API for non-private streams), `rtmp.internal_url` (loopback RTMP play, what Media records from). `webrtc` and `hls` are `null` (not produced). Live's player keeps using its own `/api/streams/rtmp-proxy/:id.flv`, which for an OpenRe session proxies `flv.internal_url` (see the Live patch).

## Recording

When a session is live and its definition says `recording_mode` `vod` or `clips`, the coordinator asks Media, exactly as Live's recorder does: `POST /api/v1/<MEDIA_APP_ID>/vods` (title, Live `user_id`/`managed_stream_id` from the typed references so the VOD lands in the Live channel's gallery, visibility, `meta.openre_session_id`), then `POST …/vods/:id/ingest/rtmp { rtmp_url: rtmp://127.0.0.1:<play port>/live/<session id> }`. When the session ends: `POST …/finalize` (clips-only recordings are then deleted, as Live does). A disk-space refusal deletes the empty VOD shell and retries every 5 min while the session is live. Media finalises. Auth today is the Media tenant key (`MEDIA_API_KEY`, the `live` app's key — the interim compromise, as Live holds it too); the target is `OPENRE_MEDIA_AUTH=service` once Media accepts service tokens on those routes. Known gap: the VOD's `stream_id` (a Live id) is not set, because Live creates its `streams` row from the event; Live links the VOD by slot, user and time.

## Security notes

- Ingest keys: 256-bit random, `ork_` + 43 base64url characters, SHA-256 at rest, compared by indexed lookup inside the RTMP handshake. Never logged (only the last four characters), never in an event, never in a URL after the handshake (the publish is renamed to the session id).
- Destination keys and SRT passphrases: AES-256-GCM (`OPENRE_SECRETS_KEY`, rotation via `OPENRE_SECRETS_KEY_PREVIOUS`); APIs return `****` + last four only; ffmpeg command lines are logged redacted.
- SSRF (plan anti-goal 13): destination URLs must be `rtmp://`, `rtmps://` or `srt://` with a hostname, no credentials, and no loopback/private/link-local/CGNAT/multicast host — checked on write and again, with DNS resolution, right before ffmpeg starts (`OPENRE_DEST_ALLOW_PRIVATE` opts out, e.g. a LAN box). Live allowed private hosts; the migration holds such destinations with the reason recorded.
- The RTMP public listener accepts publish only; play is refused there. Loopback play/FLV ports accept only `/live/ses_<ULID>` paths.
- UI forms carry a CSRF token derived from the session cookie; cookies are SameSite=Lax.

## Port plan

| Port | Owner | Until |
|---|---|---|
| 1935/tcp | Live's in-process RTMP (node-media-server) | Live's RTMP ingest is retired (after the last slot has run on OpenRe for two weeks, ADR-009) |
| 9935/tcp (loopback) | Live's HTTP-FLV | same |
| **1936/tcp** | OpenRe `openre-rtmp-ingest` (all generations, SO_REUSEPORT) | permanent: URLs handed out as `rtmp://ingest.openre.stream:1936/live` keep working |
| 19360–19399/tcp (loopback) | OpenRe per-generation RTMP play + HTTP-FLV | permanent |
| 4500/tcp (loopback) | `openre-api` | permanent |

The switch to 1935: once Live no longer listens on 1935, set `OPENRE_RTMP_EXTRA_PORTS=1935` and deploy a worker generation (`deploy.sh workers`); from then on `rtmp://ingest.openre.stream/live` works too, and 1936 keeps working. `ingest.openre.stream` is a DNS-only record (RTMP cannot go through Cloudflare's proxy); open 1936/tcp at the host firewall and the provider edge.

## Deploying

Layout: `/opt/openre.stream/releases/<sha>` (full checkouts), `current` → the release the API and coordinator run, env `/etc/openvibe/openre.env` (see [.env.example](.env.example)), store `/var/lib/openre/openre.db`, units in [deploy/systemd/](deploy/systemd/), nginx [deploy/nginx/openre.stream.conf](deploy/nginx/openre.stream.conf), script [deploy/scripts/deploy.sh](deploy/scripts/deploy.sh):

```bash
sudo deploy/scripts/deploy.sh release origin/main   # new release dir + npm ci
sudo deploy/scripts/deploy.sh api                   # restarts openre-api + coordinator ONLY
sudo deploy/scripts/deploy.sh workers               # starts a new worker generation; old ones drain
sudo deploy/scripts/deploy.sh status
```

- An **API deploy** never restarts a worker unit (no unit depends on another). Viewers of `openre.stream/play/…` reconnect; encoders, restreams and recordings do not notice.
- A **worker deploy** starts `openre-rtmp-ingest@<sha>` and `openre-restream-worker@<sha>`; older instances are disabled (not stopped) and exit on their own when drained. Never `systemctl restart` a worker instance during a broadcast; `systemctl stop` starts a drain and waits up to 30 min (`TimeoutStopSec`), then kills.
- First install: create the `openre` OAuth client and grants in Network, `/etc/openvibe/openre.env` (0600), the certificate for `openre.stream`, DNS for `openre.stream` (proxied) and `ingest.openre.stream` (DNS only), firewall 1936/tcp, then `release`, `api`, `workers`, and `systemctl enable --now openre-api openre-session-coordinator`.

## Live integration (patch)

[docs/live-patch.diff](docs/live-patch.diff) is the Live side, made against OpenVibe.Live `c384787` and verified there (applies with `git apply`; Live's `npm test` 62/62 on Node 22.22.1). **Switch off (the default) changes nothing**: with `OPENRE_URL` unset, or a slot on `'live'`, every changed code path returns what it returned before (`test/openre-switch.test.js` in the patch). It adds:

- `server/openre/openre-client.js` — service-token client for OpenRe (streams by `external_ref`, create, rotate, sessions, playback descriptors).
- `managed_streams.ingest_authority` (`'live'` default | `'openre'`) + `openre_stream_id`, and an `openre_sessions` projection table (additive, in `initDb`).
- Live's RTMP `prePublish` refuses a slot key when the slot is on `'openre'` (a stream can never be ingested twice). Only RTMP moves; WHIP/browser/JSMPEG for that slot stay on Live.
- Go Live / stream-key UI for `'openre'` slots: `GET /api/streams/managed` returns the slot without its Live key; `GET /api/streams/managed/:id/profile` and `GET /api/streams/:id/endpoint` show OpenRe's RTMP URL and a key hint (never a key); `POST /api/streams/managed/:id/regenerate-key` rotates on OpenRe and shows the new key once; `GET /api/streams/:id/rtmp-status` reads the mirror. Small fallbacks in `broadcast.js` / `broadcast-workspace.js` display the hint.
- `POST /internal/openre-events` — OpenVibe.Events delivery endpoint (SDK `parseDelivery` + `createInbox`, consumer `live-openre-mirror`): `openre.session.started` creates or attaches the slot's `streams` row (control config, go-live notifications, Live's own `live.stream.started`), `ended`/`failed` end it; revision-ordered, exactly once; only for switched slots whose definition has `mirror_to_live` (consent). A 30 s reconcile asks OpenRe about mirrored live sessions (heartbeat refresh; ends rows OpenRe ended). Live's stale-stream cleanup skips mirrored sessions OpenRe confirmed in the last 30 min, and Live's boot-time restream resume skips them.
- Playback: `GET /api/streams/rtmp-proxy/:id.flv` proxies the session's `flv.internal_url` from OpenRe's playback descriptor (validated as a loopback `…/live/ses_….flv` URL), so Live's player is unchanged.
- Restream routes refuse (409 + `manage_url`) edits/start/stop for destinations of `'openre'` slots: those restreams run and are managed on openre.stream.
- Admin: `GET /api/admin/openre/status`, `PUT /api/admin/openre/managed/:id/ingest-authority {authority, force}` — `'openre'` needs the slot offline, an RTMP slot (or `force`), the owner's canonical subject; it finds or creates the OpenRe definition and, in one transaction, flips the slot and rotates Live's own key for it. `'live'` flips back.
- Env: `OPENRE_URL`, `OPENRE_PUBLIC_URL`, `OPENRE_EVENTS_SECRET` (in Live's `.env.example`). Unsetting `OPENRE_URL` is the emergency rollback for every switched slot at once.

Not in the patch (follow-ups): live thumbnails, AI audio/vision taps and the RobotStreamer publisher for OpenRe sessions (they read Live's local HTTP-FLV by key; they can read `flv.internal_url` instead); Stream Manager destination editing through OpenRe's API (today: a link to openre.stream); platform viewer counts for OpenRe outputs.

## Migration

`node scripts/migrate-from-live.js --live-db <snapshot> [--apply] [--slots 12,31] [--checklist out.md]` reads a **read-only snapshot** of Live's database (`sqlite3 …/live.db ".backup /tmp/live-snapshot.db"`), imports `managed_streams` as stream definitions (owner = `linked_accounts.subject_id`, recording mode/visibility from the slot and channel, refs `live:managed_stream` + `live:user`, `mirror_to_live` on) and their `restream_destinations` (keys sealed), and prints a per-channel cutover checklist. **No old key is imported**: each imported slot gets a new key nobody has seen; the broadcaster rotates to get one. Every source row is recorded in `migration_map` as imported, held (no subject yet; a private-host URL — kept disabled with the key sealed; unbound destination of a multi-slot user) or excluded (banned account), with the reason. Dry run by default; idempotent (`test/migration.test.js`).

## Cutover runbook

ADR-009: one protocol at a time (RTMP → WHIP → JSMPEG → SFU), per slot, behind the switch, in a maintenance window agreed with the broadcaster; every key that existed before is rotated at the RTMP cutover; Live's ingest code stays until the last protocol has run on OpenRe for two weeks.

### RTMP (ready)

Once, before the first slot:

1. Network: OAuth client `openre` + the grants listed under "Auth". Contracts: release the proposals.
2. Host: deploy OpenRe (see "Deploying"), `curl 127.0.0.1:4500/api/ready` shows `ready`, one `rtmp-ingest` and one `restream` worker `ready`, the coordinator lease valid.
3. Events: subscription `openre.session.*` → `http://127.0.0.1:3000/internal/openre-events`; put its secret in Live as `OPENRE_EVENTS_SECRET`.
4. Live: apply `docs/live-patch.diff`, set `OPENRE_URL=http://127.0.0.1:4500`, deploy Live (`deploy.sh --wait-idle`). With no slot switched this changes nothing.
5. Rehearse with a test account: a slot, `migrate-from-live.js --apply --slots <id>`, switch, regenerate, stream from OBS to `rtmp://ingest.openre.stream:1936/live`: the channel page shows the stream, restreams go live, a VOD appears; deploy Live and `deploy.sh api` during the broadcast — nothing drops; `deploy.sh workers` — the session stays on the old generation, a new publish lands on the new one.

Per channel (the checklist printed by the migration script, per slot):

1. Maintenance window agreed with the broadcaster; the slot is offline.
2. `migrate-from-live.js --live-db <fresh snapshot> --apply --slots <id>`; review destinations on openre.stream (held ones need the owner).
3. `PUT /api/admin/openre/managed/<id>/ingest-authority {"authority":"openre"}` — Live refuses the old key from now on and has rotated its own copy.
4. The broadcaster presses **Regenerate stream key** on the Go Live page (OpenRe issues the key, shown once) and pastes server `rtmp://ingest.openre.stream:1936/live` and the key into OBS.
5. Rotate the broadcaster's personal Live key too (`users.stream_key`; not migrated).
6. Test broadcast; watch `deploy.sh status`, `/api/admin/openre/status` on Live, the output health on openre.stream.

Rollback (per slot): `{"authority":"live"}` — the broadcaster regenerates the key on Live and points OBS back at the Live RTMP URL shown on the Go Live page. All slots at once: unset `OPENRE_URL` in Live and restart it (waiting for idle).

### WHIP, JSMPEG, SFU (not ready)

Each needs its transport ported into its worker (`workers/webrtc-ingest.js`, `workers/jsmpeg.js`, `workers/sfu.js` have the interface and registration), a restream source for it, a playback descriptor (`webrtc`), recording (RTP to Media for WebRTC; JSMPEG has no Media ingest), and `OPENRE_PROTOCOLS` in Live's `server/openre/authority.js` extended. The same per-slot switch, window and rollback apply.

## Acceptance

| Criterion (ADR-009 / plan W7) | Evidence |
|---|---|
| OpenRe ingests and restreams without visiting Live | `test/rtmp-e2e.test.js`: real ffmpeg publish → OpenRe worker → ffmpeg restream to an RTMP sink; no Live process involved |
| Deploying the OpenRe API does not end worker-owned transports | `test/api-restart.test.js` (API process SIGTERM + restart while a worker process holds a live session; lease keeps renewing) and `test/rtmp-e2e.test.js` (same with a real encoder, restream and FLV playback afterwards) |
| New sessions route to the newest ready generation; old workers drain | `test/rtmp-e2e.test.js` (second RTMP worker process: new publish on generation 2, generation 1 keeps its session, closes its listener and exits 0 when it ends), `test/coordinator.test.js` |
| A destination failure never terminates the source session | `test/rtmp-e2e.test.js` (dead destination fails, session and encoder stay), `test/sessions.test.js`, `test/coordinator.test.js` (lost restream worker) |
| Recording finalisation stays in Media | `test/recording-events.test.js`, `test/rtmp-e2e.test.js` (Media is asked to create/ingest/finalise; Media's ffmpeg pulls the loopback URL) |
| Every stream key that existed before is rotated | `test/migration.test.js` (old keys never imported; new keys unseen), Live patch rotates Live's own slot key at the switch; checklist step for personal keys |
| Deploying Live during a broadcast does not interrupt transport or recording | by construction (no OpenRe process talks to Live); proven for real only after the Live patch is deployed — not claimed here |
| Switch off = no Live behaviour change | Live's full `npm test` with the patch applied, plus `test/openre-switch.test.js` |

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12): an owning runtime with health/readiness endpoints and
observability; canonical identity/auth integration; server-rendered public routes useful without
JavaScript; real persistence and end-to-end workflows; capability and event registration against
`OpenVibe.Contracts`; a migration/seed strategy, a security/threat review, and
sitemap/robots/feed behaviour; acceptance tests proving the advertised functionality. Today the
first three and the last are in place; capability registration, a security review and the
production deploy are not.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
