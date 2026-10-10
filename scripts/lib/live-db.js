'use strict';

const { createDb } = require('openvibe-sdk/db');

/** Parse a systemd EnvironmentFile without changing this process's environment. */
function parseEnvFile(text) {
    if (text == null) return null;
    return require('dotenv').parse(String(text));
}

function liveDbUrl(target, readFile) {
    if (target.startsWith('env:')) {
        const file = target.slice(4);
        const env = parseEnvFile(readFile(file));
        if (!env) throw new Error(`cannot read ${file}`);
        if (!env.DATABASE_URL) throw new Error(`${file} has no DATABASE_URL`);
        target = env.DATABASE_URL;
    }
    if (!/^postgres(ql)?:\/\//.test(target)) {
        throw new Error("Live's database is PostgreSQL; pass env:<file> or a postgres:// URL");
    }
    return target;
}

const silent = { log() {}, info() {}, warn() {}, error() {} };
function openLiveDb(url, service) { return createDb({ url, max: 1, service, log: silent }); }

module.exports = { parseEnvFile, liveDbUrl, openLiveDb };
