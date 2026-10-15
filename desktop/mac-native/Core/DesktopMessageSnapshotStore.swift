import Compression
import CryptoKit
import Foundation

final class DesktopSnapshotCallback<Value>: @unchecked Sendable {
    private let callback: (Value) -> Void

    init(_ callback: @escaping (Value) -> Void) {
        self.callback = callback
    }

    func call(_ value: Value) {
        callback(value)
    }
}

/// Encrypted, compressed codec for decrypted desktop snapshots. A cache miss
/// is preferable to ever writing plaintext LINE content to disk.
enum DesktopSecureSnapshotCodec {
    // Cache encryption must not create a second Keychain authority or trigger
    // a macOS password prompt. Derive a cache-only key from the already-owned
    // LINE session secret; token rotation or logout intentionally makes stale
    // snapshots unreadable, which is the correct cache invalidation boundary.
    private static let envelopeVersion = 2
    static let maxPayloadBytes = 32 * 1024 * 1024

    private struct Envelope: Codable {
        let version: Int
        let compression: String
        let uncompressedBytes: Int
        let nonce: Data
        let ciphertext: Data
        let tag: Data
    }

    private static func key() -> SymmetricKey? {
        guard let token = CredentialManager.loadCredentials()?.lineAuthToken, !token.isEmpty else {
            return nil
        }
        var material = Data("yomi.desktop.snapshot-cache.v2\0".utf8)
        material.append(Data(token.utf8))
        return SymmetricKey(data: Data(SHA256.hash(data: material)))
    }

    private static func compress(_ input: Data) -> Data? {
        guard !input.isEmpty else { return input }
        var capacity = max(256, input.count + input.count / 4 + 64)
        for _ in 0..<4 {
            var output = Data(repeating: 0, count: capacity)
            let count = output.withUnsafeMutableBytes { destination in
                input.withUnsafeBytes { source in
                    compression_encode_buffer(
                        destination.bindMemory(to: UInt8.self).baseAddress!, capacity,
                        source.bindMemory(to: UInt8.self).baseAddress!, input.count, nil,
                        COMPRESSION_LZFSE)
                }
            }
            if count > 0 {
                output.count = count
                return output
            }
            capacity *= 2
        }
        return nil
    }

    private static func decompress(_ input: Data, expectedBytes: Int) -> Data? {
        guard !input.isEmpty else { return input }
        guard expectedBytes > 0, expectedBytes <= maxPayloadBytes else { return nil }
        var output = Data(repeating: 0, count: expectedBytes)
        let count = output.withUnsafeMutableBytes { destination in
            input.withUnsafeBytes { source in
                compression_decode_buffer(
                    destination.bindMemory(to: UInt8.self).baseAddress!, expectedBytes,
                    source.bindMemory(to: UInt8.self).baseAddress!, input.count, nil,
                    COMPRESSION_LZFSE)
            }
        }
        guard count == expectedBytes else { return nil }
        return output
    }

    static func seal(_ plaintext: Data, keyOverride: SymmetricKey? = nil) -> Data? {
        guard plaintext.count <= maxPayloadBytes, let key = keyOverride ?? key(),
            let compressed = compress(plaintext)
        else {
            return nil
        }
        do {
            let sealed = try AES.GCM.seal(compressed, using: key)
            let envelope = Envelope(
                version: envelopeVersion, compression: "lzfse",
                uncompressedBytes: plaintext.count,
                nonce: sealed.nonce.withUnsafeBytes { Data($0) },
                ciphertext: sealed.ciphertext, tag: sealed.tag)
            return try JSONEncoder().encode(envelope)
        } catch {
            return nil
        }
    }

    static func open(_ envelopeData: Data, keyOverride: SymmetricKey? = nil) -> Data? {
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: envelopeData),
            envelope.version == envelopeVersion, envelope.compression == "lzfse",
            envelope.ciphertext.count <= maxPayloadBytes, let key = keyOverride ?? key(),
            let nonce = try? AES.GCM.Nonce(data: envelope.nonce),
            let box = try? AES.GCM.SealedBox(
                nonce: nonce, ciphertext: envelope.ciphertext, tag: envelope.tag),
            let compressed = try? AES.GCM.open(box, using: key)
        else { return nil }
        return decompress(compressed, expectedBytes: envelope.uncompressedBytes)
    }
}

private struct DesktopMessageSnapshot: Codable {
    let savedAt: Date
    let messages: [LineChatMessage]
}

enum DesktopMessageSnapshotStore {
    private static let maximumAge: TimeInterval = 7 * 24 * 60 * 60
    private static let maxMessages = 200
    private static let maximumFileBytes = 512 * 1024
    private static let maximumDirectoryBytes = 16 * 1024 * 1024

    private static func url(accountId: String, chatId: String) -> URL? {
        guard !accountId.isEmpty,
            chatId.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        else {
            return nil
        }
        let accountHash = SHA256.hash(data: Data(accountId.utf8)).map { String(format: "%02x", $0) }.joined()
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Yomi/messages", isDirectory: true)
            .appendingPathComponent(accountHash, isDirectory: true)
            .appendingPathComponent("\(chatId).cache")
    }

    /// Synchronous access is retained for callers already off-main. UI code
    /// should use `loadAsync` so a large cache never blocks a frame.
    static func load(accountId: String, chatId: String) -> [LineChatMessage] {
        guard let url = url(accountId: accountId, chatId: chatId), let envelope = try? Data(contentsOf: url),
            let data = DesktopSecureSnapshotCodec.open(envelope),
            let snapshot = try? JSONDecoder().decode(DesktopMessageSnapshot.self, from: data),
            Date().timeIntervalSince(snapshot.savedAt) < maximumAge
        else { return [] }
        return snapshot.messages
    }

    static func loadAsync(accountId: String, chatId: String, completion: @escaping ([LineChatMessage]) -> Void) {
        let callback = DesktopSnapshotCallback(completion)
        guard let url = url(accountId: accountId, chatId: chatId) else {
            callback.call([])
            return
        }
        DispatchQueue.global(qos: .utility).async {
            let encrypted = try? Data(contentsOf: url)
            if let encrypted, let data = DesktopSecureSnapshotCodec.open(encrypted),
                let snapshot = try? JSONDecoder().decode(DesktopMessageSnapshot.self, from: data),
                Date().timeIntervalSince(snapshot.savedAt) < maximumAge
            {
                DispatchQueue.main.async { callback.call(snapshot.messages) }
            } else {
                try? FileManager.default.removeItem(at: url)
                DispatchQueue.main.async { callback.call([]) }
            }
        }
    }

    static func save(_ messages: [LineChatMessage], accountId: String, chatId: String) {
        guard let url = url(accountId: accountId, chatId: chatId),
            let plaintext = try? JSONEncoder().encode(
                DesktopMessageSnapshot(savedAt: Date(), messages: Array(messages.suffix(maxMessages)))),
            plaintext.count <= DesktopSecureSnapshotCodec.maxPayloadBytes,
            let encrypted = DesktopSecureSnapshotCodec.seal(plaintext),
            encrypted.count <= maximumFileBytes
        else { return }
        DispatchQueue.global(qos: .utility).async {
            try? FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? encrypted.write(to: url, options: .atomic)
            prune(directory: url.deletingLastPathComponent())
        }
    }

    private static func prune(directory: URL) {
        guard
            let entries = try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
                options: [.skipsHiddenFiles])
        else { return }
        let now = Date()
        var files: [(url: URL, size: Int, modified: Date)] = []
        for entry in entries {
            guard let values = try? entry.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]),
                let size = values.fileSize,
                let modified = values.contentModificationDate
            else { continue }
            if now.timeIntervalSince(modified) > maximumAge {
                try? FileManager.default.removeItem(at: entry)
            } else {
                files.append((entry, size, modified))
            }
        }
        var total = files.reduce(0) { $0 + $1.size }
        for file in files.sorted(by: { $0.modified < $1.modified }) where total > maximumDirectoryBytes {
            try? FileManager.default.removeItem(at: file.url)
            total -= file.size
        }
    }

    static func merge(existing: [LineChatMessage], incoming: [LineChatMessage]) -> [LineChatMessage] {
        let visibleExisting = existing.filter { $0.text != "[yomi:square_message]" }
        let visibleIncoming = incoming.filter { $0.text != "[yomi:square_message]" }
        var byId = Dictionary(uniqueKeysWithValues: visibleExisting.map { ($0.id, $0) })
        for message in visibleIncoming { byId[message.id] = message }
        return Array(
            byId.values.sorted {
                let leftTimestamp = $0.timestamp ?? 0
                let rightTimestamp = $1.timestamp ?? 0
                if leftTimestamp == rightTimestamp { return $0.id < $1.id }
                return leftTimestamp < rightTimestamp
            }.suffix(maxMessages)
        )
    }
}
