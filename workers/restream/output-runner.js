'use strict';
/**
 * One restream output: one ffmpeg process pushing one session to one destination, restarted with
 * backoff and cut off by a circuit breaker. Ported from Live's RestreamManager._spawnFFmpeg and
 * _scheduleRestart (the same timings, live-ACK rule and rapid-crash detection), with two changes:
 * state is reported to the store (output row, logs, events) instead of an in-memory map, and a
 * failure only ever ends this output — the source session is never touched from here.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { rtmpCopyArgs, jsmpegArgs, webrtcArgs, withProgress, buildDestUrl, resolvePreset, customOverrides, friendlyError, redactUrl, redactText } = require('./ffmpeg-args');
const { validateDestinationUrl, checkResolvedHost } = require('../../server/destination-url');

/** A free even UDP port (the WebRTC source's ffmpeg takes it and its +1 for RTCP). */
function freeUdpPort() {
    return new Promise((resolve, reject) => {
        const s = dgram.createSocket('udp4');
        s.once('error', reject);
        s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}
async function allocateUdpPortPair() { const p = await freeUdpPort(); return p % 2 === 0 ? p : await freeUdpPort(); }

class OutputRunner {
    constructor({ outputId, destinationId, inputUrl, source = 'rtmp', sessionId = null, egressBase = null, store, config, log = console, spawnImpl = spawn, lookup, workerId = null, fetchImpl = globalThis.fetch }) {
        this.outputId = outputId;
        this.workerId = workerId;
        this.secrets = [];
        this.destinationId = destinationId;
        this.inputUrl = inputUrl;
        this.source = source;
        this.sessionId = sessionId;
        this.egressBase = egressBase;
        this.fetchImpl = fetchImpl;
        this.sdpPath = null;
        this.egressHandle = null;
        this.hasAudio = false;
        this.store = store;
        this.config = config;
        this.log = log;
        this.spawnImpl = spawnImpl;
        this.lookup = lookup;
        this.o = config.outputs;
        this.status = 'starting';
        this.proc = null;
        this.restartAttempts = 0;
        this.restartDelay = this.o.restartBaseMs;
        this.rapidCrashCount = 0;
        this.everLive = false;
        this.stopped = false;
        this.timers = new Set();
        this.lastProgressReport = 0;
        this.platform = 'custom';
    }

    timer(fn, ms) {
        const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
        this.timers.add(t);
        return t;
    }

    async report(change) { try { return await this.store.outputs.report(this.outputId, change, { workerId: this.workerId }); } catch (err) { this.log.error(`[restream] report ${this.outputId}: ${err.message}`); return null; } }
    async note(level, message) { try { await this.store.outputs.log(this.outputId, this.destinationId, level, this.scrub(message)); } catch { /* logs are best effort */ } }

    /** ffmpeg's stderr can echo the output URL: never let a destination key reach a log or event. */
    scrub(text) {
        let t = redactText(text);
        for (const s of this.secrets) if (s && s.length >= 4) t = t.split(s).join('****');
        return t;
    }

    async start() {
        if (this.stopped) return;
        let dest;
        try { dest = await this.store.outputs.destinationForWorker(this.destinationId); } catch (err) {
            return this.fail(`destination secrets unavailable: ${err.message}`, { cooldown: false });
        }
        if (!dest || !dest.enabled || dest.hold_reason) return this.stop('destination disabled');
        this.platform = dest.platform || 'custom';
        this.secrets = [dest.stream_key, dest.srt_passphrase].filter(Boolean);
        const v = validateDestinationUrl(dest.server_url, { allowPrivate: this.o.allowPrivateHosts });
        if (!v.ok) return this.fail(v.error, { cooldown: false });
        const resolved = await checkResolvedHost(v.host, { allowPrivate: this.o.allowPrivateHosts, ...(this.lookup ? { lookup: this.lookup } : {}) });
        if (this.stopped) return;
        if (!resolved.ok) return this.fail(`destination refused: ${resolved.error}`, { cooldown: false });
        const destUrl = buildDestUrl(dest);
        if (!destUrl) return this.fail('destination has no usable URL or stream key', { cooldown: false });
        this.preset = resolvePreset(dest);
        this.overrides = customOverrides(dest);
        if (this.source === 'webrtc') {
            const prep = await this.prepareWebrtc();
            if (this.stopped) return;
            // No source yet (the producer has not appeared): retry with the usual backoff.
            if (!prep.ok) return this.scheduleRestart(0, prep.error);
        }
        this.spawn(destUrl);
    }

    /**
     * Open a PlainRTP egress on the worker that holds this session and write the SDP file ffmpeg
     * reads. The consumer (and its RTP stream to the ports ffmpeg will bind) is opened once and kept
     * across ffmpeg restarts, so only one egress consumer exists per output run.
     */
    async prepareWebrtc() {
        if (this.sdpPath && this.egressHandle) return { ok: true };
        if (!this.egressBase || !this.sessionId) return { ok: false, error: 'no WebRTC egress endpoint for this session' };
        let res;
        try {
            const port = await allocateUdpPortPair();
            const r = await this.fetchImpl(`${this.egressBase}/rtp/${this.sessionId}?vport=${port}&aport=${port + 2}`, { signal: AbortSignal.timeout(8000) });
            if (!r.ok) { const body = await r.json().catch(() => ({})); return { ok: false, error: `WebRTC source not ready (${body.error || r.status})` }; }
            res = await r.json();
        } catch (err) {
            return { ok: false, error: `WebRTC egress request failed: ${err.message}` };
        }
        const sdpPath = path.join(os.tmpdir(), `openre-restream-${this.outputId}.sdp`);
        try { fs.writeFileSync(sdpPath, res.sdp, 'utf8'); } catch (err) { return { ok: false, error: `SDP not writable: ${err.message}` }; }
        this.sdpPath = sdpPath;
        this.egressHandle = res.handle;
        this.hasAudio = Array.isArray(res.transports) && res.transports.length > 1;
        return { ok: true };
    }

    async cleanupEgress() {
        if (this.egressHandle && this.egressBase) { try { await this.fetchImpl(`${this.egressBase}/rtp/${this.sessionId}/${this.egressHandle}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }); } catch { /* best effort */ } }
        this.egressHandle = null;
        if (this.sdpPath) { try { fs.unlinkSync(this.sdpPath); } catch { /* gone */ } this.sdpPath = null; }
    }

    spawn(destUrl) {
        const args = withProgress(this.source === 'jsmpeg'
            ? jsmpegArgs(this.inputUrl, destUrl, this.preset || resolvePreset({}), this.overrides ? { overrides: this.overrides } : {})
            : this.source === 'webrtc'
                ? webrtcArgs(this.sdpPath, destUrl, this.preset || resolvePreset({}), { hasAudio: this.hasAudio, overrides: this.overrides || {} })
                : rtmpCopyArgs(this.inputUrl, destUrl));
        const rtmps = destUrl.startsWith('rtmps://');
        const bin = rtmps && this.o.ffmpegOpenSslPath && fs.existsSync(this.o.ffmpegOpenSslPath) ? this.o.ffmpegOpenSslPath : this.o.ffmpegPath;
        this.note('info', `starting ffmpeg → ${redactUrl(destUrl)}${bin !== this.o.ffmpegPath ? ' (openssl build)' : ''}`);
        let proc;
        try {
            proc = this.spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            this.onExit(null, `spawn failed: ${err.message}`);
            return;
        }
        this.proc = proc;
        const startedAt = Date.now();
        this.startedAt = startedAt;
        this.liveThisRun = false;
        this.status = 'starting';
        this.report({ state: 'starting', started_at: startedAt, restart_attempts: this.restartAttempts, next_restart_at: null });

        let stderr = '';
        let progressBuf = '';
        let progressSeen = false;
        const cur = {};
        proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 4096) stderr = stderr.slice(-4096); });
        proc.stdout.on('data', (d) => {
            progressBuf += d.toString();
            if (progressBuf.length > 8192) progressBuf = progressBuf.slice(-8192);
            let nl;
            while ((nl = progressBuf.indexOf('\n')) >= 0) {
                const line = progressBuf.slice(0, nl).trim();
                progressBuf = progressBuf.slice(nl + 1);
                const eq = line.indexOf('=');
                if (eq <= 0) continue;
                const k = line.slice(0, eq);
                const val = line.slice(eq + 1).trim();
                if (k === 'frame') cur.frame = +val || 0;
                else if (k === 'fps') cur.fps = +val || 0;
                else if (k === 'bitrate') cur.bitrate_kbps = val.endsWith('kbits/s') ? +parseFloat(val) || 0 : null;
                else if (k === 'speed') cur.speed = val === 'N/A' ? null : +parseFloat(val) || 0;
                else if (k === 'drop_frames') cur.dropped = +val || 0;
                else if (k === 'out_time_us' || k === 'out_time_ms') cur.out_ms = Math.round((+val || 0) / 1000);
                else if (k === 'progress') {
                    progressSeen = true;
                    cur.at = Date.now();
                    if (!this.liveThisRun && ((cur.frame || 0) > 0 || (cur.out_ms || 0) > 0)) this.confirmLive(proc);
                    if (Date.now() - this.lastProgressReport > 2000) {
                        this.lastProgressReport = Date.now();
                        this.report({ progress: { ...cur } });
                    }
                }
            }
        });
        proc.on('error', (err) => { if (this.proc === proc) this.onExit(null, `ffmpeg error: ${err.message}`); });
        proc.on('close', (code) => {
            if (this.proc !== proc) return;
            const lastLines = stderr.split('\n').filter(Boolean).slice(-5).join(' | ');
            this.onExit(code, lastLines);
        });
        // No progress at all within the ACK window: the ingest never took our data.
        this.timer(() => {
            if (this.proc !== proc || this.liveThisRun || this.stopped) return;
            if (progressSeen) { this.confirmLive(proc); return; }
            this.ackTimeout = true;
            this.note('warn', `no response from the ingest within ${this.o.liveAckTimeoutMs / 1000}s`);
            try { proc.kill('SIGTERM'); } catch { /* */ }
        }, this.o.liveAckTimeoutMs);
    }

    async confirmLive(proc) {
        if (this.proc !== proc || this.liveThisRun || this.stopped) return;
        this.liveThisRun = true;
        this.everLive = true;
        this.rapidCrashCount = 0;
        this.status = 'live';
        try { await this.store.outputs.clearDestinationCooldown(this.destinationId); } catch { /* */ }
        this.report({ state: 'live', live_at: Date.now(), last_error: null });
        this.note('info', 'output is live');
        this.timer(() => {
            if (this.proc === proc && this.status === 'live') {
                this.restartAttempts = 0;
                this.restartDelay = this.o.restartBaseMs;
                this.rapidCrashCount = 0;
                this.report({ restart_attempts: 0 });
            }
        }, this.o.stableMs);
    }

    onExit(code, raw) {
        this.proc = null;
        if (this.stopped) return;
        const ran = Date.now() - (this.startedAt || Date.now());
        if (code === 0) {
            this.status = 'stopped';
            this.note('info', `ffmpeg exited cleanly after ${(ran / 1000).toFixed(1)}s`);
            // A clean exit means the source ended; the session transition stops the output.
            this.report({ state: 'stopped', ended_at: Date.now() });
            this.stopped = true;
            return;
        }
        const message = this.scrub(this.ackTimeout
            ? `No response from the ingest within ${this.o.liveAckTimeoutMs / 1000}s — ${friendlyError(raw, this.platform)}`
            : friendlyError(raw || `ffmpeg exit code ${code}`, this.platform));
        this.ackTimeout = false;
        this.note('error', `ffmpeg exited (code ${code}) after ${(ran / 1000).toFixed(1)}s: ${message}`);
        this.status = 'error';
        this.report({ state: 'error', last_error: message });
        this.scheduleRestart(ran, message);
    }

    scheduleRestart(ranMs, message) {
        if (this.stopped) return;
        if (this.restartAttempts >= this.o.maxRestarts) return this.fail(`${message} (gave up after ${this.o.maxRestarts} restarts)`, { cooldown: !this.everLive });
        if (!this.liveThisRun && ranMs < this.o.rapidCrashMs) {
            this.rapidCrashCount++;
            this.restartDelay = Math.min(this.restartDelay * 2, this.o.restartMaxMs);
        } else {
            this.rapidCrashCount = 0;
        }
        if (this.rapidCrashCount >= this.o.rapidCrashGiveUp && !this.everLive) {
            return this.fail(`${message} (${this.rapidCrashCount} rapid crashes without ever going live)`, { cooldown: true });
        }
        const delay = this.restartDelay;
        this.restartDelay = Math.min(this.restartDelay * 1.5, this.o.restartMaxMs);
        this.restartAttempts++;
        this.report({ restart_attempts: this.restartAttempts, next_restart_at: Date.now() + delay });
        this.timer(() => { this.start().catch(err => this.fail(err.message, { cooldown: false })); }, delay);
        return undefined;
    }

    /** The circuit breaker: this output is done; the destination may cool down. */
    async fail(message, { cooldown }) {
        if (this.stopped) return;
        message = this.scrub(message);
        this.stopped = true;
        this.clearTimers();
        let cooldownMinutes = null;
        if (cooldown) {
            const r = await this.store.outputs.markDestinationFailure(this.destinationId, message);
            cooldownMinutes = r ? r.cooldownMinutes : null;
        }
        this.status = 'failed';
        this.note('error', `output failed: ${message}${cooldownMinutes ? ` (destination cooling down ${cooldownMinutes} min)` : ''}`);
        this.report({ state: 'failed', last_error: message, ended_at: Date.now(), next_restart_at: null, cooldown_minutes: cooldownMinutes });
        this.cleanupEgress().catch(() => {});
    }

    stop(reason = 'stopped') {
        if (this.stopped && !this.proc) return;
        this.stopped = true;
        this.clearTimers();
        this.cleanupEgress().catch(() => {});
        const proc = this.proc;
        this.proc = null;
        if (proc) {
            try { proc.kill('SIGTERM'); } catch { /* */ }
            const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } }, 5000);
            t.unref?.();
        }
        this.status = 'stopped';
        this.note('info', `output stopped (${reason})`);
        this.report({ state: 'stopped', ended_at: Date.now(), next_restart_at: null });
    }

    clearTimers() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
}

module.exports = { OutputRunner };
