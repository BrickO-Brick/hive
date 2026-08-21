import Foundation

/// Errors thrown by the canonical transcript encoder.
public enum BuzzPushTranscriptError: Error, Equatable {
    /// A string field contained non-ASCII scalars. NIP-PL admits only ASCII
    /// authority-bearing strings; rather than guess at UTF-8-vs-escaping
    /// behavior we fail closed.
    case nonASCIIInput(field: String)
    /// The gateway origin was not an absolute HTTP(S) origin.
    case invalidGatewayOrigin
}

/// Canonical NIP-PL App Attest transcript encoder.
///
/// NIP-PL ("Exact App Attest transcript construction") pins the exact bytes
/// every App Attest operation signs:
///
///     <domain> + "\n" + <compact ordered JSON object>
///
/// The JSON object has no insignificant whitespace, members appear in a fixed
/// per-route order, integers use shortest decimal notation, and strings use
/// minimal JSON escaping (quotation mark, reverse solidus, U+0000..U+001F).
/// The gateway builds the same bytes with serde_json and compares hashes, so
/// any byte difference is a silent `401 invalid_attestation`. This encoder is
/// hand-rolled for that reason: `JSONSerialization` escapes `/` as `\/` and
/// does not guarantee member order, so it must never be used for transcripts.
///
/// Ground truth: `crates/buzz-push-gateway/tests/vectors/app_attest_transcripts.json`,
/// generated and asserted by the gateway's own encoder. The tests in this
/// package replay those vectors byte-for-byte.
///
/// The `audience` member of each transcript is derived from the gateway origin
/// used for the request. This binds App Attest proof to the selected gateway
/// deployment while preserving route-level domain separation.
public enum BuzzPushTranscript {
    // MARK: Domains

    public static let enrollDomain = "buzz.push.enroll.v1"
    public static let delegateDomain = "buzz.push.delegate.v1"
    public static let rotateEndpointDomain = "buzz.push.rotate-endpoint.v1"
    public static let revokeDelegationDomain = "buzz.push.revoke-delegation.v1"
    public static let revokeInstallationDomain = "buzz.push.revoke-installation.v1"

    /// Wire version pinned by NIP-PL. Every transcript carries `"v":1`.
    public static let wireVersion: Int64 = 1

    // MARK: Transcripts

    /// `buzz.push.enroll.v1` — these exact bytes are the App Attest
    /// `clientData` supplied to attestation verification.
    public static func enroll(
        challengeId: UUID,
        challenge: String,
        keyId: String,
        appProfile: String,
        endpoint: String,
        endpointEpoch: Int64,
        expiresAt: Int64,
        gatewayOrigin: String = "https://push.buzz.xyz"
    ) throws -> Data {
        var o = CanonicalObject()
        o.int("v", wireVersion)
        try o.string("audience", audience(origin: gatewayOrigin, path: "/v1/installations"))
        o.uuid("challenge_id", challengeId)
        try o.string("challenge", challenge, field: "challenge")
        try o.string("key_id", keyId, field: "key_id")
        try o.string("app_profile", appProfile, field: "app_profile")
        try o.string("endpoint", endpoint, field: "endpoint")
        o.int("endpoint_epoch", endpointEpoch)
        o.int("expires_at", expiresAt)
        return encode(domain: enrollDomain, object: o)
    }

    /// `buzz.push.delegate.v1` — `SHA-256(bytes)` is the assertion
    /// `clientDataHash`.
    public static func delegate(
        challengeId: UUID,
        challenge: String,
        installationHandle: UUID,
        endpointEpoch: Int64,
        generation: Int64,
        relayPubkey: String,
        notBefore: Int64,
        expiresAt: Int64,
        gatewayOrigin: String = "https://push.buzz.xyz"
    ) throws -> Data {
        var o = CanonicalObject()
        o.int("v", wireVersion)
        try o.string("audience", audience(origin: gatewayOrigin, path: "/v1/delegations"))
        o.uuid("challenge_id", challengeId)
        try o.string("challenge", challenge, field: "challenge")
        o.uuid("installation_handle", installationHandle)
        o.int("endpoint_epoch", endpointEpoch)
        o.int("generation", generation)
        try o.string("relay_pubkey", relayPubkey, field: "relay_pubkey")
        o.int("not_before", notBefore)
        o.int("expires_at", expiresAt)
        return encode(domain: delegateDomain, object: o)
    }

    /// `buzz.push.rotate-endpoint.v1` — `SHA-256(bytes)` is the assertion
    /// `clientDataHash`.
    public static func rotateEndpoint(
        challengeId: UUID,
        challenge: String,
        installationHandle: UUID,
        endpointEpoch: Int64,
        newEndpointEpoch: Int64,
        endpoint: String,
        gatewayOrigin: String = "https://push.buzz.xyz"
    ) throws -> Data {
        var o = CanonicalObject()
        o.int("v", wireVersion)
        try o.string("audience", audience(origin: gatewayOrigin, path: "/v1/installations/endpoint"))
        o.uuid("challenge_id", challengeId)
        try o.string("challenge", challenge, field: "challenge")
        o.uuid("installation_handle", installationHandle)
        o.int("endpoint_epoch", endpointEpoch)
        o.int("new_endpoint_epoch", newEndpointEpoch)
        try o.string("endpoint", endpoint, field: "endpoint")
        return encode(domain: rotateEndpointDomain, object: o)
    }

    /// `buzz.push.revoke-delegation.v1` — `SHA-256(bytes)` is the assertion
    /// `clientDataHash`.
    public static func revokeDelegation(
        challengeId: UUID,
        challenge: String,
        installationHandle: UUID,
        relayPubkey: String,
        generation: Int64,
        gatewayOrigin: String = "https://push.buzz.xyz"
    ) throws -> Data {
        var o = CanonicalObject()
        o.int("v", wireVersion)
        try o.string("audience", audience(origin: gatewayOrigin, path: "/v1/delegations/revoke"))
        o.uuid("challenge_id", challengeId)
        try o.string("challenge", challenge, field: "challenge")
        o.uuid("installation_handle", installationHandle)
        try o.string("relay_pubkey", relayPubkey, field: "relay_pubkey")
        o.int("generation", generation)
        return encode(domain: revokeDelegationDomain, object: o)
    }

    /// `buzz.push.revoke-installation.v1` — `SHA-256(bytes)` is the assertion
    /// `clientDataHash`.
    public static func revokeInstallation(
        challengeId: UUID,
        challenge: String,
        installationHandle: UUID,
        endpointEpoch: Int64,
        newEndpointEpoch: Int64,
        gatewayOrigin: String = "https://push.buzz.xyz"
    ) throws -> Data {
        var o = CanonicalObject()
        o.int("v", wireVersion)
        try o.string("audience", audience(origin: gatewayOrigin, path: "/v1/installations/revoke"))
        o.uuid("challenge_id", challengeId)
        try o.string("challenge", challenge, field: "challenge")
        o.uuid("installation_handle", installationHandle)
        o.int("endpoint_epoch", endpointEpoch)
        o.int("new_endpoint_epoch", newEndpointEpoch)
        return encode(domain: revokeInstallationDomain, object: o)
    }

    // MARK: Internals

    private static func audience(origin: String, path: String) throws -> String {
        guard let components = URLComponents(string: origin),
              components.scheme == "https" || components.scheme == "http",
              components.host != nil,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/"
        else {
            throw BuzzPushTranscriptError.invalidGatewayOrigin
        }
        return origin.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path
    }

    private static func encode(domain: String, object: CanonicalObject) -> Data {
        Data((domain + "\n" + object.encoded()).utf8)
    }

    /// Ordered compact JSON object writer. Emission order == call order;
    /// there is deliberately no sorting, no whitespace, and no `Encodable`
    /// round-trip anywhere near these bytes.
    struct CanonicalObject {
        private var members: [String] = []

        mutating func int(_ key: String, _ value: Int64) {
            // Swift's Int64 description is shortest decimal notation, which
            // is what the spec pins and what serde_json emits.
            members.append("\"\(key)\":\(value)")
        }

        mutating func uuid(_ key: String, _ value: UUID) {
            // Canonical lowercase-hyphenated form, matching uuid::Uuid's
            // serde serialization. Foundation's uuidString is uppercase.
            members.append("\"\(key)\":\"\(value.uuidString.lowercased())\"")
        }

        mutating func string(_ key: String, _ value: String, field: String? = nil) throws {
            members.append("\"\(key)\":\"\(try Self.escape(value, field: field ?? key))\"")
        }

        func encoded() -> String {
            "{" + members.joined(separator: ",") + "}"
        }

        /// Minimal JSON string escaping, byte-identical to serde_json:
        /// `"` and `\` get two-character escapes; U+0008, U+0009, U+000A,
        /// U+000C, U+000D get their short forms; the remaining C0 controls
        /// get lowercase `\u00xx`. Nothing else is escaped (in particular
        /// `/` is NOT escaped — the JSONSerialization behavior that makes it
        /// unusable here). Non-ASCII input is rejected outright.
        static func escape(_ s: String, field: String) throws -> String {
            var out = String()
            out.reserveCapacity(s.count)
            for scalar in s.unicodeScalars {
                switch scalar.value {
                case 0x22: out += "\\\""
                case 0x5C: out += "\\\\"
                case 0x08: out += "\\b"
                case 0x09: out += "\\t"
                case 0x0A: out += "\\n"
                case 0x0C: out += "\\f"
                case 0x0D: out += "\\r"
                case 0x00...0x1F: out += String(format: "\\u%04x", scalar.value)
                case 0x20...0x7E: out.unicodeScalars.append(scalar)
                default: throw BuzzPushTranscriptError.nonASCIIInput(field: field)
                }
            }
            return out
        }
    }
}
