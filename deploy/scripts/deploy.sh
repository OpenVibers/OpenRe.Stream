#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# OpenRestream deploy: a thin wrapper around `ovhost deploy openre` (OpenVibe.Host, strategy
# release-layout; roadmap WS-N task 11; OpenVibe.Host docs/deploy-strategies.md). Run on the host as root.
#
#   deploy/scripts/deploy.sh [deploy [<ref>]]       ovhost deploy openre [--to <ref>]: release + api in one
#   deploy/scripts/deploy.sh release [<ref>]        ovhost deploy openre --prepare-only [--to <ref>]: check out
#                                                   <ref> (default origin/main) into releases/<sha12>, npm ci,
#                                                   chown ubuntu; prints the sha12 on stdout as before
#   deploy/scripts/deploy.sh api [<sha>]            ovhost deploy openre [--to <sha>]: point `current` at that
#                                                   release (made if missing), restart openre-api and
#                                                   openre-session-coordinator ONLY, roll back if not ready
#   deploy/scripts/deploy.sh rollback [<sha>]       ovhost rollback openre [--to <sha>]
#   deploy/scripts/deploy.sh plan   (or DRY_RUN=1)  ovhost plan openre
#   deploy/scripts/deploy.sh workers|status|prune   deploy/scripts/workers.sh: ovhost never starts, stops or restarts
#                                                   a transport worker, so worker generations are rolled there
#   --wait-idle / --force after deploy, api or rollback are passed on (ingest sessions refuse an API restart).
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

SERVICE=openre
ROOT="${OPENRE_ROOT:-/opt/openre.stream}"
OVHOST="${OVHOST:-/usr/local/bin/ovhost}"
if [ "${OVHOST_SUDO-auto}" = auto ]; then if [ "$(id -u)" -eq 0 ]; then SUDO=(); else SUDO=(sudo); fi; elif [ -n "${OVHOST_SUDO}" ]; then SUDO=("$OVHOST_SUDO"); else SUDO=(); fi

say() { printf '[openre-deploy] %s\n' "$*" >&2; }

SUB="${1:-deploy}"
[ "$#" -gt 0 ] && shift
[ "${DRY_RUN:-0}" = 1 ] && SUB=plan
REF=""
FLAGS=()
for a in "$@"; do
    case "$a" in
        --wait-idle|--force) FLAGS+=("$a") ;;
        -*) say "unknown option $a"; exit 1 ;;
        *) [ -z "$REF" ] || { say "one <ref|sha> at most"; exit 1; }; REF="$a" ;;
    esac
done

case "$SUB" in
    deploy|release|api|rollback|plan) ;;
    workers|status|prune) exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/workers.sh" "$SUB" ${REF:+"$REF"} ;;
    *) say "unknown command: $SUB (expected deploy, release, api, rollback, plan, workers, status or prune)"; exit 1 ;;
esac

if ! command -v "$OVHOST" >/dev/null 2>&1; then
    say "ERROR: ovhost not found ($OVHOST); install ovhost before deploying"
    exit 1
fi

TO=()
[ -n "$REF" ] && TO=(--to "$REF")
case "$SUB" in
    plan) exec "${SUDO[@]}" "$OVHOST" plan "$SERVICE" "${TO[@]}" ;;
    release)
        # As before: progress on stderr, the release's sha12 alone on stdout (SHA=$(deploy.sh release)).
        "${SUDO[@]}" "$OVHOST" deploy "$SERVICE" --prepare-only "${TO[@]}" "${FLAGS[@]}" >&2
        git -c safe.directory="$ROOT/repo" -C "$ROOT/repo" rev-parse --short=12 "${REF:-origin/main}" ;;
    rollback) say "ovhost rollback $SERVICE ${TO[*]:-} ${FLAGS[*]:-}"; exec "${SUDO[@]}" "$OVHOST" rollback "$SERVICE" "${TO[@]}" "${FLAGS[@]}" ;;
    *) say "ovhost deploy $SERVICE ${TO[*]:-} ${FLAGS[*]:-}"; exec "${SUDO[@]}" "$OVHOST" deploy "$SERVICE" "${TO[@]}" "${FLAGS[@]}" ;;
esac
