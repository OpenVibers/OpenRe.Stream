'use strict';
/**
 * WHIP SDP <-> mediasoup bridging, ported from OpenVibe.Live server/streaming/whip-handler.js
 * (offer validation, DTLS parameter extraction, RTP parameter extraction against the router's
 * capabilities, and the answer builder). The Live-specific stream-row code is not ported: OpenRe
 * validates the offer, negotiates codecs and builds the answer, and nothing here touches a database.
 *
 * `sdp-transform` is required lazily so the module (and the whole worker) can be loaded — and its
 * string-only helpers tested — on a host where the dependency is not installed yet; `available()`
 * says whether parsing/building is possible at all, which is what the worker checks at start.
 */
let sdpTransform = null;

function load() {
    if (!sdpTransform) sdpTransform = require('sdp-transform');
    return sdpTransform;
}

function available() {
    try { load(); return true; } catch { return false; }
}

function parse(sdp) {
    return load().parse(sdp);
}

function write(obj) {
    return load().write(obj);
}

/** The DTLS setup attribute of the offer (top-level or first media section that has one). */
function getDtlsSetupAttribute(sdpObj) {
    if (sdpObj.setup) return String(sdpObj.setup).toLowerCase();
    for (const media of sdpObj.media || []) if (media.setup) return String(media.setup).toLowerCase();
    return null;
}

/** sha-256 is preferred over sha-1, exactly as Live's WHIP handler picks it. */
function selectDtlsFingerprint(fingerprints) {
    if (!Array.isArray(fingerprints) || fingerprints.length === 0) throw new Error('No DTLS fingerprints available');
    const normalized = fingerprints.map(fp => ({ algorithm: String(fp.algorithm || '').toLowerCase(), fingerprint: fp }));
    for (const algorithm of ['sha-256', 'sha-1']) {
        const match = normalized.find(item => item.algorithm === algorithm);
        if (match) return match.fingerprint;
    }
    return fingerprints[0];
}

/** transport.connect()'s remote role: an offer with setup=passive means the remote side is the DTLS server. */
function extractDtlsParameters(sdpObj) {
    let fingerprint = sdpObj.fingerprint;
    const setup = getDtlsSetupAttribute(sdpObj);
    for (const media of sdpObj.media || []) if (!fingerprint && media.fingerprint) fingerprint = media.fingerprint;
    if (!fingerprint) throw new Error('No DTLS fingerprint in SDP');
    return {
        role: setup === 'passive' ? 'server' : 'client',
        fingerprints: [{ algorithm: fingerprint.type, value: fingerprint.hash }],
    };
}

function h264ProfileIdc(profileLevelId) {
    const profile = String(profileLevelId || '').trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(profile) || profile.length < 2) return null;
    return profile.slice(0, 2);
}

function normalizeH264ProfileLevelId(offeredParams, routerParams) {
    const off = h264ProfileIdc(offeredParams && offeredParams['profile-level-id']);
    const rc = h264ProfileIdc(routerParams && routerParams['profile-level-id']);
    if (!off || !rc || off !== rc) return false;
    if (routerParams && routerParams['profile-level-id']) offeredParams['profile-level-id'] = routerParams['profile-level-id'];
    return true;
}

/**
 * RTP parameters for one media section, codecs matched against the router's capabilities. Throws
 * { code: 'invalid_rtp_encoding' } when the section names no usable encoding (Live does the same).
 */
function extractRtpParameters(media, routerCapabilities, mediaIndex = 0) {
    if (!media || !media.type) return null;
    const routerCodecs = routerCapabilities.codecs || [];
    const codecs = [];
    const headerExtensions = [];
    const encodings = [];

    const rtpmaps = {};
    for (const rtp of media.rtp || []) {
        rtpmaps[rtp.payload] = {
            mimeType: `${media.type}/${rtp.codec}`,
            payloadType: rtp.payload,
            clockRate: rtp.rate,
            channels: rtp.encoding || undefined,
            parameters: {},
            rtcpFeedback: [],
        };
    }
    for (const fmtp of media.fmtp || []) {
        const target = rtpmaps[fmtp.payload];
        if (!target || !fmtp.config) continue;
        const params = {};
        for (const part of fmtp.config.split(';')) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) {
                const key = trimmed.slice(0, eqIdx).trim();
                const val = trimmed.slice(eqIdx + 1).trim();
                if (key === 'profile-level-id' || key === 'sprop-parameter-sets' || key === 'level-asymmetry-allowed') params[key] = val;
                else params[key] = /^\d+$/.test(val) ? parseInt(val, 10) : val;
            }
        }
        target.parameters = params;
    }
    for (const fb of media.rtcpFb || []) {
        if (rtpmaps[fb.payload]) rtpmaps[fb.payload].rtcpFeedback.push({ type: fb.type, parameter: fb.subtype || '' });
    }

    const payloads = (media.payloads || '').toString().split(' ').map(Number).filter(n => !isNaN(n));
    let primaryCodec = null;
    for (const pt of payloads) {
        const offered = rtpmaps[pt];
        if (!offered) continue;
        if (offered.mimeType.toLowerCase().endsWith('/rtx')) continue;
        const match = routerCodecs.find(rc => {
            if (rc.mimeType.toLowerCase() !== offered.mimeType.toLowerCase()) return false;
            if (rc.clockRate !== offered.clockRate) return false;
            if (offered.channels && rc.channels && offered.channels !== rc.channels) return false;
            if (rc.mimeType.toLowerCase() === 'video/h264') {
                const rcIdc = h264ProfileIdc(rc.parameters && rc.parameters['profile-level-id']);
                const offIdc = h264ProfileIdc(offered.parameters && offered.parameters['profile-level-id']);
                if (rcIdc && offIdc && rcIdc !== offIdc) return false;
                if (rcIdc && offIdc) normalizeH264ProfileLevelId(offered.parameters, rc.parameters || {});
            }
            return true;
        });
        if (match) { primaryCodec = offered; codecs.push(offered); break; }
    }
    if (!primaryCodec) return null;

    for (const pt of payloads) {
        const offered = rtpmaps[pt];
        if (!offered) continue;
        if (offered.mimeType.toLowerCase() === `${media.type}/rtx` && offered.parameters && offered.parameters.apt === primaryCodec.payloadType) { codecs.push(offered); break; }
    }

    for (const ext of media.ext || []) {
        const routerExt = (routerCapabilities.headerExtensions || []).find(re => re.uri === ext.uri && (re.kind === media.type || !re.kind));
        if (routerExt) headerExtensions.push({ uri: ext.uri, id: ext.value, encrypt: false, parameters: {} });
    }

    const ssrcEntries = Array.isArray(media.ssrcs) ? media.ssrcs.filter(Boolean) : (media.ssrc ? [media.ssrc] : []);
    const normalizeSsrc = (v) => (v === undefined || v === null ? null : (Number.isFinite(Number(v)) ? Number(v) : String(v)));
    const mainSsrc = (ssrcEntries.find(s => s.attribute === 'cname') || ssrcEntries[0] || {}).id;
    let encoding = null;
    if (mainSsrc) {
        encoding = { ssrc: normalizeSsrc(mainSsrc) };
        const fidGroup = (media.ssrcGroups || []).find(g => g.semantics === 'FID' || g.semantics === 'fid');
        if (fidGroup && typeof fidGroup.ssrcs === 'string') {
            const parts = fidGroup.ssrcs.split(' ').map(s => s.trim()).filter(Boolean);
            if (parts.length >= 2 && String(normalizeSsrc(parts[0])) === String(encoding.ssrc)) encoding.rtx = { ssrc: normalizeSsrc(parts[1]) };
        }
    } else if (Array.isArray(media.rids) && media.rids.length > 0) {
        const ridValue = media.rids[0].id || media.rids[0];
        if (ridValue) encoding = { rid: String(ridValue) };
    } else if (media.rid) {
        encoding = { rid: String(media.rid) };
    }
    if (!encoding) {
        const error = new Error('No RTP encoding found in SDP media section');
        error.code = 'invalid_rtp_encoding';
        error.mediaType = media.type;
        error.mid = media.mid != null ? String(media.mid) : String(mediaIndex);
        throw error;
    }
    encodings.push(encoding);

    return {
        codecs,
        headerExtensions,
        encodings,
        mid: media.mid != null ? String(media.mid) : String(mediaIndex),
    };
}

/**
 * Build the SDP answer for a WHIP ingest (server recvonly). Only *accepted* m-sections go in the
 * BUNDLE group (RFC 8843 §7.3.3), so a browser publisher whose extra section (a data channel, a
 * codec the router lacks) is rejected is not refused by its own SDP parser.
 */
function buildSdpAnswer(transport, offerSdp, producersByKind, { serverName = 'OpenRe.Stream', fallbackAddress = '127.0.0.1' } = {}) {
    const { iceParameters, iceCandidates, dtlsParameters } = transport;
    const fingerprint = selectDtlsFingerprint(dtlsParameters.fingerprints);
    const setup = getDtlsSetupAttribute(offerSdp) === 'passive' ? 'active' : 'passive';
    const bundledMids = [];
    const serverAddress = (iceCandidates && iceCandidates[0] && iceCandidates[0].ip) || fallbackAddress;

    const sdpObj = {
        version: 0,
        origin: { username: '-', sessionId: String(Date.now()), sessionVersion: 2, netType: 'IN', ipVer: 4, address: serverAddress },
        name: serverName,
        timing: { start: 0, stop: 0 },
        icelite: 'ice-lite',
        groups: [],
        msidSemantic: { semantic: 'WMS', token: '*' },
        media: [],
    };

    for (const [mediaIndex, offerMedia] of (offerSdp.media || []).entries()) {
        const mid = offerMedia.mid != null ? String(offerMedia.mid) : String(mediaIndex);
        const producer = producersByKind[offerMedia.type];
        if (!producer) {
            sdpObj.media.push({
                type: offerMedia.type,
                port: 0,
                protocol: offerMedia.protocol || 'UDP/TLS/RTP/SAVPF',
                payloads: String(offerMedia.payloads || '0'),
                mid,
                direction: 'inactive',
            });
            continue;
        }
        bundledMids.push(mid);
        const answerMedia = {
            type: offerMedia.type,
            port: 9,
            protocol: offerMedia.protocol || 'UDP/TLS/RTP/SAVPF',
            payloads: '',
            connection: { ip: '0.0.0.0', version: 4 },
            mid,
            iceUfrag: iceParameters.usernameFragment,
            icePwd: iceParameters.password,
            fingerprint: { type: fingerprint.algorithm, hash: fingerprint.value },
            setup,
            direction: 'recvonly',
            rtcpMux: 'rtcp-mux',
            rtp: [],
            fmtp: [],
            rtcpFb: [],
            ext: [],
            candidates: (iceCandidates || []).map(c => {
                const cand = { foundation: c.foundation, component: 1, transport: c.protocol.toUpperCase(), priority: c.priority, ip: c.ip, port: c.port, type: c.type };
                if (c.tcpType) cand.tcptype = c.tcpType;
                return cand;
            }),
        };
        const pts = [];
        for (const codec of producer.rtpParameters.codecs) {
            pts.push(codec.payloadType);
            answerMedia.rtp.push({ payload: codec.payloadType, codec: codec.mimeType.split('/')[1], rate: codec.clockRate, encoding: codec.channels });
            if (codec.parameters && Object.keys(codec.parameters).length > 0) {
                answerMedia.fmtp.push({ payload: codec.payloadType, config: Object.entries(codec.parameters).map(([k, v]) => `${k}=${v}`).join(';') });
            }
            for (const fb of codec.rtcpFeedback || []) answerMedia.rtcpFb.push({ payload: codec.payloadType, type: fb.type, subtype: fb.parameter || undefined });
        }
        answerMedia.payloads = pts.join(' ');
        for (const ext of producer.rtpParameters.headerExtensions || []) answerMedia.ext.push({ value: ext.id, uri: ext.uri });
        sdpObj.media.push(answerMedia);
    }

    if (bundledMids.length > 0) sdpObj.groups.push({ type: 'BUNDLE', mids: bundledMids.join(' ') });
    return write(sdpObj);
}

/** How many ICE candidates a trickle-PATCH body carries (used only for logging). */
function countCandidates(sdpText) {
    if (typeof sdpText !== 'string' || !sdpText.trim()) return 0;
    try {
        const parsed = parse(sdpText);
        return Array.isArray(parsed.media) ? parsed.media.reduce((sum, m) => sum + (Array.isArray(m.candidates) ? m.candidates.length : 0), 0) : 0;
    } catch {
        return 0;
    }
}

/**
 * The SDP a pulling ffmpeg reads for a PlainRTP egress (restream, Media's RTP recorder, thumbnails),
 * ported from Live's RestreamManager._buildSdp. `port` is the local UDP port the *consumer* (ffmpeg)
 * listens on; the worker's PlainRTP consumer is already sending to it.
 */
function buildEgressSdp({ video, audio } = {}) {
    const lines = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=OpenRe.Stream WebRTC egress', 'c=IN IP4 127.0.0.1', 't=0 0'];
    const section = (type, c, port) => {
        const pt = c.payloadType;
        const codecName = (c.mimeType || `${type}/VP8`).split('/')[1];
        if (type === 'audio') lines.push(`m=audio ${port} RTP/AVP ${pt}`);
        else lines.push(`m=video ${port} RTP/AVP ${pt}`);
        lines.push(`a=rtpmap:${pt} ${codecName}/${c.clockRate}${type === 'audio' ? `/${c.channels || 2}` : ''}`);
        if (c.ssrc) lines.push(`a=ssrc:${c.ssrc} cname:openre-${type}`);
        if (c.codecParameters && Object.keys(c.codecParameters).length) lines.push(`a=fmtp:${pt} ${Object.entries(c.codecParameters).map(([k, v]) => `${k}=${v}`).join(';')}`);
        lines.push('a=recvonly');
    };
    if (video) section('video', video, video.port);
    if (audio) section('audio', audio, audio.port);
    lines.push('');
    return lines.join('\r\n');
}

module.exports = {
    available, parse, write,
    getDtlsSetupAttribute, selectDtlsFingerprint, extractDtlsParameters, extractRtpParameters, buildSdpAnswer, countCandidates, buildEgressSdp,
};
