#!/usr/bin/env node
/**
 * Local mock TCP/TLS AMT stand-in for hardware-free end-to-end verification of
 * the macOS app's full stack: node-shim.js -> NetworkBridge -> real socket ->
 * this server -> back through digest math, HTTP framing, and base64 round-trip.
 *
 * Speaks just enough of AMT's WSMAN-over-HTTP-Digest protocol to be useful:
 *   1. First request on a connection with no Authorization header -> 401 with
 *      a WWW-Authenticate: Digest challenge (realm/nonce/qop=auth), matching
 *      what triggers finding #1 (hex_md5) in the real client.
 *   2. Request with an Authorization header -> recomputes the expected RFC
 *      2617 digest response server-side (same formula amt-wsman-node-0.2.0.js
 *      uses) and compares it; on match, returns a canned WSMAN SOAP body.
 *
 * Point the built macOS app at 127.0.0.1:<port> with tls=0, and
 * 127.0.0.1:<tlsPort> with tls=1 (self-signed cert generated on the fly via
 * the system `openssl` CLI - not checked into the repo).
 *
 * Usage:
 *   node Scripts/mock-amt-server.js [--port 16992] [--tls-port 16993]
 *                                    [--user admin] [--pass password]
 *                                    [--no-tls] [--no-plain]
 */

'use strict';

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
    const args = { port: 16992, tlsPort: 16993, user: 'admin', pass: 'Passw0rd!', noTls: false, noPlain: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--port') args.port = parseInt(argv[++i], 10);
        else if (a === '--tls-port') args.tlsPort = parseInt(argv[++i], 10);
        else if (a === '--user') args.user = argv[++i];
        else if (a === '--pass') args.pass = argv[++i];
        else if (a === '--no-tls') args.noTls = true;
        else if (a === '--no-plain') args.noPlain = true;
        else if (a === '--help') { printHelp(); process.exit(0); }
        else throw new Error('Unknown argument: ' + a + ' (see --help)');
    }
    return args;
}

function printHelp() {
    console.log('Usage: node Scripts/mock-amt-server.js [--port 16992] [--tls-port 16993] [--user admin] [--pass password] [--no-tls] [--no-plain]');
}

const REALM = 'Digest:0000000000000000000000000000ABCD';
const NONCE = crypto.randomBytes(16).toString('hex');

const CANNED_BODY = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<a:Envelope xmlns:a="http://www.w3.org/2003/05/soap-envelope" xmlns:b="http://schemas.xmlsoap.org/ws/2004/08/addressing">'
    + '<a:Header><b:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</b:To></a:Header>'
    + '<a:Body><g:PullResponse xmlns:g="http://schemas.xmlsoap.org/ws/2004/09/enumeration">'
    + '<g:Items><MockAmtServer xmlns="mock-amt-server">OK</MockAmtServer></g:Items>'
    + '<g:EndOfSequence/></g:PullResponse></a:Body></a:Envelope>';

function md5hex(s) {
    return crypto.createHash('md5').update(s, 'binary').digest('hex');
}

function parseRequestLine(headerLines) {
    const directive = headerLines[0].split(' '); // ['POST', '/wsman', 'HTTP/1.1']
    const headers = {};
    for (let i = 1; i < headerLines.length; i++) {
        const idx = headerLines[i].indexOf(':');
        if (idx < 0) continue;
        headers[headerLines[i].substring(0, idx).toLowerCase()] = headerLines[i].substring(idx + 2);
    }
    return { method: directive[0], url: directive[1], headers };
}

// Mirrors correctedQuoteSplit()/parseDigest() in amt-wsman-node-0.2.0.js: split on commas
// but not inside quoted values, then split each piece on '=' and strip surrounding quotes.
function parseDigestAuthorization(value) {
    const body = value.replace(/^Digest\s+/, '');
    const parts = body.split(',').reduce(function (acc, chunk) {
        if (acc.inQuotes) { acc.list[acc.list.length - 1] += ',' + chunk; } else { acc.list.push(chunk); }
        if (((chunk.split('"').length - 1) % 2) === 1) acc.inQuotes = !acc.inQuotes;
        return acc;
    }, { list: [], inQuotes: false }).list;

    const out = {};
    for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq < 0) continue;
        const key = p.substring(0, eq).trim();
        let val = p.substring(eq + 1).trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        out[key] = val;
    }
    return out;
}

// Same formula as amt-wsman-node-0.2.0.js:134 (qop=auth branch, no auth-int/body hashing).
function expectedDigestResponse(user, pass, method, uri, params) {
    const ha1 = md5hex(user + ':' + params.realm + ':' + pass);
    const ha2 = md5hex(method + ':' + uri);
    return md5hex(ha1 + ':' + params.nonce + ':' + params.nc + ':' + params.cnonce + ':' + params.qop + ':' + ha2);
}

function handleConnection(socket, args, label) {
    let acc = '';
    let parseState = 0; // 0 = reading headers, 1 = reading body
    let parsed = null;
    let contentLength = 0;

    socket.setEncoding('binary');

    function respond(status, statusText, extraHeaders, body) {
        body = body || '';
        let head = 'HTTP/1.1 ' + status + ' ' + statusText + '\r\n';
        head += 'Server: Intel(R) Active Management Technology 15.0.65\r\n';
        for (const k in extraHeaders) head += k + ': ' + extraHeaders[k] + '\r\n';
        head += 'Content-Length: ' + Buffer.byteLength(body, 'binary') + '\r\n\r\n';
        socket.write(Buffer.from(head + body, 'binary'));
    }

    function challenge() {
        respond(401, 'Unauthorized', { 'WWW-Authenticate': 'Digest realm="' + REALM + '",nonce="' + NONCE + '",qop="auth"' }, '');
    }

    function handleRequest(req, body) {
        const authHeader = req.headers['authorization'];
        console.log('[' + label + '] ' + req.method + ' ' + req.url + (authHeader ? ' (Authorization present)' : ' (no Authorization, challenging)'));
        if (!authHeader) { challenge(); return; }

        const params = parseDigestAuthorization(authHeader);
        const expected = expectedDigestResponse(args.user, args.pass, req.method, req.url, params);
        if (params.realm !== REALM || params.nonce !== NONCE || params.response !== expected) {
            console.log('[' + label + '] digest mismatch (bad credentials or stale nonce) - re-challenging');
            challenge();
            return;
        }
        respond(200, 'OK', {}, CANNED_BODY);
    }

    socket.on('data', function (data) {
        acc += data;
        while (true) {
            if (parseState === 0) {
                const headerEnd = acc.indexOf('\r\n\r\n');
                if (headerEnd < 0) return;
                const headerLines = acc.substring(0, headerEnd).split('\r\n');
                acc = acc.substring(headerEnd + 4);
                parsed = parseRequestLine(headerLines);
                contentLength = parseInt(parsed.headers['content-length'] || '0', 10) || 0;
                parseState = 1;
            }
            if (parseState === 1) {
                if (acc.length < contentLength) return;
                const body = acc.substring(0, contentLength);
                acc = acc.substring(contentLength);
                parseState = 0;
                handleRequest(parsed, body);
            }
        }
    });

    socket.on('error', function (err) { console.log('[' + label + '] socket error: ' + err.message); });
}

function generateSelfSignedCert() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mock-amt-'));
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1',
    ], { stdio: 'ignore' });
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    console.log('Mock AMT server - realm=' + REALM);
    console.log('Credentials: ' + args.user + ' / ' + args.pass);

    if (!args.noPlain) {
        const server = net.createServer(function (socket) { handleConnection(socket, args, 'tcp:' + args.port); });
        server.listen(args.port, '127.0.0.1', function () {
            console.log('Plain TCP listening on 127.0.0.1:' + args.port + ' - use this host/port with tls=0');
        });
    }

    if (!args.noTls) {
        const { key, cert } = generateSelfSignedCert();
        const tlsServer = tls.createServer({ key, cert }, function (socket) { handleConnection(socket, args, 'tls:' + args.tlsPort); });
        tlsServer.listen(args.tlsPort, '127.0.0.1', function () {
            console.log('TLS listening on 127.0.0.1:' + args.tlsPort + ' - use this host/port with tls=1 (self-signed; first connect trusts-on-first-use via the app\'s own fingerprint pinning)');
        });
    }
}

main();
