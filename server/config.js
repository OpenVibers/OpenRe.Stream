'use strict';
/**
 * OpenRe.Stream configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/openre.env in production); .env.example documents every name.
 *
 * load(env) is pure so tests (and every worker process) can build a config without touching
 * process.env. All processes of the service (openre-api, openre-session-coordinator and the
 * transport workers) read the same file and share one SQLite database (ADR-007: one service,
 * one store; the processes are the reason this service is the first candidate for PostgreSQL).
 */

const int = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const list = (v, d) => (v == null || v === '' ? d : String(v).split(',').map(s => s.trim()).filter(Boolean));
const trim = (v) => String(v || '').replace(/\/+$/, '');

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4500);
    const rtmpPort = int(env.OPENRE_RTMP_PORT, 1936);
    return {
        service: 'openre',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl: trim(env.BASE_URL || (isProduction ? 'https://openre.stream' : `http://localhost:${port}`)),
        // A release label for logs and worker generations (deploy.sh sets the git sha).
        release: env.OPENRE_RELEASE || 'dev',

        // ── Identity: OpenVibe.Network ──────────────────────────
        networkUrl: trim(env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        issuer: trim(env.OV_NETWORK_ISSUER || env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkPublicKey: env.OV_NETWORK_PUBLIC_KEY ? env.OV_NETWORK_PUBLIC_KEY.replace(/\\n/g, '\n') : null,
        audience: 'openvibe.openre',
        // A browser's Network user JWT is accepted when its aud contains one of these.
        userAudiences: list(env.OPENRE_USER_AUDIENCES, ['openvibe.openre', 'openvibe.network']),
        // OAuth client `openre` (browser sign-in for the standalone UI, and this service's own
        // client-credentials tokens for Events and Media).
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'openre',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || (isProduction ? 'https://openre.stream/auth/callback' : `http://localhost:${port}/auth/callback`),
            scope: 'profile',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,

        // ── Store ───────────────────────────────────────────────
        dbPath: env.OPENRE_DB_PATH || './data/openre.db',

        // ── Secrets ─────────────────────────────────────────────
        // 32-byte key (hex or base64) that encrypts destination stream keys and SRT passphrases
        // at rest (AES-256-GCM). OPENRE_SECRETS_KEY_PREVIOUS is tried for decryption only, so the
        // key can be rotated: old rows keep opening while it is set, and a destination is sealed
        // with the current key whenever its stream key is saved again.
        secretsKey: env.OPENRE_SECRETS_KEY || '',
        secretsKeyPrevious: env.OPENRE_SECRETS_KEY_PREVIOUS || '',

        // ── Ingest (RTMP) ───────────────────────────────────────
        rtmp: {
            // Public ingest port. Live's in-process ingest owns 1935 until the RTMP cutover
            // (README "Port plan"); OpenRe listens on 1936 until then.
            port: rtmpPort,
            // Further public ports served by every worker, e.g. 1935 once Live's own RTMP ingest is
            // retired (README "Port plan"): URLs handed out with :1936 keep working forever.
            extraPorts: list(env.OPENRE_RTMP_EXTRA_PORTS, []).map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== rtmpPort),
            bindHost: env.OPENRE_RTMP_BIND || '0.0.0.0',
            // What streamers paste into OBS: rtmp://<publicHost>[:port]/live
            publicHost: env.OPENRE_RTMP_PUBLIC_HOST || (isProduction ? 'ingest.openre.stream' : '127.0.0.1'),
            publicPort: int(env.OPENRE_RTMP_PUBLIC_PORT, rtmpPort),
            // Loopback ports a worker takes for its internal RTMP play and HTTP-FLV endpoints (the
            // restream worker, Media's recorder and the playback proxy pull from these). Each
            // worker generation takes the first free pair from this range, so two generations can
            // run side by side during a drain.
            internalPortMin: int(env.OPENRE_RTMP_INTERNAL_PORT_MIN, 19360),
            internalPortMax: int(env.OPENRE_RTMP_INTERNAL_PORT_MAX, 19399),
            chunkSize: int(env.OPENRE_RTMP_CHUNK_SIZE, 60000),
            maxPublishersPerWorker: int(env.OPENRE_RTMP_MAX_PUBLISHERS, 64),
        },

        // ── Workers, leases, generations ────────────────────────
        workers: {
            heartbeatMs: int(env.OPENRE_WORKER_HEARTBEAT_MS, 2000),
            // A worker (and every session it owns) is lost when it has not heartbeated this long.
            leaseMs: int(env.OPENRE_WORKER_LEASE_MS, 15000),
            // A draining worker keeps its sessions at most this long, then ends them (the encoder
            // reconnects and lands on the newest generation). Plan §15.10 "explicit maximum-lifetime".
            drainMaxMs: int(env.OPENRE_DRAIN_MAX_MS, 24 * 60 * 60 * 1000),
            coordinatorIntervalMs: int(env.OPENRE_COORDINATOR_INTERVAL_MS, 1000),
            restreamPollMs: int(env.OPENRE_RESTREAM_POLL_MS, 1000),
        },

        // ── Restream outputs ────────────────────────────────────
        outputs: {
            ffmpegPath: env.OPENRE_FFMPEG_PATH || 'ffmpeg',
            // Static OpenSSL ffmpeg for rtmps:// (GnuTLS rekeying issue, same as Live).
            ffmpegOpenSslPath: env.OPENRE_FFMPEG_OPENSSL_PATH || '',
            maxPerStream: int(env.OPENRE_MAX_DESTINATIONS, 10),
            // SSRF: destinations may not point at loopback/private/link-local addresses unless
            // this is on (tests; a LAN restream box). Checked on write and again before ffmpeg.
            allowPrivateHosts: bool(env.OPENRE_DEST_ALLOW_PRIVATE, false),
            logsPerOutput: int(env.OPENRE_OUTPUT_LOG_LIMIT, 200),
            // Backoff, circuit breaker and live-ack timings (ported from Live's restream manager).
            restartBaseMs: int(env.OPENRE_RESTART_BASE_MS, 5000),
            restartMaxMs: int(env.OPENRE_RESTART_MAX_MS, 120000),
            maxRestarts: int(env.OPENRE_MAX_RESTARTS, 30),
            rapidCrashMs: int(env.OPENRE_RAPID_CRASH_MS, 5000),
            rapidCrashGiveUp: int(env.OPENRE_RAPID_CRASH_GIVEUP, 4),
            liveAckTimeoutMs: int(env.OPENRE_LIVE_ACK_TIMEOUT_MS, 20000),
            stableMs: int(env.OPENRE_STABLE_MS, 30000),
            startDelayMs: int(env.OPENRE_OUTPUT_START_DELAY_MS, 3000),
        },

        // ── Events (OpenVibe.Events through the SDK outbox) ─────
        events: {
            url: trim(env.EVENTS_URL || ''),
            // Relay runs in the session coordinator. Off when EVENTS_URL or the client secret is
            // missing: rows still commit with every change and wait for the relay.
            publish: env.EVENTS_PUBLISH !== 'off',
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 1000),
        },

        // ── Recording requests (OpenVibe.Media) ─────────────────
        media: {
            url: trim(env.MEDIA_URL || 'http://127.0.0.1:4100'),
            // The Media tenant the recording is filed under. 'live' keeps VODs in the Live
            // channel's gallery (Media still finalises and owns the object, ADR-006).
            appId: env.MEDIA_APP_ID || 'live',
            // 'key': the tenant's app key (MEDIA_API_KEY), which Media's VOD routes accept today.
            // 'service': a Network service token (audience openvibe.media) once Media names a
            // capability on its VOD ingest routes (README "Recording").
            auth: env.OPENRE_MEDIA_AUTH === 'service' ? 'service' : 'key',
            apiKey: env.MEDIA_API_KEY || '',
            enabled: env.OPENRE_RECORDING !== 'off',
            startDelayMs: int(env.OPENRE_RECORDING_START_DELAY_MS, 2000),
        },

        // ── Live compatibility (links on the UI only; never a data dependency) ──
        liveUrl: trim(env.OV_LIVE_URL || 'https://openvibe.live'),
    };
}

module.exports = { load };
