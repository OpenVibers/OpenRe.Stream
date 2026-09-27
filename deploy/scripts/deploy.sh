#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# OpenRe.Stream deploy: a thin wrapper around `ovhost deploy openre` (OpenVibe.Host, strategy
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
#   deploy/scripts/deploy.sh workers|status|prune   deploy-legacy.sh, unchanged: ovhost never starts, stops or
#                                                   restarts a worker unit (it prunes releases itself, never
#                                                   one a worker generation runs from)
#   --wait-idle / --force after deploy, api or rollback are passed on (ingest sessions refuse an API restart).
#
# Fallback: deploy-legacy.sh (the previous script, unchanged) with the same arguments when ovhost is missing
# or too old (no `capabilities`, deploy-api < 1), or the host inventory does not deploy openre with strategy
# release-layout; OVHOST_LEGACY=1 forces it. There `deploy` is `release` then `api`, and `rollback <sha>` is
# `api <sha>`.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

SERVICE=openre
STRATEGY=release-layout
ROOT="${OPENRE_ROOT:-/opt/openre.stream}"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LEGACY="${DEPLOY_LEGACY:-$HERE/deploy-legacy.sh}"
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

legacy() {
    say "$1 — running deploy-legacy.sh (the previous deploy script) instead"
    case "$SUB" in
        deploy) bash "$LEGACY" release ${REF:+"$REF"} >/dev/null; exec bash "$LEGACY" api ;;
        rollback) [ -n "$REF" ] || { say "✗ deploy-legacy.sh needs the release: rollback <sha>"; exit 1; }; exec bash "$LEGACY" api "$REF" ;;
        plan) say "✗ deploy-legacy.sh has no plan; see deploy-legacy.sh status"; exit 1 ;;
        *) exec bash "$LEGACY" "$SUB" ${REF:+"$REF"} ;;
    esac
}

REASON=""
probe() {
    if [ "${OVHOST_LEGACY:-0}" = 1 ]; then REASON="OVHOST_LEGACY=1"; return 1; fi
    if ! command -v "$OVHOST" >/dev/null 2>&1; then REASON="ovhost not found ($OVHOST)"; return 1; fi
    local caps api
    if ! caps=$("${SUDO[@]}" "$OVHOST" capabilities "$SERVICE" 2>/dev/null); then REASON="this ovhost has no 'capabilities' (too old) or no inventory entry for $SERVICE"; return 1; fi
    api=$(printf '%s\n' "$caps" | sed -n 's/^deploy-api=//p')
    case "$api" in ''|*[!0-9]*) REASON="this ovhost reports no deploy-api (too old)"; return 1 ;; esac
    if [ "$api" -lt 1 ]; then REASON="this ovhost's deploy-api is $api, 1 is needed"; return 1; fi
    if ! printf '%s\n' "$caps" | grep -qx "strategy=$STRATEGY"; then REASON="the host inventory does not deploy $SERVICE with strategy $STRATEGY ($(printf '%s\n' "$caps" | sed -n 's/^strategy=//p'))"; return 1; fi
    if ! printf '%s\n' "$caps" | grep -qx "managed=yes"; then REASON="ovhost does not manage $SERVICE"; return 1; fi
    return 0
}

case "$SUB" in
    workers|status|prune) exec bash "$LEGACY" "$SUB" ${REF:+"$REF"} ;;
    deploy|release|api|rollback|plan) ;;
    *) sed -n '2,24p' "$0"; exit 1 ;;
esac

probe || legacy "$REASON"

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
