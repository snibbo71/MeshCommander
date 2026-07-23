import Foundation
import Network
import Security
import CryptoKit

/// Extracts the leaf certificate (DER + SHA-1 colon-hex fingerprint) from an
/// NWConnection's negotiated TLS session, in the same format Node's
/// `tls.TLSSocket.getPeerCertificate().fingerprint` uses - which is what
/// amt-wsman-node-0.2.0.js's own certificate pinning (xtlsFingerprint /
/// xtlsCheck) compares against.
enum CertificateFingerprint {
    static func leafCertificate(from metadata: sec_protocol_metadata_t) -> (der: Data, fingerprint: String)? {
        var leaf: SecCertificate?
        sec_protocol_metadata_access_peer_certificate_chain(metadata) { certificate in
            if leaf == nil {
                leaf = sec_certificate_copy_ref(certificate).takeRetainedValue()
            }
        }
        guard let certificate = leaf, let der = SecCertificateCopyData(certificate) as Data? else { return nil }
        return (der, sha1ColonHex(der))
    }

    private static func sha1ColonHex(_ data: Data) -> String {
        Insecure.SHA1.hash(data: data)
            .map { String(format: "%02X", $0) }
            .joined(separator: ":")
    }
}
