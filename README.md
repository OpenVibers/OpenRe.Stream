# OpenRe.Stream

> Ingest and restream: stream definitions, keys, sessions, transport workers, outputs and output health.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `openre.stream`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §10 and §10.5.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

The ingest/restream control plane and runtime extracted from OpenVibe.Live. Live keeps the creator/channel product and observes sessions through OpenRe APIs and events; transport workers survive Live deploys.

## Owns

- stream input definitions and keys, ingest sessions, transport worker ownership and generations, output/restream destinations, output health/logs, recording requests to Media, optional mirroring into Live (explicit consent)

## Does not own

- channel presentation, discovery, watch pages (Live)
- recording bytes and finalisation (Media)
- chat

## Planned surfaces

- deployment units: `openre-api`, `openre-rtmp-ingest`, `openre-webrtc-ingest`, `openre-sfu`, `openre-restream-worker`, `openre-session-coordinator` (one repo)
- standalone UI: definitions, keys/ingest URLs, destinations add/edit/delete/test, session lifecycle, output health

## Data (authority tables / families)

- see above (PostgreSQL for durable session metadata; Redis/etcd only for leases/routing)

## Capabilities and events

- `openre.stream.*`, `openre.session.*`, `openre.output.*`, `openre.key.rotate`

Events: ``openre.session.started|ended``, ``openre.output.healthy|failed``, ``openre.recording.requested``

## Depends on

- OpenVibe.Network
- OpenVibe.Media
- OpenVibe.Events
- OpenVibe.Contracts

## Acceptance (must be true before "done")

- OpenRe ingests and restreams without visiting Live
- deploying Live's web/API during a broadcast does not interrupt transport or recording
- deploying the OpenRe API does not terminate worker-owned transports (new sessions route to the newest ready generation; old workers drain)
- destination failure never terminates the source session

## Bootstrap / extraction source

Live's mediasoup/werift/Node-Media-Server/FFmpeg ingest and restream code — the change is lifecycle and ownership, one protocol at a time.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
