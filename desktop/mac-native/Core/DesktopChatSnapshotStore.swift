import Foundation

private struct DesktopChatSnapshot: Codable {
    let policyVersion: Int?
    let savedAt: Date
    let chats: [LineChatItem]
}

enum DesktopChatSnapshotStore {
    private static let currentPolicyVersion = 5
    private static let maximumAge: TimeInterval = 30 * 24 * 60 * 60

    private static var cacheURL: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Yomi", isDirectory: true)
            .appendingPathComponent("chat-list-v1.cache")
    }

    private static var legacyURL: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Yomi", isDirectory: true)
            .appendingPathComponent("chat-list-v1.json")
    }

    /// Kept for non-UI callers. AppState uses `loadAsync` to avoid blocking
    /// launch on cache decryption and JSON decoding.
    static func load() -> [LineChatItem] {
        guard CredentialManager.loadCredentials()?.lineAuthToken?.isEmpty == false,
            let url = cacheURL,
            let envelope = try? Data(contentsOf: url),
            let data = DesktopSecureSnapshotCodec.open(envelope),
            let snapshot = try? JSONDecoder().decode(DesktopChatSnapshot.self, from: data),
            snapshot.policyVersion == currentPolicyVersion,
            Date().timeIntervalSince(snapshot.savedAt) < maximumAge
        else { return [] }
        return snapshot.chats
    }

    static func loadAsync(completion: @escaping ([LineChatItem]) -> Void) {
        let callback = DesktopSnapshotCallback(completion)
        DispatchQueue.global(qos: .utility).async {
            guard CredentialManager.loadCredentials()?.lineAuthToken?.isEmpty == false else {
                DispatchQueue.main.async { callback.call([]) }
                return
            }

            let result: [LineChatItem]
            if let url = cacheURL, let envelope = try? Data(contentsOf: url),
                let data = DesktopSecureSnapshotCodec.open(envelope),
                let snapshot = try? JSONDecoder().decode(DesktopChatSnapshot.self, from: data),
                snapshot.policyVersion == currentPolicyVersion,
                Date().timeIntervalSince(snapshot.savedAt) < maximumAge
            {
                result = snapshot.chats
            } else if let legacyURL,
                let data = try? Data(contentsOf: legacyURL),
                let snapshot = try? JSONDecoder().decode(DesktopChatSnapshot.self, from: data),
                snapshot.policyVersion == currentPolicyVersion,
                Date().timeIntervalSince(snapshot.savedAt) < maximumAge
            {
                if persist(snapshot) {
                    try? FileManager.default.removeItem(at: legacyURL)
                }
                result = snapshot.chats
            } else {
                result = []
            }
            DispatchQueue.main.async { callback.call(result) }
        }
    }

    static func save(_ chats: [LineChatItem]) {
        let snapshot = DesktopChatSnapshot(policyVersion: currentPolicyVersion, savedAt: Date(), chats: chats)
        DispatchQueue.global(qos: .utility).async { _ = persist(snapshot) }
    }

    @discardableResult
    private static func persist(_ snapshot: DesktopChatSnapshot) -> Bool {
        guard let url = cacheURL,
            let plaintext = try? JSONEncoder().encode(snapshot),
            let encrypted = DesktopSecureSnapshotCodec.seal(plaintext)
        else { return false }
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try encrypted.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }
}
