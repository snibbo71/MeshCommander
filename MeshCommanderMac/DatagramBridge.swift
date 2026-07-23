import Foundation
import WebKit
import Darwin

/// Bridges the JS-side `dgram`/`dns` shim (node-shim.js, talking over the
/// "mcDgram" WKScriptMessageHandler) to a raw BSD UDP socket and DNS reverse
/// lookup. Used only by the opt-in "Scan for Computers..." feature.
///
/// Network.framework's NWConnection is connection-oriented (bound to one
/// remote host:port), which doesn't fit amt-scanner-0.1.0.js's actual pattern:
/// bind one local ephemeral port, sendto() many different destination IPs,
/// and recvfrom() replies from whichever of those IPs answers. A raw POSIX
/// socket mirrors Node's own dgram implementation far more directly.
final class DatagramBridge: NSObject, WKScriptMessageHandler {

    private final class Socket {
        let fd: Int32
        var readSource: DispatchSourceRead?
        init(fd: Int32) { self.fd = fd }
    }

    private weak var webView: WKWebView?
    private let queue = DispatchQueue(label: "com.meshcommander.mac.datagrambridge")
    private var sockets: [Int: Socket] = [:]

    init(webView: WKWebView) {
        self.webView = webView
        super.init()
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else { return }

        if op == "dnsReverse" {
            guard let reqId = body["reqId"] as? Int, let ip = body["ip"] as? String else { return }
            handleDnsReverse(reqId: reqId, ip: ip)
            return
        }

        guard let id = body["id"] as? Int else { return }
        switch op {
        case "bind":
            handleBind(id: id, port: body["port"] as? Int ?? 0)
        case "send":
            handleSend(id: id, base64: body["dataB64"] as? String ?? "", port: body["port"] as? Int ?? 0, address: body["address"] as? String ?? "")
        case "close":
            handleClose(id: id)
        default:
            break
        }
    }

    // MARK: - Socket lifecycle

    private func handleBind(id: Int, port: Int) {
        queue.async { [weak self] in
            guard let self else { return }
            let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
            guard fd >= 0 else {
                self.emit(id: id, event: "error", payload: ["message": "socket() failed: errno \(errno)"])
                return
            }

            var reuse: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

            var addr = sockaddr_in()
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = in_port_t(port).bigEndian
            addr.sin_addr.s_addr = INADDR_ANY

            let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                    Darwin.bind(fd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            guard bindResult == 0 else {
                let err = errno
                Darwin.close(fd)
                self.emit(id: id, event: "error", payload: ["message": "bind() failed: errno \(err)"])
                return
            }

            let sock = Socket(fd: fd)
            self.sockets[id] = sock

            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: self.queue)
            source.setEventHandler { [weak self] in
                self?.readAvailable(id: id, fd: fd)
            }
            source.setCancelHandler { Darwin.close(fd) }
            source.resume()
            sock.readSource = source

            self.emit(id: id, event: "listening", payload: [:])
        }
    }

    private func readAvailable(id: Int, fd: Int32) {
        var buffer = [UInt8](repeating: 0, count: 65536)
        var fromAddr = sockaddr_in()
        var fromLen = socklen_t(MemoryLayout<sockaddr_in>.size)

        let n = withUnsafeMutablePointer(to: &fromAddr) { ptr -> Int in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                recvfrom(fd, &buffer, buffer.count, 0, sockaddrPtr, &fromLen)
            }
        }
        guard n > 0 else { return }

        let data = Data(buffer[0..<n])
        let addrString = String(cString: inet_ntoa(fromAddr.sin_addr))
        let port = Int(UInt16(bigEndian: fromAddr.sin_port))

        emit(id: id, event: "message", payload: [
            "dataB64": data.base64EncodedString(),
            "address": addrString,
            "port": port,
        ])
    }

    private func handleSend(id: Int, base64: String, port: Int, address: String) {
        queue.async { [weak self] in
            guard let self, let sock = self.sockets[id], let data = Data(base64Encoded: base64), let portValue = UInt16(exactly: port) else { return }

            var addr = sockaddr_in()
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = portValue.bigEndian
            guard address.withCString({ inet_aton($0, &addr.sin_addr) }) != 0 else { return }

            _ = data.withUnsafeBytes { rawBuf -> Int in
                withUnsafePointer(to: &addr) { ptr -> Int in
                    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                        sendto(sock.fd, rawBuf.baseAddress, data.count, 0, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
                    }
                }
            }
        }
    }

    private func handleClose(id: Int) {
        queue.async { [weak self] in
            guard let self, let sock = self.sockets[id] else { return }
            sock.readSource?.cancel()
            self.sockets.removeValue(forKey: id)
        }
    }

    /// Called on window-close / app-terminate so no socket outlives the page.
    func cancelAll() {
        queue.async { [weak self] in
            guard let self else { return }
            for sock in self.sockets.values { sock.readSource?.cancel() }
            self.sockets.removeAll()
        }
    }

    // MARK: - DNS reverse lookup

    private func handleDnsReverse(reqId: Int, ip: String) {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            var hints = addrinfo(ai_flags: AI_NUMERICHOST, ai_family: AF_UNSPEC, ai_socktype: SOCK_DGRAM, ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
            var res: UnsafeMutablePointer<addrinfo>?
            guard getaddrinfo(ip, nil, &hints, &res) == 0, let addrInfo = res else {
                self.emitDns(reqId: reqId, error: "invalid address", domains: nil)
                return
            }
            defer { freeaddrinfo(addrInfo) }

            var hostBuffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let rc = getnameinfo(addrInfo.pointee.ai_addr, addrInfo.pointee.ai_addrlen, &hostBuffer, socklen_t(hostBuffer.count), nil, 0, 0)
            guard rc == 0 else {
                self.emitDns(reqId: reqId, error: "lookup failed", domains: nil)
                return
            }
            self.emitDns(reqId: reqId, error: nil, domains: [String(cString: hostBuffer)])
        }
    }

    private func emitDns(reqId: Int, error: String?, domains: [String]?) {
        var payload: [String: Any] = [:]
        if let error { payload["error"] = error }
        if let domains { payload["domains"] = domains }
        emitRaw(js: "window.__mcDnsCallback(\(reqId), \(jsonString(payload)));")
    }

    // MARK: - JS callback

    private func emit(id: Int, event: String, payload: [String: Any]) {
        // event is always one of our own fixed literals below - safe to inline unescaped.
        emitRaw(js: "window.__mcDgramCallback(\(id), \"\(event)\", \(jsonString(payload)));")
    }

    private func jsonString(_ payload: [String: Any]) -> String {
        if payload.isEmpty { return "null" }
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return "null" }
        return json
    }

    private func emitRaw(js: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
