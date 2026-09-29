'use strict';
/**
 * Live thumbnails for every ingest protocol (T4 decision 4). Each transport worker owns its source
 * and grabs one frame from it every interval, then uploads it to Media as an object under the `live`
 * namespace (grant media.object.upload ns live); the object's public URL becomes the session's
 * thumbnail_url and travels on the session state and its openre.session.* events. Live can no longer
 * read a local FLV/SFU/relay for OpenRe-owned sessions, so the frame has to come from here.
 *
 * The grabber is protocol-agnostic: the caller passes the ffmpeg *input* arguments for its source
 * (an RTMP/HTTP-FLV URL, the JSMPEG data tap, or an SDP file for a PlainRTP consumer) and this module
 * runs ffmpeg once, emitting one MJPEG frame on stdout. Best effort: a grab or an upload that fails is
 * logged and the session carries on.
 */
const { spawn } = require('child_process');

function createThumbnailer({ config, log = console, spawnImpl = spawn, media }) {
    const cfg = config.webrtc.thumbnails;
    const enabled = Boolean(cfg.enabled && media && media.configured);

    /** One keyframe frame from ffmpeg's input args, as a JPEG buffer (or null). */
    async function capture(inputArgs) {
        return await new Promise((resolve) => {
            const args = [
                '-hide_banner', '-loglevel', 'error', '-y',
                ...inputArgs,
                '-frames:v', '1', '-vf', `scale=${cfg.width}:-2`,
                '-f', 'image2pipe', '-vcodec', 'mjpeg', '-',
            ];
            let proc;
            try { proc = spawnImpl(config.outputs.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { resolve(null); return; }
            const chunks = [];
            proc.stdout.on('data', (d) => chunks.push(d));
            proc.stderr.on('data', () => {});
            const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 15000);
            timer.unref?.();
            const done = (ok) => { clearTimeout(timer); const buf = Buffer.concat(chunks); resolve(ok && buf.length > 2000 ? buf : null); };
            proc.on('error', () => done(false));
            proc.on('close', (code) => done(code === 0));
        });
    }

    /** Upload a grabbed buffer to Media and record the URL on the session. Returns the URL or null. */
    async function publish(store, sessionId, buffer, metadata = {}) {
        if (!enabled || !buffer) return null;
        try {
            const r = await media.uploadObject({
                namespace: cfg.namespace,
                kind: 'image',
                visibility: 'public',
                mimeType: 'image/jpeg',
                filename: `openre-${sessionId}.jpg`,
                bytes: buffer,
                metadata: { openre_session_id: sessionId, ...metadata },
            });
            if (r && r.url) await store.sessions.setThumbnail(sessionId, r.url);
            return r ? r.url : null;
        } catch (err) {
            log.warn(`[thumbnails] ${sessionId}: upload failed: ${err.message}`);
            return null;
        }
    }

    return { enabled, capture, publish };
}

module.exports = { createThumbnailer };
