/**
 * node-shim.js - loaded first, before common-0.0.1.js.
 *
 * Provides just enough of a fake Node.js `require()` for the vendored
 * amt-*.js files (written for NW.js) to run unmodified inside a plain
 * WKWebView. Real socket I/O is bridged to Swift's NetworkBridge over
 * window.webkit.messageHandlers.mcNet; everything else is either an inert
 * stub (unreachable in the GUI-first Phase 1 flow) or a small local
 * implementation (crypto) backed by forge, which is already vendored for
 * the Certificates feature.
 */
(function () {
    'use strict';

    // Surfaces uncaught JS exceptions to Swift's stdout via mcNet, so a regression in
    // the huge inline startup script (easy to trigger by editing features-phaseN.json
    // without checking for unmarked cross-feature references) is visible without
    // attaching Safari's Web Inspector every time.
    window.onerror = function (message, source, lineno, colno, error) {
        try {
            window.webkit.messageHandlers.mcNet.postMessage({
                op: 'jserror',
                message: String(message),
                source: String(source),
                lineno: lineno,
                colno: colno,
                stack: (error && error.stack) ? String(error.stack) : '',
            });
        } catch (ex) { /* ignore */ }
        return false;
    };

    // ---------------------------------------------------------------------
    // byte helpers
    // ---------------------------------------------------------------------

    function bytesToHex(bin) {
        var s = '';
        for (var i = 0; i < bin.length; i++) { s += ('0' + bin.charCodeAt(i).toString(16)).slice(-2); }
        return s;
    }
    function hexToBytes(hex) {
        var s = '';
        for (var i = 0; i < hex.length; i += 2) { s += String.fromCharCode(parseInt(hex.substr(i, 2), 16)); }
        return s;
    }

    // ---------------------------------------------------------------------
    // Buffer - a real Uint8Array subclass, not just a string wrapper. Phase 1
    // only ever needed `new Buffer(str, 'binary')` right before a socket.write().
    // Phase 2/3 need real indexed byte access: amt-scanner-0.1.0.js builds RMCP
    // packets with `packet[9] = tag` and reads response bytes with `data[12]`,
    // and amt-redir-node-0.1.0.js does `new Buffer(uint8ArrayOrArray)` with no
    // encoding arg at all. Subclassing Uint8Array (like real modern Node) gives
    // both indexed access and `instanceof Buffer` for free.
    // ---------------------------------------------------------------------

    function decodeStringToBytes(str, encoding) {
        if (encoding === 'hex') return hexToBytes(str);
        if (encoding === 'base64') return atob(str);
        return str; // 'ascii'/'binary'/'latin1'/undefined - chars ARE byte values
    }

    class Buffer extends Uint8Array {
        constructor(input, encoding) {
            var isStr = typeof input === 'string';
            var bin = isStr ? decodeStringToBytes(input, encoding) : null;
            var length = isStr ? bin.length : (typeof input === 'number' ? input : (input && typeof input.length === 'number') ? input.length : 0);
            super(length);
            if (isStr) {
                for (var i = 0; i < bin.length; i++) this[i] = bin.charCodeAt(i);
            } else if (input && typeof input.length === 'number' && typeof input !== 'number') {
                for (var j = 0; j < input.length; j++) this[j] = input[j];
            }
        }
        toString(encoding) {
            var bin = '';
            for (var i = 0; i < this.length; i++) bin += String.fromCharCode(this[i]);
            if (encoding === 'base64') return btoa(bin);
            if (encoding === 'hex') return bytesToHex(bin);
            return bin;
        }
    }
    window.Buffer = Buffer;

    function bufferToBinaryString(buf) {
        if (typeof buf === 'string') return buf;
        var bin = '';
        for (var i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        return bin;
    }

    // ---------------------------------------------------------------------
    // net / tls - bridged to Swift's NetworkBridge (WKScriptMessageHandler "mcNet")
    // ---------------------------------------------------------------------

    var nextSocketId = 1;
    window.__mcNetSockets = {};

    function postNet(msg) {
        window.webkit.messageHandlers.mcNet.postMessage(msg);
    }

    function NetSocket(kind) {
        this.id = nextSocketId++;
        this.kind = kind || 'tcp'; // 'tcp' | 'tls'
        this.localAddress = '';
        this.remoteAddress = '';
        this.remotePort = 0;
        this._handlers = { data: [], close: [], timeout: [], error: [], connect: [] };
        this._peerCertificate = null;
        this._destroyed = false;
        window.__mcNetSockets[this.id] = this;
    }

    NetSocket.prototype.on = function (event, handler) {
        if (!this._handlers[event]) this._handlers[event] = [];
        this._handlers[event].push(handler);
        return this;
    };

    NetSocket.prototype.setEncoding = function () { /* we always hand back binary strings */ return this; };

    NetSocket.prototype.setNoDelay = function () { /* Swift always enables TCP_NODELAY */ return this; };

    NetSocket.prototype.setTimeout = function (ms) {
        postNet({ op: 'setTimeout', id: this.id, ms: ms });
        return this;
    };

    NetSocket.prototype.connect = function (port, host, callback) {
        if (callback) this._handlers.connect.push(callback);
        this.remoteAddress = host;
        this.remotePort = port;
        postNet({ op: 'connect', id: this.id, kind: this.kind, host: host, port: port });
        return this;
    };

    NetSocket.prototype.write = function (data) {
        var bin = (data instanceof Buffer || data instanceof Uint8Array) ? bufferToBinaryString(data) : String(data);
        postNet({ op: 'write', id: this.id, dataB64: btoa(bin) });
        return true;
    };

    NetSocket.prototype.end = function () {
        if (this._destroyed) return;
        postNet({ op: 'end', id: this.id });
    };

    NetSocket.prototype.destroy = function () {
        if (this._destroyed) return;
        this._destroyed = true;
        postNet({ op: 'destroy', id: this.id });
        delete window.__mcNetSockets[this.id];
    };

    NetSocket.prototype.getPeerCertificate = function () {
        return this._peerCertificate;
    };

    // Swift invokes this via evaluateJavaScript for every inbound socket event.
    window.__mcNetCallback = function (id, event, payload) {
        var sock = window.__mcNetSockets[id];
        if (!sock) return;
        if (event === 'connect') {
            if (payload && payload.certRawB64) {
                sock._peerCertificate = {
                    raw: { toString: function (enc) { return enc === 'base64' ? payload.certRawB64 : atob(payload.certRawB64); } },
                    fingerprint: payload.fingerprint // colon-hex, matches Node's default TLS fingerprint format
                };
            }
            sock._handlers.connect.forEach(function (h) { h(); });
        } else if (event === 'data') {
            var bin = atob(payload.dataB64);
            sock._handlers.data.forEach(function (h) { h(bin); });
        } else if (event === 'close') {
            sock._handlers.close.forEach(function (h) { h(); });
        } else if (event === 'timeout') {
            sock._handlers.timeout.forEach(function (h) { h(); });
        } else if (event === 'error') {
            var err = new Error((payload && payload.message) ? payload.message : 'socket error');
            sock._handlers.error.forEach(function (h) { h(err); });
        }
    };

    function tlsConnect(port, host, options, callback) {
        var sock = new NetSocket('tls');
        sock._tlsOptions = options || {};
        sock.connect(port, host, callback);
        return sock;
    }

    // ---------------------------------------------------------------------
    // crypto - the local computer-list persistence path (saveComputers /
    // loadComputers in index.html, reachable as soon as one computer is added)
    // uses require('crypto').randomBytes/createCipher/createDecipher for real,
    // not just amt-wsman's already-portable hex_md5 digest auth. Implemented
    // with forge (loaded earlier in the Certificates block) plus real CSPRNG
    // randomness from window.crypto. This data is only ever round-tripped by
    // this same shim, so OpenSSL byte-for-byte compatibility doesn't matter -
    // it's implemented anyway (EVP_BytesToKey/MD5) since it's no extra work.
    // ---------------------------------------------------------------------

    function evpBytesToKeyMD5(password, keyLen, ivLen) {
        var out = '', prev = '';
        while (out.length < keyLen + ivLen) {
            var md = forge.md.md5.create();
            md.update(prev + password);
            prev = md.digest().getBytes();
            out += prev;
        }
        return { key: out.substring(0, keyLen), iv: out.substring(keyLen, keyLen + ivLen) };
    }

    function algoSpec(algorithm) {
        var m = /^aes-(128|192|256)-(ctr|cbc|ofb|cfb|ecb)$/i.exec(algorithm);
        if (!m) throw new Error("node-shim crypto: unsupported cipher '" + algorithm + "'");
        var mode = m[2].toLowerCase();
        return { keyLen: parseInt(m[1], 10) / 8, ivLen: (mode === 'ecb') ? 0 : 16, mode: 'AES-' + mode.toUpperCase() };
    }

    function decodeToBytes(data, enc) {
        if (data instanceof Buffer || data instanceof Uint8Array) return bufferToBinaryString(data);
        if (enc === 'hex') return hexToBytes(data);
        if (enc === 'utf8' || enc === 'utf-8') return forge.util.encodeUtf8(data);
        return data; // 'binary'/'latin1'/undefined
    }
    function encodeFromBytes(bytes, enc) {
        if (enc === 'hex') return bytesToHex(bytes);
        if (enc === 'utf8' || enc === 'utf-8') return forge.util.decodeUtf8(bytes);
        if (enc === 'base64') return btoa(bytes);
        return bytes;
    }

    function CipherShim(algorithm, password, decrypt) {
        var spec = algoSpec(algorithm);
        var derived = evpBytesToKeyMD5(String(password), spec.keyLen, spec.ivLen);
        this._forge = decrypt ? forge.cipher.createDecipher(spec.mode, derived.key) : forge.cipher.createCipher(spec.mode, derived.key);
        this._forge.start({ iv: derived.iv });
    }
    CipherShim.prototype.update = function (data, inputEnc, outputEnc) {
        this._forge.update(forge.util.createBuffer(decodeToBytes(data, inputEnc)));
        return encodeFromBytes(this._forge.output.getBytes(), outputEnc);
    };
    CipherShim.prototype.final = function (outputEnc) {
        this._forge.finish();
        return encodeFromBytes(this._forge.output.getBytes(), outputEnc);
    };

    var cryptoStub = {
        randomBytes: function (size, callback) {
            var arr = new Uint8Array(size);
            window.crypto.getRandomValues(arr);
            var bin = '';
            for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
            var buf = new Buffer(bin);
            if (callback) { setTimeout(function () { callback(null, buf); }, 0); return undefined; }
            return buf;
        },
        createCipher: function (algorithm, password) { return new CipherShim(algorithm, password, false); },
        createDecipher: function (algorithm, password) { return new CipherShim(algorithm, password, true); },
    };

    // ---------------------------------------------------------------------
    // dgram / dns - bridged to Swift's DatagramBridge (WKScriptMessageHandler
    // "mcDgram"), a raw BSD UDP socket (not Network.framework's NWConnection,
    // whose connection-oriented model doesn't fit amt-scanner-0.1.0.js's
    // bind-once/sendto-many-peers/recvfrom-any pattern). Used only by the
    // opt-in "Scan for Computers..." feature (ComputerSelectorScanner).
    // ---------------------------------------------------------------------

    var nextDgramSocketId = 1;
    window.__mcDgramSockets = {};

    function postDgram(msg) {
        window.webkit.messageHandlers.mcDgram.postMessage(msg);
    }

    function DgramSocket() {
        this.id = nextDgramSocketId++;
        this._handlers = { message: [], listening: [], error: [], close: [] };
        window.__mcDgramSockets[this.id] = this;
    }
    DgramSocket.prototype.on = function (event, handler) {
        if (!this._handlers[event]) this._handlers[event] = [];
        this._handlers[event].push(handler);
        return this;
    };
    DgramSocket.prototype.bind = function (port) {
        postDgram({ op: 'bind', id: this.id, port: port || 0 });
        return this;
    };
    // amt-scanner-0.1.0.js always calls send(buf, offset, length, port, address).
    DgramSocket.prototype.send = function (buf, offset, length, port, address) {
        var bin = bufferToBinaryString(buf).substring(offset, offset + length);
        postDgram({ op: 'send', id: this.id, dataB64: btoa(bin), port: port, address: address });
    };
    DgramSocket.prototype.close = function () {
        postDgram({ op: 'close', id: this.id });
        delete window.__mcDgramSockets[this.id];
    };

    // Swift invokes this via evaluateJavaScript for every inbound dgram event.
    window.__mcDgramCallback = function (id, event, payload) {
        var sock = window.__mcDgramSockets[id];
        if (!sock) return;
        if (event === 'listening') {
            sock._handlers.listening.forEach(function (h) { h(); });
        } else if (event === 'message') {
            var buf = new Buffer(atob(payload.dataB64));
            var rinfo = { address: payload.address, port: payload.port, family: 'IPv4', size: buf.length };
            sock._handlers.message.forEach(function (h) { h(buf, rinfo); });
        } else if (event === 'error') {
            var err = new Error((payload && payload.message) ? payload.message : 'dgram error');
            sock._handlers.error.forEach(function (h) { h(err); });
        } else if (event === 'close') {
            sock._handlers.close.forEach(function (h) { h(); });
        }
    };

    var dgramStub = { createSocket: function () { return new DgramSocket(); } };

    var nextDnsReqId = 1;
    window.__mcDnsPending = {};
    window.__mcDnsCallback = function (reqId, payload) {
        var pending = window.__mcDnsPending[reqId];
        if (!pending) return;
        delete window.__mcDnsPending[reqId];
        if (payload && payload.error) { pending(new Error(payload.error), null); } else { pending(null, payload ? payload.domains : null); }
    };
    var dnsStub = {
        reverse: function (ip, callback) {
            var reqId = nextDnsReqId++;
            window.__mcDnsPending[reqId] = callback;
            window.webkit.messageHandlers.mcDgram.postMessage({ op: 'dnsReverse', reqId: reqId, ip: ip });
        }
    };

    // ---------------------------------------------------------------------
    // fs / os / path / util / url / http(s) / child_process - inert stubs.
    // Unreachable in the GUI-first Phase 1 flow (CRL/OCSP fetch, computer-list
    // export/import dialogs, kerberos ticket purge, log-to-file, etc. are all
    // either excluded features or optional actions the user doesn't take).
    // ---------------------------------------------------------------------

    var fsStub = {
        readFileSync: function () { var e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
        writeFileSync: function () {},
        writeFile: function (path, data, cb) { if (cb) setTimeout(cb, 0); },
        createWriteStream: function () { return { write: function () {}, end: function () {} }; },
        existsSync: function () { return false; },
    };

    var osStub = {
        platform: function () { return 'darwin'; },
        tmpdir: function () { return '/tmp'; },
        homedir: function () { return ''; },
        type: function () { return 'Darwin'; },
    };

    var pathStub = {
        join: function () { return Array.prototype.slice.call(arguments).join('/'); },
        dirname: function (p) { var i = String(p).lastIndexOf('/'); return i >= 0 ? p.substring(0, i) : '.'; },
        basename: function (p) { var i = String(p).lastIndexOf('/'); return i >= 0 ? p.substring(i + 1) : p; },
    };

    function inertHttpGet() { var req = { on: function () { return req; } }; return req; }

    // ---------------------------------------------------------------------
    // nw.gui - Phase 1 runs as a native AppKit shell, not NW.js: the real menu
    // bar, window chrome, and title come from AppKit. These stay inert so the
    // ~40 call sites scattered through index.html don't throw.
    // ---------------------------------------------------------------------

    function MenuStub() { this.items = []; }
    MenuStub.prototype.append = function (item) { this.items.push(item); return this; };
    MenuStub.prototype.insert = function (item) { this.items.push(item); return this; };
    MenuStub.prototype.createMacBuiltin = function () { return this; };

    function MenuItemStub(opts) {
        opts = opts || {};
        this.label = opts.label;
        this.type = opts.type;
        this.click = opts.click;
        this.checked = !!opts.checked;
        this.submenu = opts.submenu || null;
    }

    var nwWindowSingleton = {
        title: '',
        menu: null,
        showDevTools: function () {},
        close: function () { try { window.close(); } catch (ex) {} },
        reloadIgnoringCache: function () { location.reload(); },
    };

    var nwGuiStub = {
        App: { argv: [] },
        Window: {
            get: function () { return nwWindowSingleton; },
            open: function (url) { try { window.open(url); } catch (ex) {} },
        },
        Shell: {
            openExternal: function (url) { try { window.open(url, '_blank'); } catch (ex) {} },
        },
        Menu: MenuStub,
        MenuItem: MenuItemStub,
    };

    // ---------------------------------------------------------------------
    // process
    // ---------------------------------------------------------------------

    window.process = {
        platform: 'darwin',
        env: {},
        argv: [],
        execPath: '',
        stdout: { write: function () {} },
        versions: { node: '0.0.0-shim' },
    };

    // ---------------------------------------------------------------------
    // require()
    // ---------------------------------------------------------------------

    var moduleTable = {
        net: { Socket: function () { return new NetSocket('tcp'); } },
        tls: { connect: tlsConnect },
        crypto: cryptoStub,
        constants: { SSL_OP_NO_SSLv2: 0, SSL_OP_NO_SSLv3: 0, SSL_OP_NO_COMPRESSION: 0, SSL_OP_CIPHER_SERVER_PREFERENCE: 0 },
        os: osStub,
        path: pathStub,
        fs: fsStub,
        buffer: { Buffer: Buffer },
        util: { format: function () { return Array.prototype.slice.call(arguments).join(' '); } },
        url: {
            parse: function (u) {
                var a = document.createElement('a');
                a.href = u;
                return { hostname: a.hostname, port: a.port, path: a.pathname + a.search };
            }
        },
        http: { get: inertHttpGet },
        https: { get: inertHttpGet },
        child_process: { exec: function (cmd, cb) { if (cb) cb(new Error('child_process not supported')); } },
        dgram: dgramStub,
        dns: dnsStub,
        'nw.gui': nwGuiStub,
    };

    window.require = function (name) {
        if (Object.prototype.hasOwnProperty.call(moduleTable, name)) return moduleTable[name];
        // Matches real Node: modules with no shim (e.g. 'krb-ticket') throw so
        // existing try/catch call sites fall back the way they do today.
        throw new Error("Cannot find module '" + name + "'");
    };
})();
