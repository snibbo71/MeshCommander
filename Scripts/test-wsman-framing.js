#!/usr/bin/env node
/**
 * Hardware-free unit test for amt-wsman-node-0.2.0.js.
 *
 * Loads the vendor file completely unmodified into a real Node vm context
 * (not the WKWebView node-shim - this exercises the actual HTTP framing/
 * reassembly state machine and HTTP Digest auth against Node's real net/tls/
 * constants modules) and feeds it hand-crafted HTTP responses directly via
 * xxOnSocketData(), without opening any real socket.
 *
 * Also regression-tests build plan finding #1: hex_md5 (required for Digest
 * auth, amt-wsman-node-0.2.0.js:134) doesn't exist in the base amt-0.2.0.js -
 * only in the localized variants behind the Certificates marker. This loads
 * the real shipped MeshCommanderMac/Resources/md5-shim.js (backed by the real
 * shipped forge.bundle.js) exactly as production does, so a regression here
 * (e.g. someone "helpfully" removing md5-shim.js) fails this test.
 *
 * Usage: node Scripts/test-wsman-framing.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const WSMAN_NODE_JS = path.join(REPO_ROOT, 'amt-wsman-node-0.2.0.js');
const FORGE_BUNDLE_JS = path.join(REPO_ROOT, 'forge.js', 'forge.bundle.js');
const MD5_SHIM_JS = path.join(REPO_ROOT, 'MeshCommanderMac', 'Resources', 'md5-shim.js');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
    if (condition) {
        passCount++;
    } else {
        failCount++;
        console.error('FAIL: ' + message);
    }
}

function makeContext() {
    const forge = require(FORGE_BUNDLE_JS).forge;
    const sandbox = {
        require,          // real Node require - amt-wsman-node-0.2.0.js only pulls in net/tls/crypto/constants
        console,
        setTimeout,
        clearTimeout,
        Buffer,
        atob: (s) => Buffer.from(s, 'binary').toString('base64'),
        btoa: (s) => Buffer.from(s, 'base64').toString('binary'),
        urlvars: {},      // referenced by xxOnSocketData for optional wsman trace logging
        forge,
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(WSMAN_NODE_JS, 'utf8'), sandbox, { filename: 'amt-wsman-node-0.2.0.js' });
    vm.runInContext(fs.readFileSync(MD5_SHIM_JS, 'utf8'), sandbox, { filename: 'md5-shim.js' });
    assert(typeof sandbox.CreateWsmanComm === 'function', 'CreateWsmanComm should be defined after loading amt-wsman-node-0.2.0.js');
    assert(typeof sandbox.hex_md5 === 'function', 'hex_md5 should be defined after loading md5-shim.js (finding #1)');
    return sandbox;
}

function newComm(sandbox) {
    const comm = sandbox.CreateWsmanComm('127.0.0.1', 16992, 'admin', 'password', 0, null);
    // Normally set up by xxConnectHttpSocket() right before a real connection is opened.
    // These tests drive xxOnSocketData() directly without ever connecting, so they must
    // prime the same state by hand or socketParseState/socketAccumulator stay undefined.
    comm.socketParseState = 0;
    comm.socketAccumulator = '';
    comm.socketHeader = null;
    comm.socketData = '';
    return comm;
}

// --- Test 1: Content-Length framing, delivered in one shot ---
function testContentLengthSingleShot(sandbox) {
    const comm = newComm(sandbox);
    let got = null;
    comm.pendingAjaxCall.push(['<Envelope/>', function (data, status) { got = { data, status }; }, null, '/wsman', 'POST']);

    const body = '<Envelope><Body>hello</Body></Envelope>';
    const resp = 'HTTP/1.1 200 OK\r\nServer: Intel(R) Active Management Technology 15.0.10\r\nContent-Length: ' + body.length + '\r\n\r\n' + body;
    comm.xxOnSocketData(resp);

    assert(got !== null, 'Content-Length response should invoke the pending callback');
    assert(got && got.status === 200, 'Content-Length response should report status 200');
    assert(got && got.data === body, 'Content-Length response body should be reassembled exactly');
    assert(comm.amtVersion === '15.0.10', 'AMT version should be parsed from the Server header');
}

// --- Test 2: Content-Length framing, split across multiple socket reads ---
function testContentLengthSplitAcrossReads(sandbox) {
    const comm = newComm(sandbox);
    let got = null;
    comm.pendingAjaxCall.push(['<Envelope/>', function (data, status) { got = { data, status }; }, null, '/wsman', 'POST']);

    const body = '<Envelope><Body>' + 'x'.repeat(500) + '</Body></Envelope>';
    const resp = 'HTTP/1.1 200 OK\r\nContent-Length: ' + body.length + '\r\n\r\n' + body;

    // Feed it in three ragged pieces, including one split mid-header and one mid-body.
    const cut1 = 10;
    const cut2 = resp.indexOf('\r\n\r\n') + 4 + 50;
    comm.xxOnSocketData(resp.slice(0, cut1));
    assert(got === null, 'callback should not fire until the full header + body has arrived');
    comm.xxOnSocketData(resp.slice(cut1, cut2));
    assert(got === null, 'callback should not fire with only part of the body received');
    comm.xxOnSocketData(resp.slice(cut2));

    assert(got !== null, 'callback should fire once the full response has arrived across multiple reads');
    assert(got && got.data === body, 'body reassembled across ragged reads should match exactly');
}

// --- Test 3: chunked Transfer-Encoding framing ---
function testChunkedFraming(sandbox) {
    const comm = newComm(sandbox);
    let got = null;
    comm.pendingAjaxCall.push(['<Envelope/>', function (data, status) { got = { data, status }; }, null, '/wsman', 'POST']);

    const chunk1 = 'Hello, ';
    const chunk2 = 'AMT world!';
    const resp = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'
        + chunk1.length.toString(16) + '\r\n' + chunk1 + '\r\n'
        + chunk2.length.toString(16) + '\r\n' + chunk2 + '\r\n'
        + '0\r\n\r\n';
    comm.xxOnSocketData(resp);

    assert(got !== null, 'chunked response should invoke the pending callback');
    assert(got && got.data === chunk1 + chunk2, 'chunked response body should be reassembled in order');
}

// --- Test 4: 401 digest challenge parsing + retry wiring ---
function test401DigestChallenge(sandbox) {
    const comm = newComm(sandbox);
    comm.pendingAjaxCall.push(['<Envelope/>', function () {}, null, '/wsman', 'POST']);

    let socketEnded = false;
    comm.socket = { end: function () { socketEnded = true; } };

    const resp = 'HTTP/1.1 401 Unauthorized\r\n'
        + 'WWW-Authenticate: Digest realm="Digest:A4074B0B554DAA138882AB026F2C4F72", '
        + 'nonce="AAAAAAmMFqQAAAAAgD7EW6zEnU56JBGRoQ==", qop="auth"\r\n'
        + 'Content-Length: 0\r\n\r\n';
    comm.xxOnSocketData(resp);

    assert(comm.challengeParams !== null, '401 response should populate challengeParams');
    assert(comm.challengeParams && comm.challengeParams.realm === 'Digest:A4074B0B554DAA138882AB026F2C4F72', 'realm should be parsed out of WWW-Authenticate');
    assert(comm.challengeParams && comm.challengeParams.qop === 'auth', 'qop should be parsed out of WWW-Authenticate');
    assert(socketEnded, 'processing a 401 should end the socket so the client can reconnect and retry with credentials');
}

// --- Test 5: sendRequest's digest math must not throw once challenged (finding #1) ---
function testDigestSendDoesNotThrow(sandbox) {
    const comm = newComm(sandbox);
    comm.challengeParams = { realm: 'Digest:A4074B0B554DAA138882AB026F2C4F72', nonce: 'AAAAAAmMFqQAAAAAgD7EW6zEnU56JBGRoQ==', qop: 'auth' };
    comm.socketState = 2;
    let sent = null;
    comm.socket = { write: function (buf) { sent = buf.toString('binary'); } };

    let threw = null;
    try {
        comm.sendRequest('<Envelope/>', '/wsman', 'POST');
    } catch (ex) {
        threw = ex;
    }

    assert(threw === null, 'sendRequest must not throw once a Digest challenge is active (regression test for finding #1: hex_md5 missing => ReferenceError)');
    assert(sent !== null, 'sendRequest should have written a request to the socket');
    assert(sent && sent.indexOf('Authorization: Digest') >= 0, 'the request written after a challenge should carry a Digest Authorization header');
    assert(sent && sent.indexOf('response="') >= 0, 'the Digest Authorization header should carry a computed response hash');
}

function main() {
    const sandbox = makeContext();
    testContentLengthSingleShot(sandbox);
    testContentLengthSplitAcrossReads(sandbox);
    testChunkedFraming(sandbox);
    test401DigestChallenge(sandbox);
    testDigestSendDoesNotThrow(sandbox);

    console.log('\n' + passCount + ' passed, ' + failCount + ' failed');
    if (failCount > 0) process.exit(1);
}

main();
