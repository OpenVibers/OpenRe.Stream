#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# OpenRestream transport workers (run on the host as root; `deploy/scripts/deploy.sh workers|status|prune` calls this).
# `ovhost deploy openre` makes releases and restarts the API and coordinator; it never starts, stops or restarts a
# transport worker, because an ingest or restream session must not be cut. Worker generations are rolled here:
#
#   workers.sh workers [<sha>]   start a new generation of every worker from a release (default: the newest); older
#                                generations are disabled (not stopped) and drain and exit on their own
#   workers.sh status            units, generations, open sessions
#   workers.sh prune             remove releases nothing uses (keeps the newest 5, `current` and every worker's)
#
# Layout: /opt/openre.stream/releases/<sha>/, `current` for the API and coordinator, one openre-rtmp-ingest@<sha> /
# openre-restream-worker@<sha> / openre-jsmpeg@<sha> / openre-webrtc@<sha> instance per worker generation.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

ROOT=${OPENRE_ROOT:-/opt/openre.stream}
API=${OPENRE_API:-http://127.0.0.1:4500}
NODE_BIN=${NODE_BIN:-node}
UNITS=(openre-rtmp-ingest openre-restream-worker openre-jsmpeg openre-webrtc)

say() { printf '[openre-workers] %s\n' "$*" >&2; }
die() { say "ERROR: $*"; exit 1; }

latest_release() { ls -1t "$ROOT/releases" 2>/dev/null | head -1; }

cmd_workers() {
    local sha=${1:-$(latest_release)}
    [ -n "$sha" ] && [ -d "$ROOT/releases/$sha" ] || die "no release $sha"
    say "starting worker generation from release $sha (older generations drain by themselves)"
    local u units=()
    for u in "${UNITS[@]}"; do units+=("$u@$sha.service"); done
    systemctl enable --now "${units[@]}"
    # Disable (not stop) older instances so a reboot does not bring them back; they exit on their own.
    local patterns=()
    for u in "${UNITS[@]}"; do patterns+=("$u@*"); done
    for unit in $(systemctl list-units --plain --no-legend "${patterns[@]}" | awk '{print $1}'); do
        case "$unit" in *"@$sha.service") ;; *) systemctl disable "$unit" >/dev/null 2>&1 || true; say "draining: $unit";; esac
    done
}

cmd_status() {
    systemctl --no-pager --plain list-units 'openre-*' || true
    curl -s --max-time 3 "$API/api/ready" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log(JSON.stringify({status:r.status,workers:r.workers,coordinator:r.coordinator,events:r.events},null,2))}catch{console.log(s)}})' || true
}

cmd_prune() {
    local keep used r
    used=$( (readlink "$ROOT/current"; systemctl list-units --plain --no-legend 'openre-*@*' | awk '{print $1}' | sed -E 's/.*@(.*)\.service/\1/') | xargs -n1 basename 2>/dev/null | sort -u)
    keep=$(ls -1t "$ROOT/releases" | head -5)
    for r in $(ls -1 "$ROOT/releases"); do
        if echo "$used $keep" | grep -qw "$r"; then continue; fi
        say "removing release $r"
        git -C "$ROOT/repo" worktree remove --force "$ROOT/releases/$r"
    done
}

case "${1:-}" in
    workers) shift; cmd_workers "$@" ;;
    status) cmd_status ;;
    prune) cmd_prune ;;
    *) sed -n '2,14p' "$0"; exit 1 ;;
esac
