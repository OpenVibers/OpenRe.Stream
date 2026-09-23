'use strict';
/**
 * FFmpeg argument building for restream outputs, ported from OpenVibe.Live
 * server/streaming/restream-manager.js (quality presets, destination URL normalisation, SRT,
 * output flags, friendly errors). Kept byte-for-byte equivalent where it matters so a stream that
 * restreams correctly from Live restreams the same way from OpenRe.
 *
 * Only the RTMP source is ported: RTMP → destination is a codec copy (zero CPU). The JSMPEG
 * (MPEG-TS on stdin) and WebRTC (mediasoup PlainRTP → SDP) sources stay in Live until those
 * ingest protocols move; encodingArgs() is here for them and for a future re-encode option.
 */

const SRT_DEFAULT_LATENCY_MS = 120;

const QUALITY_PRESETS = {
    low: { label: 'Low (720p 1500k)', videoBitrate: '1500k', maxrate: '1800k', bufsize: '1500k', audioBitrate: '96k', preset: 'ultrafast', scale: '1280:720', fps: 30, gop: 60 },
    medium: { label: 'Medium (720p 2500k)', videoBitrate: '2500k', maxrate: '3000k', bufsize: '2500k', audioBitrate: '128k', preset: 'ultrafast', scale: '1280:720', fps: 30, gop: 60 },
    high: { label: 'High (720p 4000k)', videoBitrate: '4000k', maxrate: '4500k', bufsize: '4000k', audioBitrate: '160k', preset: 'superfast', scale: '1280:720', fps: 30, gop: 60 },
    ultra: { label: 'Ultra (1080p 6000k)', videoBitrate: '6000k', maxrate: '6500k', bufsize: '6000k', audioBitrate: '192k', preset: 'veryfast', scale: null, fps: 30, gop: 60 },
    source: { label: 'Source (native 8000k)', videoBitrate: '8000k', maxrate: '8500k', bufsize: '16000k', audioBitrate: '192k', preset: 'fast', scale: null, fps: 0, gop: 60 },
};
const PLATFORM_DEFAULT_PRESET = { twitch: 'medium', youtube: 'high', kick: 'medium', custom: 'medium' };
const ENCODER_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'];

function isSrtUrl(url) { return /^srt:\/\//i.test(String(url || '')); }

/**
 * Full output URL from server_url + stream key. Twitch is normalised to RTMPS and Kick gets its
 * required /app path, exactly as Live does. `dest` carries the decrypted stream_key/srt_passphrase.
 */
function buildDestUrl(dest) {
    if (!dest.server_url || !dest.stream_key) return null;
    if (!/^(rtmps?|srt):\/\/[^\s/]+/i.test(String(dest.server_url).trim())) return null;
    let url = dest.server_url.replace(/\/+$/, '');
    if (dest.platform === 'twitch' && url.startsWith('rtmp://')) url = url.replace(/^rtmp:\/\//, 'rtmps://');
    if (dest.platform === 'kick' && !url.endsWith('/app')) url += '/app';
    if (isSrtUrl(url)) return buildSrtUrl(url, dest);
    return `${url}/${dest.stream_key}`;
}

function buildSrtUrl(base, dest) {
    const u = new URL(base);
    const q = u.searchParams;
    if (dest.stream_key && !q.has('streamid')) q.set('streamid', dest.stream_key);
    const latency = Number(dest.srt_latency_ms) > 0 ? Number(dest.srt_latency_ms) : SRT_DEFAULT_LATENCY_MS;
    q.set('latency', String(latency * 1000));
    if (dest.srt_passphrase) q.set('passphrase', dest.srt_passphrase);
    if (!q.has('mode')) q.set('mode', 'caller');
    if (!q.has('pkt_size')) q.set('pkt_size', '1316');
    return u.toString();
}

function outputArgs(destUrl) {
    const common = ['-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', '-max_muxing_queue_size', '4096'];
    if (isSrtUrl(destUrl)) return [...common, '-f', 'mpegts', '-mpegts_flags', '+resend_headers', destUrl];
    return [...common, '-rtmp_live', 'live', '-f', 'flv', '-flvflags', 'no_duration_filesize', destUrl];
}

/** RTMP source → destination, codec copy (Live's _startRtmpRestream). */
function rtmpCopyArgs(flvUrl, destUrl) {
    return [
        '-hide_banner',
        '-loglevel', 'warning',
        '-rw_timeout', '10000000',
        '-i', flvUrl,
        '-c', 'copy',
        '-fflags', '+nobuffer+discardcorrupt',
        ...outputArgs(destUrl),
    ];
}

/** `-progress pipe:1 -stats_period 1` after the global flags: the live ACK and the health line. */
function withProgress(args) {
    return args[0] === '-hide_banner'
        ? ['-hide_banner', '-progress', 'pipe:1', '-stats_period', '1', ...args.slice(1)]
        : ['-progress', 'pipe:1', ...args];
}

function resolvePreset(destination) {
    const key = destination && destination.quality_preset || 'auto';
    if (key !== 'auto' && QUALITY_PRESETS[key]) return QUALITY_PRESETS[key];
    return QUALITY_PRESETS[PLATFORM_DEFAULT_PRESET[destination && destination.platform || 'custom'] || 'medium'];
}

function customOverrides(d) {
    const o = {};
    if (d && d.custom_video_bitrate && Number.isFinite(Number(d.custom_video_bitrate))) o.videoBitrate = `${d.custom_video_bitrate}k`;
    if (d && d.custom_audio_bitrate && Number.isFinite(Number(d.custom_audio_bitrate))) o.audioBitrate = `${d.custom_audio_bitrate}k`;
    if (d && d.custom_fps && Number(d.custom_fps) > 0) o.fps = Number(d.custom_fps);
    if (d && d.custom_encoder_preset && ENCODER_PRESETS.includes(d.custom_encoder_preset)) o.encoderPreset = d.custom_encoder_preset;
    return o;
}

/** H.264/AAC CBR encode args (Live's _getEncodingArgs), for re-encoding sources. */
function encodingArgs(preset, { hasAudio = true, overrides = {} } = {}) {
    const videoBitrate = overrides.videoBitrate || preset.videoBitrate;
    const audioBitrate = overrides.audioBitrate || preset.audioBitrate;
    const fps = overrides.fps || preset.fps;
    const encoderPreset = overrides.encoderPreset || preset.preset;
    let maxrate = videoBitrate;
    let bufsize = preset.bufsize;
    if (overrides.videoBitrate) { const kbps = parseInt(overrides.videoBitrate, 10); maxrate = `${kbps}k`; bufsize = `${kbps}k`; }
    const args = ['-map', '0:v:0', '-c:v', 'libx264', '-preset', encoderPreset, '-tune', 'zerolatency', '-b:v', videoBitrate,
        '-minrate', videoBitrate, '-maxrate', maxrate, '-bufsize', bufsize, '-g', String(preset.gop), '-keyint_min', String(preset.gop),
        '-sc_threshold', '0', '-flags', '+cgop', '-pix_fmt', 'yuv420p', '-threads', '2', '-x264-params', 'nal-hrd=cbr:force-cfr=1'];
    if (preset.scale) args.push('-vf', `scale=${preset.scale}:force_original_aspect_ratio=decrease,pad=${preset.scale}:(ow-iw)/2:(oh-ih)/2`);
    if (fps > 0) args.push('-r', String(fps), '-fps_mode', 'cfr');
    if (hasAudio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', audioBitrate, '-ar', '48000', '-ac', '2');
    return args;
}

/** ffmpeg stderr → something a streamer can act on (Live's friendlyFfmpegError). */
function friendlyError(raw, platform = 'the destination') {
    const t = String(raw || '');
    const name = platform === 'custom' ? 'the destination' : platform.charAt(0).toUpperCase() + platform.slice(1);
    if (/NetStream\.Publish\.BadName|Authentication|Unauthorized|403|Access denied|invalid stream key|bad name|not authorized|Publish rejected/i.test(t)) return `${name} rejected the stream key — check the key (and that it is a live key, not an expired one)`;
    if (/Name or service not known|Temporary failure in name resolution|getaddrinfo|could not resolve/i.test(t)) return 'Could not resolve the ingest host name — check the server URL';
    if (/Connection refused|No route to host|Network is unreachable|Connection timed out|timed out|Failed to connect|Cannot open connection/i.test(t)) return `Could not connect to ${name}'s ingest server — it may be down or the URL/port is wrong`;
    if (/TLS|SSL|gnutls|handshake|certificate/i.test(t)) return `TLS handshake with ${name} failed — try the plain rtmp:// ingest URL or the platform's rtmps:// address`;
    if (/Broken pipe|Connection reset|End of file|EOF|I\/O error|Input\/output error|Server closed/i.test(t)) return `${name} closed the connection — usually a rejected key, a second stream on the same key, or a platform-side hiccup (auto-retrying)`;
    if (/srt|SRT/.test(t) && /passphrase|encrypt|crypto|Wrong password/i.test(t)) return 'SRT passphrase rejected — the passphrase (or its length, 10–79 characters) does not match the receiver';
    if (/SRT.*(Connection setup failure|rejected|timeout)/i.test(t)) return 'SRT receiver did not accept the connection — check host, port, streamid and that the receiver is in listener mode';
    if (/Unrecognized option|Invalid argument|Option .* not found/i.test(t)) return `Encoder configuration was rejected by ffmpeg (${t.slice(0, 80)})`;
    if (/No such file|not found/i.test(t) && /ffmpeg/i.test(t)) return 'ffmpeg is not installed on the server';
    if (!t.trim()) return 'Restream process stopped without a message';
    return t.slice(0, 160);
}

/** Mask keys in URLs before anything is logged (rtmp path key, SRT streamid/passphrase). */
function redactUrl(value) {
    const s = String(value || '');
    if (/^srt:\/\//i.test(s)) {
        try {
            const u = new URL(s);
            for (const k of ['streamid', 'passphrase']) if (u.searchParams.has(k)) u.searchParams.set(k, '****');
            return u.toString();
        } catch { return 'srt://****'; }
    }
    return s.replace(/^(rtmps?:\/\/[^/\s]+(?:\/[^/\s]+)*)\/([^/\s]{5,})$/i, (m, base, key) => `${base}/****${key.slice(-4)}`);
}

module.exports = {
    QUALITY_PRESETS, PLATFORM_DEFAULT_PRESET, ENCODER_PRESETS, SRT_DEFAULT_LATENCY_MS,
    isSrtUrl, buildDestUrl, buildSrtUrl, outputArgs, rtmpCopyArgs, withProgress, resolvePreset, customOverrides, encodingArgs, friendlyError, redactUrl,
};
