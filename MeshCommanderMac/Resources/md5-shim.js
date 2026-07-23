/**
 * md5-shim.js - loaded after forge.bundle.js and amt-certificates-0.0.1.js.
 *
 * amt-wsman-node-0.2.0.js calls hex_md5() unconditionally for HTTP Digest
 * auth (the first 401 challenge from any AMT device). hex_md5/rstr_md5 only
 * exist in the localized amt-0.2.0_*.js variants, not the base amt-0.2.0.js
 * this build uses - vendored here verbatim from amt-0.2.0_fr.js:867, the
 * forge-based implementation used when the Certificates feature is enabled.
 */
function hex_md5(str) { if (str == null) { str = ''; } return forge.md.md5.create().update(str).digest().toHex(); }
