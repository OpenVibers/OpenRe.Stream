# RTMP cutover runbook (OpenRe.Stream)

The order of work that moves RTMP ingest for Live's stream slots from Live to OpenRe.Stream, one slot
at a time (ADR-009). Every step says who does it, how to check it, and how to undo it.

- **OWNER** steps need the owner: the provider firewall, a Live admin session in the browser, the
  broadcasters, and a real restream destination.
- **AGENT** steps are commands on the host (`ssh openvibe-ovh`, then `sudo`).
- Every command, path and env name below was checked against the code at the commit that added this
  file: OpenRe `deploy/scripts/deploy.sh`, `server/config.js`, `scripts/*`; Live `server/openre/*`,
  `deploy/scripts/deploy.sh`; Events `server/api/subscriptions.js`. The production facts (paths,
  grants, subscriptions, listeners) were read on the host on 2026-09-23, without changing anything.

## Where things stand (2026-09-23)

This is the read-only preflight, run on the host against the deployed release `655b98a10aaa`:

```
FAIL   release   6dc78a5 is not in /opt/openre.stream/repo yet (deploy.sh release fetches it), so 655b98a10aaa cannot contain it
PASS   service   ready: rtmp-ingest#1, restream#1, coordinator lease valid, event relay on
PASS   env       OPENRE_DRILL unset, RTMP port 1936, public host ingest.openre.stream, secrets and EVENTS_URL set
FAIL   bind      OPENRE_RTMP_BIND=127.0.0.1; listening on 127.0.0.1:1936: set OPENRE_RTMP_BIND=0.0.0.0 …
PASS   dns       ingest.openre.stream → 15.204.79.215 (this host)
MANUAL port      ingest.openre.stream:1936 (15.204.79.215) refused (nothing listens there) from this host, which never crosses the provider edge …
PASS   db        integrity_check ok, no foreign key violations (stream_definitions 1, ingest_keys 1, ingest_sessions 1, destinations 0, migration_map 0)
FAIL   live-env  OPENRE_URL not set (the integration is off); OPENRE_EVENTS_SECRET not set
FAIL   events    no subscription live openre.session.* → http://127.0.0.1:3000/internal/openre-events …
```

(The release has no `scripts/cutover-preflight.js` yet, so this was run by piping the script to
`node -` from `/opt/openre.stream/current`, which writes nothing.)

From outside the host (the workstation), `node scripts/cutover-preflight.js --only port` answers:
`ingest.openre.stream:1936 (15.204.79.215) ETIMEDOUT: filtered`. Port 1935, which Live uses, answers
the RTMP handshake from outside, so the provider edge filters 1936 and lets 1935 through. The host
firewall (ufw) is inactive. The Network grants are already in place:
`[live, openre.stream.read|stream.write|key.rotate|session.read, openvibe.openre]`,
`[live, events.subscription.manage, openvibe.events]` and `[openre, events.event.publish, openvibe.events]`.
All 102 Live slots have `ingest_authority = 'live'`.

## Tools

Everything below runs on the host. The scripts ship with the release (`scripts/`):

| Script | What it does | Writes |
|---|---|---|
| `cutover-preflight.js` | read-only checks: `release service env bind dns port db live-env events [slot]` (`--only`, `--skip`, `--slot <id>`, `--json`, `--strict`, `--expect-release <sha>`, `--probe-url`, `--host-ip`) | nothing |
| `subscribe-live-events.js` | Live's Events subscription `openre.session.*` → Live, **as Live** (reads `/etc/openvibe/live.env`); `--dry-run`, `--disable`, `--enable` | one subscription in Events |
| `migrate-from-live.js` | imports slots and destinations from a Live **snapshot** (dry run unless `--apply`) | `openre.db` |
| `set-definition-state.js` | disables or re-enables one slot's OpenRe definition, **as Live** (per-slot rollback) | `openre.db` via the API |

Shell helpers for the session (paste once per SSH session):

```bash
SHA=<the 12-character release id printed by step A2>
# read-only preflight from that release
pf() { sudo node /opt/openre.stream/releases/$SHA/scripts/cutover-preflight.js --expect-release "$SHA" "$@"; }
# run a command in the current release with OpenRe's production env, AS THE SERVICE USER (ubuntu).
# Never run a script that opens openre.db as root: root-owned -wal/-shm files lock the service out.
openre_as_service() { sudo bash -c "set -a; . /etc/openvibe/openre.env; set +a; export NODE_ENV=production OPENRE_DB_PATH=/var/lib/openre/openre.db OPENRE_ENV_FILE=/nonexistent; cd /opt/openre.stream/current && sudo -E -u ubuntu $1"; }
DEPLOY=/opt/openre.stream/releases/$SHA/deploy/scripts/deploy.sh
```

Live admin calls are made in the browser console on openvibe.live, **signed in as an admin**. Live
refuses `hbt_` API tokens on `/api/admin/*`, so only an admin session in the browser can make them:
`await api('/admin/openre/status')`.

## Phase A: once, before the first slot

### A1. Push (OWNER, or the lead)

Push this repository's `main` to GitHub. `deploy.sh release` checks out `origin/main`, and nothing
from this commit onward is on GitHub yet. Undo: nothing to undo.

### A2. Deploy the newest release (AGENT)

```bash
sudo /opt/openre.stream/current/deploy/scripts/deploy.sh release origin/main   # prints the new <sha>
SHA=<that sha>; DEPLOY=/opt/openre.stream/releases/$SHA/deploy/scripts/deploy.sh   # and re-paste pf()
pf --only db                                  # openre.db is sound before anything restarts
sudo $DEPLOY api $SHA                         # restarts openre-api + openre-session-coordinator ONLY
curl -s http://127.0.0.1:4500/api/ready       # "status":"ready"
pf --only release,env,db                      # current = $SHA, it contains 6dc78a5
```

- `release` fetches `origin/main` into `/opt/openre.stream/repo`, checks it out to
  `/opt/openre.stream/releases/<sha>`, runs `npm ci --omit=dev` and gives the directory to `ubuntu`.
  Nothing restarts.
- `api` moves `current` and restarts the API and the coordinator. If the API is not ready within
  60 s, it switches `current` back by itself (exit 2). Worker units are never touched.
- The workers stay on `655b98a10aaa` until A3, so `pf --only service` reports that they run another
  release. That is expected here.
- **nginx:** `6dc78a5` changes only `deploy/nginx/openre.stream.conf`, and that file is not installed.
  `/etc/nginx/sites-available/openre.stream.conf` is still the OpenVibe.Sites placeholder (launch
  rule, README). The release carries the fix, and no nginx action is needed. See B0 for when the
  vhost gets installed.
- **Undo:** `sudo /opt/openre.stream/releases/655b98a10aaa/deploy/scripts/deploy.sh api 655b98a10aaa`.
  Do not run `deploy.sh prune` until the cutover is done, so the old release stays on disk.

### A3. Public RTMP bind (AGENT)

The bind is `OPENRE_RTMP_BIND` in `/etc/openvibe/openre.env` (`server/config.js`, `rtmp.bindHost`).
A worker reads it only when it starts. **A worker generation is started per release**
(`openre-rtmp-ingest@<sha>`), so the new release's worker generation is the bind switch:

```bash
sudo cp -p /etc/openvibe/openre.env /etc/openvibe/openre.env.pre-bind
sudo sed -i 's/^OPENRE_RTMP_BIND=127\.0\.0\.1$/OPENRE_RTMP_BIND=0.0.0.0/' /etc/openvibe/openre.env
sudo grep -c '^OPENRE_RTMP_BIND=0\.0\.0\.0$' /etc/openvibe/openre.env      # 1
sudo $DEPLOY workers $SHA        # new generation of both workers from $SHA; the old ones drain and exit
sudo $DEPLOY status
pf --only service,env,bind        # ready generation on $SHA; 0.0.0.0:1936 listening
```

- The new `openre-rtmp-ingest@$SHA` binds `0.0.0.0:1936` with `SO_REUSEPORT` next to the old
  generation's `127.0.0.1:1936`. The coordinator then drains the old generation within a few seconds. It
  closes its listener and exits 0 once idle, and nobody streams to it today. The old restream
  generation does the same. `test/bind-switch.test.js` proves this sequence with real processes.
- Until A4 the provider edge still drops 1936, so the public bind is not reachable yet.
- Never `systemctl restart` a worker instance to pick up an env change while someone is live (it
  drains, waits up to 30 minutes, then kills).
- **Undo, before any slot is switched:**
  `sudo cp -p /etc/openvibe/openre.env.pre-bind /etc/openvibe/openre.env`, then start a loopback
  generation. Use `sudo /opt/openre.stream/releases/655b98a10aaa/deploy/scripts/deploy.sh workers 655b98a10aaa`
  for the old code, or, with no session open (`deploy.sh status`),
  `sudo systemctl restart openre-rtmp-ingest@$SHA.service` for the same code.
  **Undo in an emergency, with slots switched:** ask the owner to close 1936/tcp at the provider
  edge (A4). No process restarts. To block it on the host at once:
  `sudo iptables -I INPUT -p tcp --dport 1936 ! -i lo -j DROP`. Check `sudo iptables -S INPUT` first.
  Remove the rule with the same line using `-D` instead of `-I`. Never enable ufw for this: it has
  no rule for SSH on this host.

### A4. Open 1936/tcp at the provider edge (OWNER) — not needed: 2026-09-23 19:24 UTC the off-host check passed as soon as the public bind was up

Open **1936/tcp inbound** to `15.204.79.215` in the provider's network firewall, the same place that
already allows 1935. The host firewall (ufw) is inactive and needs nothing. The DNS record
`ingest.openre.stream → 15.204.79.215` (DNS only, grey cloud) is already in place.

Check from any machine that is not the host (the agent's workstation works):

```bash
node scripts/cutover-preflight.js --only dns,port --host-ip 15.204.79.215
#  PASS dns   ingest.openre.stream → 15.204.79.215 (this host)
#  PASS port  ingest.openre.stream:1936 (15.204.79.215) answers the RTMP handshake from outside the host
```

Without a checkout, `nc -vz -w 5 ingest.openre.stream 1936` should say "succeeded".
A **timeout** means the edge still filters. **Connection refused** means the edge is open but nothing
listens publicly (A3). `--probe-url 'https://<a probe you trust>?host={host}&port={port}'` uses an
external probe that answers JSON `{ "open": true|false }`. On the host itself the port check is
always `MANUAL`, because a connection to its own address never crosses the edge.

**Undo:** close the rule at the edge.

### A5. Live settings and the Events subscription (AGENT)

Live reads `OPENRE_URL`, `OPENRE_PUBLIC_URL` and `OPENRE_EVENTS_SECRET` (`server/openre/openre-client.js`,
`server/openre/mirror.js`, `server/openre/routes.js`). The integration is on when `OPENRE_URL` and
`OV_OAUTH_CLIENT_SECRET` are set. With no slot switched this changes nothing
(`test/openre-switch.test.js` in Live).

```bash
sudo grep -c '^OPENRE_' /etc/openvibe/live.env                    # 0: none set yet
sudo cp -p /etc/openvibe/live.env /etc/openvibe/live.env.pre-openre
S=$(openssl rand -hex 32)
printf 'OPENRE_URL=http://127.0.0.1:4500\nOPENRE_PUBLIC_URL=https://openre.stream\nOPENRE_EVENTS_SECRET=%s\n' "$S" | sudo tee -a /etc/openvibe/live.env >/dev/null
unset S
# the subscription, as Live (consumer "live"), signed with that secret
sudo node /opt/openre.stream/current/scripts/subscribe-live-events.js --dry-run
sudo node /opt/openre.stream/current/scripts/subscribe-live-events.js
# Live picks the env up at start
curl -s http://127.0.0.1:3000/api/streams | head -c 300; echo      # who is live
sudo DRY_RUN=1 /opt/openvibe.live/deploy/scripts/deploy.sh --restart   # the plan: it also deploys origin/main if that moved
sudo /opt/openvibe.live/deploy/scripts/deploy.sh --restart --wait-idle
pf --only live-env,events
```

- The subscription endpoint is `http://127.0.0.1:3000/internal/openre-events`. Events allows
  `127.0.0.1` endpoints and signs every delivery with signature v2, and Live requires v2. The new
  subscription gets no history, so the 2026-09-23 rehearsal session is not mirrored.
- Until Live restarts, deliveries would get 503 and be retried. No slot is switched, so none are sent.
- A Live restart drops RTMP, WHIP and WebSocket sessions on Live, and they reconnect. `--wait-idle`
  holds the restart until nobody is live (at most 8 h).
- OWNER check: `await api('/admin/openre/status')` returns `enabled: true`,
  `openre_url: "http://127.0.0.1:4500"`, `events_secret_set: true` and `slots: []`.
- **Undo:** `sudo node /opt/openre.stream/current/scripts/subscribe-live-events.js --disable`, then
  `sudo cp -p /etc/openvibe/live.env.pre-openre /etc/openvibe/live.env` and
  `sudo /opt/openvibe.live/deploy/scripts/deploy.sh --restart --wait-idle`. Without `OPENRE_URL`,
  every slot is ingested by Live again, including switched ones. This is the emergency rollback for
  all slots at once.

### A6. Full preflight (AGENT)

```bash
pf                     # everything PASS; "port" is MANUAL on the host
```

Then repeat the off-host port check from A4.

### A7. Rehearsal with a test slot and a real restream destination (OWNER + AGENT)

Use a **dedicated test account**, not the owner's own. Once any of a user's slots is on OpenRe, Live
refuses that user's personal RTMP key (`refusesLiveIngest`).

1. **OWNER:** sign in to Live once with the test account, so it gets a canonical subject. Create an
   RTMP slot on the Go Live page (for example "openre-rehearsal"). In that slot's restream settings,
   add **one real destination** with plain `rtmp://`, for example a private or unlisted YouTube
   stream: `rtmp://a.rtmp.youtube.com/live2` and its key. Add it before step 2 so that the migration
   imports it, key sealed. After the switch, Live refuses restream edits for the slot (409), and the
   openre.stream UI is not public yet (B0). Avoid Twitch for the rehearsal: Twitch is rewritten to
   `rtmps://`, and this host has no OpenSSL ffmpeg (`OPENRE_FFMPEG_OPENSSL_PATH` is unset). Tell the
   agent the slot id.
2. **AGENT:** snapshot, then migrate that slot (commands in B2), then `pf --only slot --slot <id>`.
3. **OWNER:** switch it with `await api('/admin/openre/managed/<id>/ingest-authority', { method: 'PUT', body: { authority: 'openre' } })`.
   On the Go Live page, press **Regenerate stream key**. The OpenRe key is shown once. In OBS, set
   the server to `rtmp://ingest.openre.stream:1936/live` and paste the key. Start streaming.
4. **Check (AGENT and OWNER):**
   - The channel page on openvibe.live shows the stream, and the player works (Live proxies
     `flv.internal_url`).
   - `await api('/admin/openre/status')` lists the session under `live_sessions`.
   - Sessions and outputs:
     `sudo sqlite3 -readonly /var/lib/openre/openre.db "SELECT id, state, worker_generation FROM ingest_sessions ORDER BY created_at DESC LIMIT 1; SELECT o.state, o.last_error FROM outputs o ORDER BY o.created_at DESC LIMIT 3; SELECT state, media_vod_id, last_error FROM recordings ORDER BY created_at DESC LIMIT 1;"`
     should show a `live` session, a `live` output and a `recording` recording.
   - The destination (YouTube) shows the stream.
   - Deliveries:
     `sudo sqlite3 -readonly /var/lib/openvibe-events/events.db "SELECT d.status, count(*) FROM deliveries d JOIN subscriptions s ON s.id = d.subscription_id WHERE s.consumer = 'live' AND s.topic_pattern = 'openre.session.*' GROUP BY 1"`
     should all be `delivered`.
5. **During the broadcast (AGENT):**
   - `sudo $DEPLOY api $SHA`: the stream, the restream and the recording do not drop. OpenRe
     playback viewers reconnect.
   - `sudo /opt/openvibe.live/deploy/scripts/deploy.sh --restart` (no `--wait-idle`: the rehearsal
     itself is live on Live). First check `/api/streams` for anyone else live. The OpenRe session,
     the restream and the recording keep running. After the restart, Live's 30 s reconcile keeps
     the channel row live.
   - `deploy.sh workers` exercises a generation rollover only with a **newer** release (a new
     instance name). With the same `$SHA` it does nothing. The rollover is covered by
     `test/rtmp-e2e.test.js`. Repeat it here once a newer release exists.
6. **OWNER:** stop the stream. The session becomes `ended`, and the Live stream row ends (mirror).
   The VOD appears in the channel's gallery once Media finalizes it.
7. **Leave the rehearsal slot switched** as a canary, or roll it back with B-rollback.

## Phase B: per slot

### B0. Before the first broadcaster's slot (OWNER decision)

- **Where broadcasters manage restream destinations after the switch.** Live answers 409 with
  `manage_url` (https://openre.stream/streams/<id>) to any restream edit for a switched slot, and
  openre.stream still serves the Sites placeholder. Choose one:
  - (a) Launch the openre.stream UI: install `deploy/nginx/openre.stream.conf` from the release to
    `/etc/nginx/sites-available/openre.stream.conf`, run `nginx -t`, reload, and remove the entry
    from OpenVibe.Sites. The certificate and the OAuth client `openre` with redirect
    `https://openre.stream/auth/callback` must exist. This touches the README launch rule.
  - (b) Tell broadcasters that destinations are frozen at the cutover until (a).
- **Hazard H4, the leaked keys.** 97 of 97 Live stream keys are identical to the pre-leak backup.
  Each slot's cutover rotates that slot's Live key (at the switch) and issues a new OpenRe key that
  only the broadcaster sees. It does not rotate the broadcaster's personal key (`users.stream_key`),
  so step B5 does that. For slots that will not be cut over within days, rotate on Live now: the
  broadcaster presses Regenerate on the Go Live page for each slot, and Regenerate on the dashboard
  for the personal key. No admin bulk rotation exists.

### B1. Window (OWNER)

Agree on a maintenance window with the broadcaster. The slot must be offline, because the switch
refuses a slot that is live on Live. The broadcaster must be reachable and able to change OBS
during the window.

### B2. Migrate the slot (AGENT)

```bash
ID=<Live managed stream id>
pf --only service,db,live-env,events,slot --slot $ID      # slot offline, owner has a subject, RTMP slot
SNAP=/var/lib/openre/live-snapshot-$(date -u +%Y%m%d-%H%M%S).db
sudo sqlite3 -readonly /opt/openvibe.live/data/live.db ".backup $SNAP"
sudo sqlite3 "$SNAP" "PRAGMA journal_mode=DELETE;"         # a .backup copy is WAL; the migration opens it read-only as ubuntu
sudo chown ubuntu:ubuntu "$SNAP" && sudo chmod 600 "$SNAP"  # it holds every Live user and stream key
openre_as_service "node scripts/migrate-from-live.js --live-db $SNAP --slots $ID"            # dry run
openre_as_service "node scripts/migrate-from-live.js --live-db $SNAP --slots $ID --apply"    # import + checklist
sudo rm -f "$SNAP"
pf --only slot --slot $ID       # OpenRe <id> (active, mirrored); N destination(s), held ones counted
```

- The migration imports the slot as a definition with a **new key that nobody has seen**. Old keys
  are never imported. It also imports the slot's restream destinations, keys sealed. Destinations
  on private hosts, and the unbound destinations of a user with several slots, are **held**
  (disabled, with the reason recorded in `migration_map`). It is idempotent.
- The printed checklist (`--checklist <file>` writes it to a file) is the broadcaster-facing list
  for B3 to B6.
- **Undo:** nothing to undo on Live. The OpenRe definition does nothing until the switch. To be
  tidy, `sudo node /opt/openre.stream/current/scripts/set-definition-state.js --slot $ID --state disabled`.

### B3. Switch (OWNER, admin session)

```js
await api('/admin/openre/managed/<ID>/ingest-authority', { method: 'PUT', body: { authority: 'openre' } })
// → { ingest_authority: 'openre', openre_stream_id, rtmp_url: 'rtmp://ingest.openre.stream:1936/live', live_key_rotated: true }
```

In one transaction, Live points the slot at the OpenRe definition that B2 created and rotates its
own copy of the slot key. From this moment Live refuses the old key. It also refuses the owner's
personal key for RTMP, because the owner now has a slot on OpenRe. A 409 means one of: the slot is
live on Live, it is not an RTMP slot, or the owner has no subject. Fix the cause. Do not use `force`
for a non-RTMP slot.

### B4. New key (broadcaster)

On the Go Live page for that slot, press **Regenerate stream key**. OpenRe rotates the key and shows
it once. In OBS, set Server to `rtmp://ingest.openre.stream:1936/live` and Stream Key to that key.

### B5. Personal key (broadcaster; H4)

On the dashboard, press Regenerate for the personal stream key (`POST /api/auth/stream-key/regenerate`).
`users.stream_key` is not migrated, and a leaked copy must stop working too.

### B6. Test broadcast (broadcaster, AGENT, OWNER)

The broadcaster goes live. Check the same things as A7 step 4. `sudo $DEPLOY status` shows the
session on the newest generation, and `await api('/admin/openre/status')` lists it. In the OpenRe DB,
the outputs are `live` and any held destinations are not running.

### B-rollback (per slot)

1. The broadcaster stops streaming. The slot must be offline.
2. **OWNER:** `await api('/admin/openre/managed/<ID>/ingest-authority', { method: 'PUT', body: { authority: 'live' } })`.
3. **AGENT:** `sudo node /opt/openre.stream/current/scripts/set-definition-state.js --slot <ID> --state disabled`.
   OpenRe then refuses the key the broadcaster got in B4, so the slot's destinations can never be
   pushed twice.
4. **Broadcaster:** press Regenerate on the Go Live page. The Live key was rotated at the switch.
   Point OBS back at the Live RTMP URL shown there.

To switch the slot to OpenRe again later, run `set-definition-state.js --slot <ID> --state active`
first, then B3 to B6.

**All slots at once (emergency):** undo A5. Remove `OPENRE_URL`, or restore `live.env.pre-openre`,
and restart Live. Every switched slot then behaves as a Live slot. Its Live key was rotated at the
switch, so each broadcaster regenerates on the Go Live page.

## Phase C: bookkeeping (AGENT, after A2)

- **ovhost inventory.** Copy the `openre` entry of OpenVibe.Host's `host.example.json` into
  `/etc/openvibe/host.json`: `workerUnits`, and the drill block with `OPENRE_DRILL`. Then run
  `sudo ovhost validate openre` and `sudo ovhost status openre`. The status lists the worker
  instances and never restarts them.
- **First restore drill:** `sudo ovhost drill openre`. It needs a release with `OPENRE_DRILL`, so
  run it after A2. Only openre-api runs, with `OPENRE_DRILL=1`, on 127.0.0.1:14500, from a restored
  copy of the database. The coordinator and the workers refuse to start in a drill. The event relay
  and Media calls are off. Writes, `/play/` and sign-in answer 503.
- Update `STATUS.json` and README "Status" after each phase.
- Each slot's Live RTMP key stays in Live's database until Live's RTMP ingest is retired. That
  happens after the last slot has run on OpenRe for two weeks (ADR-009, register C-40). Port 1935
  moves to OpenRe then (`OPENRE_RTMP_EXTRA_PORTS=1935`, `deploy.sh workers`).

## Order of actions

| # | Who | Action | Check |
|---|---|---|---|
| A1 | OWNER | push OpenRe `main` (and OpenVibe.Host) | `git log origin/main` |
| A2 | AGENT | `deploy.sh release origin/main`, `deploy.sh api <sha>` | `pf --only release,env,db`, `/api/ready` |
| A3 | AGENT | `OPENRE_RTMP_BIND=0.0.0.0`, `deploy.sh workers <sha>` | `pf --only service,env,bind` |
| A4 | **OWNER** | open 1936/tcp at the provider edge | off-host `--only port` PASS |
| A5 | AGENT | Live env (3 names), `subscribe-live-events.js`, Live `--restart --wait-idle` | `pf --only live-env,events`; OWNER `/admin/openre/status` |
| A6 | AGENT | full `pf` | all PASS, port MANUAL on host + PASS off host |
| A7 | **OWNER** + AGENT | rehearsal: test account, slot, real destination; migrate; switch; OBS; deploys during the broadcast | A7 step 4 |
| C | AGENT | ovhost inventory + first `ovhost drill openre` | drill passed |
| B0 | **OWNER** | decide on the openre.stream UI; H4 fallback rotations | — |
| B1–B6 | **OWNER** + broadcaster + AGENT | per slot: window, migrate, switch, regenerate, personal key, test | `pf --only slot --slot <id>`, B6 |
