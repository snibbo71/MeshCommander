import Foundation
import Network
import WebKit

/// Bridges the JS-side `net`/`tls` shim (node-shim.js, talking over the "mcNet"
/// WKScriptMessageHandler) to real sockets via Network.framework. One id-keyed
/// NWConnection per JS "socket"; inbound events are pushed back into the page
/// by invoking the single global `window.__mcNetCallback(id, event, payload)`.
final class NetworkBridge: NSObject, WKScriptMessageHandler {

    private final class Connection {
        let nwConnection: NWConnection
        let host: String
        let kind: String
        var idleTimer: DispatchSourceTimer?
        var idleTimeoutMs: Int?
        var connectTimer: DispatchSourceTimer?
        init(nwConnection: NWConnection, host: String, kind: String) {
            self.nwConnection = nwConnection
            self.host = host
            self.kind = kind
        }
    }

    private weak var webView: WKWebView?
    private let queue = DispatchQueue(label: "com.meshcommander.mac.networkbridge")
    private var connections: [Int: Connection] = [:]

    /// Per-host circuit breaker for TLS: once a TLS connection to a host fails to reach a
    /// healthy state (connect-phase timeout, transport failure, or stalls mid-handshake past
    /// the idle timeout), further TLS connect attempts to that host are rejected immediately -
    /// without touching the network at all - until this cooldown expires. Confirmed via a live
    /// tcpdump capture against real AMT hardware: sequential TLS reconnects that alternate
    /// between succeeding instantly and hanging indefinitely mid-handshake (even past a 45s
    /// wait) point to AMT's own embedded TLS session state, not client-side timing - and the
    /// vendor JS's own retry loop (amt-wsman-node-0.2.0.js's xxOnSocketClosed, up to 5 retries
    /// 500ms apart) hammering a device in that state is what progressively wedged its whole
    /// network stack until it required a power cycle. This breaker makes sure only the first
    /// attempt after a failure ever reaches the wire - the rest fail fast, so a human has to
    /// decide to try again rather than software retrying unattended.
    /// Long enough to safely outlast the vendor's entire retry cascade (up to 5 attempts,
    /// 500ms apart, each of which can itself take up to connectTimeoutSecondsTLS/the idle
    /// timeout to fail) - so within one logical "connect" action, only the first attempt ever
    /// reaches the wire and the remaining automatic retries are binned immediately, not just
    /// delayed. A later, genuinely new attempt (e.g. the user clicking Connect again) is still
    /// allowed once this expires.
    private var tlsCircuitBreakerUntil: [String: Date] = [:]
    private static let tlsCircuitBreakerCooldownSeconds: TimeInterval = 120

    /// NWConnection has no built-in connect timeout, and critically, a host that's simply
    /// unreachable (wrong IP, no route) parks the connection in `.waiting` indefinitely rather
    /// than transitioning to `.failed` - with no timer, the JS layer never gets an error/close
    /// event and the UI hangs on "Loading..." forever with zero feedback.
    private static let connectTimeoutSeconds: Double = 10
    /// TLS gets much more slack than plain TCP. Confirmed via a live tcpdump capture against
    /// real AMT hardware: when AMT is at all loaded, its TCP stack can take several seconds
    /// of SYN retransmits just to accept a *new* connection, well before TLS even starts. The
    /// vendor JS (amt-wsman-node-0.2.0.js's xxOnSocketClosed) retries on every 'close'/'error'
    /// event by opening a brand-new connection - so cutting this off at the same 10s used for
    /// plain TCP meant every timeout piled a fresh connection attempt on top of AMT while it
    /// was still busy, and a few rounds of that wedged its network stack entirely (stopped
    /// accepting connections, even ARP, until power-cycled). See also NetSocket.prototype.setTimeout
    /// in node-shim.js, which gives the same headroom to the idle-after-connect timeout.
    private static let connectTimeoutSecondsTLS: Double = 45

    init(webView: WKWebView) {
        self.webView = webView
        super.init()
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let op = body["op"] as? String else { return }

        // Uncaught JS exceptions from node-shim.js's window.onerror hook - see matching note there.
        if op == "jserror" {
            print("[JS ERROR] \(body["message"] ?? "") at \(body["source"] ?? ""):\(body["lineno"] ?? "?"):\(body["colno"] ?? "?")\nstack: \(body["stack"] ?? "")")
            return
        }

        guard let id = body["id"] as? Int else { return }

        switch op {
        case "connect":
            let kind = body["kind"] as? String ?? "tcp"
            let host = body["host"] as? String ?? ""
            let port = body["port"] as? Int ?? 0
            handleConnect(id: id, kind: kind, host: host, port: port)
        case "write":
            handleWrite(id: id, base64: body["dataB64"] as? String ?? "")
        case "setTimeout":
            handleSetTimeout(id: id, ms: body["ms"] as? Int ?? 0)
        case "end", "destroy":
            handleDestroy(id: id)
        default:
            break
        }
    }

    // MARK: - Connection lifecycle

    private func handleConnect(id: Int, kind: String, host: String, port: Int) {
        queue.async { [weak self] in
            guard let self else { return }
            guard port > 0, port <= 65535, let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
                self.emit(id: id, event: "error", payload: ["message": "invalid port"])
                self.emit(id: id, event: "close", payload: [:])
                return
            }

            if kind == "tls", let cooldownUntil = self.tlsCircuitBreakerUntil[host], cooldownUntil > Date() {
                let remaining = Int(cooldownUntil.timeIntervalSinceNow.rounded(.up))
                self.emit(id: id, event: "error", payload: ["message": "TLS connection to \(host) failed recently; refusing further automatic attempts for \(remaining)s to avoid destabilizing the device"])
                self.emit(id: id, event: "close", payload: [:])
                return
            }

            let tcpOptions = NWProtocolTCP.Options()
            tcpOptions.noDelay = true // every call site in the codebase calls setNoDelay(true)

            let parameters: NWParameters
            if kind == "tls" {
                let tlsOptions = NWProtocolTLS.Options()
                let secOptions = tlsOptions.securityProtocolOptions
                // Legacy AMT firmware default range.
                sec_protocol_options_set_min_tls_protocol_version(secOptions, .TLSv10)
                sec_protocol_options_set_max_tls_protocol_version(secOptions, .TLSv12)
                // Network.framework's default cipher/extension offering is much broader than
                // what amt-wsman-node-0.2.0.js's original Node TLS client sent (it deliberately
                // restricts to this exact list - "ciphers:" in xxConnectHttpSocket). AMT's
                // embedded TLS stack, especially on older firmware, is known to be fragile
                // against ClientHellos outside what it expects - matching the vendor's narrow,
                // tested list here rather than Network.framework's full modern default set.
                for suite: tls_ciphersuite_t in [
                    .ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
                    .ECDHE_RSA_WITH_AES_256_GCM_SHA384,
                    .ECDHE_RSA_WITH_AES_128_GCM_SHA256,
                    .ECDHE_RSA_WITH_AES_256_CBC_SHA384,
                    .ECDHE_RSA_WITH_AES_128_CBC_SHA256,
                    .RSA_WITH_AES_256_GCM_SHA384,
                    .RSA_WITH_AES_128_GCM_SHA256,
                    .RSA_WITH_AES_256_CBC_SHA256,
                    .RSA_WITH_AES_128_CBC_SHA256,
                    .RSA_WITH_AES_256_CBC_SHA,
                    .RSA_WITH_AES_128_CBC_SHA,
                ] {
                    sec_protocol_options_add_tls_ciphersuite(secOptions, suite.rawValue)
                }
                // The JS layer already does its own certificate fingerprint pinning
                // (xtlsFingerprint/xtlsCheck in amt-wsman-node-0.2.0.js) against AMT's
                // self-signed certs - accept at the transport layer instead of fighting
                // it with strict native trust validation.
                sec_protocol_options_set_verify_block(secOptions, { _, _, complete in
                    complete(true)
                }, self.queue)
                parameters = NWParameters(tls: tlsOptions, tcp: tcpOptions)
            } else {
                parameters = NWParameters(tls: nil, tcp: tcpOptions)
            }

            let nwConnection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: parameters)
            let connection = Connection(nwConnection: nwConnection, host: host, kind: kind)
            self.connections[id] = connection

            nwConnection.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    connection.connectTimer?.cancel()
                    connection.connectTimer = nil
                    self.handleReady(id: id, connection: nwConnection, kind: kind)
                case .failed(let error):
                    self.failConnect(id: id, message: String(describing: error))
                case .cancelled:
                    self.emit(id: id, event: "close", payload: [:])
                    self.teardown(id: id)
                default:
                    break // .setup / .preparing / .waiting(error) - covered by the connect timer below
                }
            }

            let timeoutSeconds = (kind == "tls") ? Self.connectTimeoutSecondsTLS : Self.connectTimeoutSeconds
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + .seconds(Int(timeoutSeconds)))
            timer.setEventHandler { [weak self] in
                self?.failConnect(id: id, message: "Connection timed out after \(Int(timeoutSeconds))s (host unreachable or not responding)")
            }
            timer.resume()
            connection.connectTimer = timer

            nwConnection.start(queue: self.queue)
        }
    }

    /// Shared by both `.failed` and the connect-phase timeout: cancels the connection and
    /// reports it as gone so the JS layer's own retry/error-surfacing logic can take over.
    private func failConnect(id: Int, message: String) {
        guard let conn = connections[id] else { return }
        conn.connectTimer?.cancel()
        conn.nwConnection.cancel()
        if conn.kind == "tls" { tripTLSCircuitBreaker(host: conn.host) }
        emit(id: id, event: "error", payload: ["message": message])
        emit(id: id, event: "close", payload: [:])
        teardown(id: id)
    }

    private func tripTLSCircuitBreaker(host: String) {
        tlsCircuitBreakerUntil[host] = Date().addingTimeInterval(Self.tlsCircuitBreakerCooldownSeconds)
    }

    private func handleReady(id: Int, connection: NWConnection, kind: String) {
        if kind == "tls", let conn = connections[id] {
            tlsCircuitBreakerUntil.removeValue(forKey: conn.host)
        }
        var payload: [String: Any] = [:]
        if kind == "tls",
           let metadata = connection.metadata(definition: NWProtocolTLS.definition) as? NWProtocolTLS.Metadata,
           let (der, fingerprint) = CertificateFingerprint.leafCertificate(from: metadata.securityProtocolMetadata) {
            payload["certRawB64"] = der.base64EncodedString()
            payload["fingerprint"] = fingerprint
        }
        emit(id: id, event: "connect", payload: payload)
        receiveLoop(id: id, connection: connection)
    }

    private func receiveLoop(id: Int, connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.resetIdleTimer(id: id)
                self.emit(id: id, event: "data", payload: ["dataB64": data.base64EncodedString()])
            }
            if let error {
                self.emit(id: id, event: "error", payload: ["message": String(describing: error)])
                self.emit(id: id, event: "close", payload: [:])
                self.teardown(id: id)
                return
            }
            if isComplete {
                self.emit(id: id, event: "close", payload: [:])
                self.teardown(id: id)
                return
            }
            self.receiveLoop(id: id, connection: connection)
        }
    }

    private func handleWrite(id: Int, base64: String) {
        queue.async { [weak self] in
            guard let self, let conn = self.connections[id], let data = Data(base64Encoded: base64) else { return }
            self.resetIdleTimer(id: id)
            conn.nwConnection.send(content: data, completion: .contentProcessed { _ in })
        }
    }

    // NWConnection has no built-in idle timeout; Node's `timeout` event doesn't itself
    // close the socket (xxOnSocketClosed wiring in amt-wsman-node-0.2.0.js does that), so
    // this only fires the event and re-arms - it never cancels the connection itself.
    private func handleSetTimeout(id: Int, ms: Int) {
        queue.async { [weak self] in
            guard let self, let conn = self.connections[id] else { return }
            conn.idleTimeoutMs = ms
            self.restartIdleTimer(id: id)
        }
    }

    private func restartIdleTimer(id: Int) {
        guard let conn = connections[id], let ms = conn.idleTimeoutMs else { return }
        conn.idleTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(ms))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            // A TLS connection that goes idle mid-handshake (e.g. stuck right after a bare
            // ServerHello, observed via tcpdump against real AMT hardware) never reaches
            // .ready, so failConnect's circuit-breaker trip never fires for it - this is the
            // other place a TLS attempt can be judged unhealthy and needs to trip it too.
            if conn.kind == "tls" { self.tripTLSCircuitBreaker(host: conn.host) }
            self.emit(id: id, event: "timeout", payload: [:])
        }
        timer.resume()
        conn.idleTimer = timer
    }

    private func resetIdleTimer(id: Int) {
        guard let conn = connections[id], conn.idleTimeoutMs != nil else { return }
        restartIdleTimer(id: id)
    }

    private func handleDestroy(id: Int) {
        queue.async { [weak self] in
            guard let self, let conn = self.connections[id] else { return }
            conn.idleTimer?.cancel()
            conn.connectTimer?.cancel()
            conn.nwConnection.cancel()
            self.connections.removeValue(forKey: id)
        }
    }

    private func teardown(id: Int) {
        connections[id]?.idleTimer?.cancel()
        connections[id]?.connectTimer?.cancel()
        connections.removeValue(forKey: id)
    }

    /// Called on window-close / app-terminate so no connection outlives the page.
    func cancelAll() {
        queue.async { [weak self] in
            guard let self else { return }
            for conn in self.connections.values {
                conn.idleTimer?.cancel()
                conn.connectTimer?.cancel()
                conn.nwConnection.cancel()
            }
            self.connections.removeAll()
        }
    }

    // MARK: - JS callback

    private func emit(id: Int, event: String, payload: [String: Any]) {
        let payloadJSON: String
        if payload.isEmpty {
            payloadJSON = "null"
        } else if let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) {
            payloadJSON = json
        } else {
            payloadJSON = "null"
        }
        // event is always one of our own fixed literals below - safe to inline unescaped.
        let js = "window.__mcNetCallback(\(id), \"\(event)\", \(payloadJSON));"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
