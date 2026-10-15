import CryptoKit
import Foundation

struct LineChatMessage: Codable, Hashable {
    let id: String
    let text: String
    let timestamp: Double?
}

// This harness compiles the snapshot store on its own, so the credential
// lookup it depends on is stubbed here the same way LineChatMessage is. The
// real implementation lives in AppModels.swift and reads the user's keychain
// file, which the benchmark must not touch.
struct StubCredentialsPayload {
    let lineAuthToken: String?
}

enum CredentialManager {
    static func loadCredentials() -> StubCredentialsPayload? {
        StubCredentialsPayload(lineAuthToken: "yomi-qos-harness-benchmark-token")
    }
}

@main
enum DesktopCacheQoSMain {
    static func main() {
        var state: UInt64 = 0x9E37_79B9_7F4A_7C15
        let payload = Data(
            (0..<(512 * 1024)).map { _ in
                state ^= state << 13
                state ^= state >> 7
                state ^= state << 17
                return UInt8(truncatingIfNeeded: state)
            })
        let ephemeralKey = SymmetricKey(data: Data(repeating: 0xA5, count: 32))
        let highlyCompressible = Data(repeating: 0x5A, count: 512 * 1024)
        guard
            let compact = DesktopSecureSnapshotCodec.seal(
                highlyCompressible, keyOverride: ephemeralKey),
            DesktopSecureSnapshotCodec.open(compact, keyOverride: ephemeralKey)
                == highlyCompressible
        else {
            fputs("[desktop:cache-qos] high-compression roundtrip failed\n", stderr)
            exit(1)
        }
        var samples: [Double] = []
        for index in 0..<12 {
            let started = ContinuousClock.now
            guard let sealed = DesktopSecureSnapshotCodec.seal(payload, keyOverride: ephemeralKey),
                DesktopSecureSnapshotCodec.open(sealed, keyOverride: ephemeralKey) == payload
            else {
                fputs("[desktop:cache-qos] codec roundtrip failed\n", stderr)
                exit(1)
            }
            let elapsed = Double(started.duration(to: .now).components.attoseconds) / 1e15
            if index > 0 { samples.append(elapsed) }
        }
        samples.sort()
        let p95 = samples[min(samples.count - 1, Int(ceil(Double(samples.count) * 0.95)) - 1)]
        let budget = Double(ProcessInfo.processInfo.environment["YOMI_DESKTOP_CACHE_P95_MS"] ?? "120") ?? 120
        print("[desktop:cache-qos] encrypted 512KiB roundtrip p95=\(Int(p95.rounded()))ms budget=\(Int(budget))ms")
        if p95 > budget { exit(1) }
    }
}
