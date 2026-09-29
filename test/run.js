#!/usr/bin/env node
/**
 * Runs every test in test/ — the files named *.test.js — each in its own process, and fails
 * if any of them fails. They use temp databases (PGlite in memory), generated RSA keys and stub subscribers
 * on random ports; none of them needs the network or a running OpenVibe.Network. The RTMP end-to-end test uses
 * the system ffmpeg and prints `rtmp-e2e: skipped (no ffmpeg on PATH)` when it is missing.
 *
 *   npm test                   # everything
 *   npm test -- publish sse    # only files whose name contains one of the words
 *   npm test -- --strict       # a skipped test fails the run too
 *
 * A test that cannot run something here prints `<label>: skipped (<why>)`: that file is listed with
 * ○ and not counted as passed (openvibe-shared/test-runner).
 */
'use strict';
require('openvibe-shared/test-runner').main({ dir: __dirname, timeoutMs: 180000, pad: 32, parallel: 1 });
