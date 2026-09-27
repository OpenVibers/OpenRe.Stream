#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# OpenRe.Stream deploy (run on the host as root; the lead runs it, never CI).
#
#   deploy/scripts/deploy.sh release [<git-ref>]   check out <ref> (default origin/main) into
#                                                  /opt/openre.stream/releases/<sha>, npm ci
#   deploy/scripts/deploy.sh api [<sha>]           point `current` at a release, restart
#                                                  openre-api + openre-session-coordinator.
#                                                  NEVER touches a transport worker.
#   deploy/scripts/deploy.sh workers [<sha>]       start a new generation of both workers from a
#                                                  release; older generations drain and exit on
#                                                  their own (sessions are not interrupted)
#   deploy/scripts/deploy.sh status                units, generations, open sessions
#   deploy/scripts/deploy.sh prune                 remove releases no unit uses (keeps 5)
#
# Layout: /opt/openre.stream/releases/<sha>/ (full checkout + node_modules), `current` symlink
# for the API and coordinator, one openre-rtmp-ingest@<sha> / openre-restream-worker@<sha>
# instance per worker generation. Env: /etc/openvibe/openre.env. Store: /var/lib/openre/openre.db.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

ROOT=/opt/openre.stream
REPO=https://github.com/OpenVibers/OpenRe.Stream.git
API=http://127.0.0.1:4500
NODE_BIN=${NODE_BIN:-node}

say() { printf '[openre-deploy] %s\n' "$*" >&2; }
die() { say "ERROR: $*"; exit 1; }

latest_release() { ls -1t "$ROOT/releases" 2>/dev/null | head -1; }

cmd_release() {
    local ref=${1:-origin/main}
    mkdir -p "$ROOT/releases" "$ROOT/repo"
    if [ ! -d "$ROOT/repo/.git" ]; then git clone --quiet "$REPO" "$ROOT/repo"; fi
    git -C "$ROOT/repo" fetch --quiet --tags origin
    local sha
    sha=$(git -C "$ROOT/repo" rev-parse --short=12 "$ref")
    local dir="$ROOT/releases/$sha"
    if [ -d "$dir" ]; then say "release $sha already exists"; echo "$sha"; return; fi
    git -C "$ROOT/repo" worktree add --detach --quiet "$dir" "$sha"
    (cd "$dir" && npm ci --omit=dev --no-audit --no-fund --quiet)
    chown -R ubuntu:ubuntu "$dir"
    say "release $sha ready at $dir"
    echo "$sha"
}

wait_ready() {
    for _ in $(seq 1 60); do
        if curl -sf --max-time 2 "$API/api/ready" >/dev/null; then return 0; fi
        sleep 1
    done
    return 1
}

cmd_api() {
    local sha=${1:-$(latest_release)}
    [ -n "$sha" ] && [ -d "$ROOT/releases/$sha" ] || die "no release $sha"
    local prev
    prev=$(readlink "$ROOT/current" 2>/dev/null || true)
    ln -sfn "$ROOT/releases/$sha" "$ROOT/current.new" && mv -Tf "$ROOT/current.new" "$ROOT/current"
    say "current -> $sha (was ${prev:-none}); restarting openre-api and openre-session-coordinator only"
    systemctl restart openre-api.service
    systemctl restart openre-session-coordinator.service
    if ! wait_ready; then
        say "openre-api not ready after 60 s; rolling back to ${prev:-nothing}"
        if [ -n "$prev" ]; then
            ln -sfn "$prev" "$ROOT/current.new" && mv -Tf "$ROOT/current.new" "$ROOT/current"
            systemctl restart openre-api.service openre-session-coordinator.service
        fi
        exit 2
    fi
    say "openre-api ready on $sha"
}

cmd_workers() {
    local sha=${1:-$(latest_release)}
    [ -n "$sha" ] && [ -d "$ROOT/releases/$sha" ] || die "no release $sha"
    say "starting worker generation from release $sha (older generations drain by themselves)"
    systemctl enable --now "openre-rtmp-ingest@$sha.service" "openre-restream-worker@$sha.service"
    # Disable (not stop) older instances so a reboot does not bring them back; they exit on their own.
    for unit in $(systemctl list-units --plain --no-legend 'openre-rtmp-ingest@*' 'openre-restream-worker@*' | awk '{print $1}'); do
        case "$unit" in *"@$sha.service") ;; *) systemctl disable "$unit" >/dev/null 2>&1 || true; say "draining: $unit";; esac
    done
}

cmd_status() {
    systemctl --no-pager --plain list-units 'openre-*' || true
    curl -s --max-time 3 "$API/api/ready" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log(JSON.stringify({status:r.status,workers:r.workers,coordinator:r.coordinator,events:r.events},null,2))}catch{console.log(s)}})' || true
}

cmd_prune() {
    local keep used
    used=$( (readlink "$ROOT/current"; systemctl list-units --plain --no-legend 'openre-*@*' | awk '{print $1}' | sed -E 's/.*@(.*)\.service/\1/') | xargs -n1 basename 2>/dev/null | sort -u)
    keep=$(ls -1t "$ROOT/releases" | head -5)
    for r in $(ls -1 "$ROOT/releases"); do
        if echo "$used $keep" | grep -qw "$r"; then continue; fi
        say "removing release $r"
        git -C "$ROOT/repo" worktree remove --force "$ROOT/releases/$r"
    done
}

case "${1:-}" in
    release) shift; cmd_release "$@" ;;
    api) shift; cmd_api "$@" ;;
    workers) shift; cmd_workers "$@" ;;
    status) cmd_status ;;
    prune) cmd_prune ;;
    *) sed -n '2,20p' "$0"; exit 1 ;;
esac
