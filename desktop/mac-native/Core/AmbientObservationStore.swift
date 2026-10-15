import Foundation

struct AmbientObservationEvidence: Codable, Equatable, Identifiable {
    let messageId: String
    let chatId: String
    let senderName: String?
    let sentAt: Double
    let text: String?
    let mediaType: String?
    let ocrEligible: Bool
    let isSelf: Bool?
    let sourceUrl: String?
    var ocrText: String?
    var ocrAttempted: Bool?
    var id: String { messageId }
}

struct AmbientObservationCandidate: Codable, Equatable, Identifiable {
    let id: String
    let chatId: String
    let chatName: String
    let topic: String
    var title: String
    let startedAt: Double
    let updatedAt: Double
    let confidence: Double
    let status: String
    let ownerHints: [String]
    let relevance: String
    let responseState: String
    let reasons: [String]
    var evidence: [AmbientObservationEvidence]
    var changeReason: String?
}

struct AmbientObservationSnapshot: Codable, Equatable {
    static let currentEngineVersion = 16
    let engineVersion: Int?
    var version: Int
    let generatedAt: Double
    var windowStart: Double
    let coverageLimited: Bool
    let chatsScanned: Int?
    let messagesScanned: Int?
    let officialChatsSkipped: Int?
    var candidates: [AmbientObservationCandidate]
    var workItems: [AmbientWorkItem]

    private enum CodingKeys: String, CodingKey {
        case engineVersion, version, generatedAt, windowStart, coverageLimited
        case chatsScanned, messagesScanned, officialChatsSkipped, candidates, workItems
    }

    init(
        engineVersion: Int?, version: Int, generatedAt: Double, windowStart: Double,
        coverageLimited: Bool, chatsScanned: Int?, messagesScanned: Int?,
        officialChatsSkipped: Int?, candidates: [AmbientObservationCandidate],
        workItems: [AmbientWorkItem] = []
    ) {
        self.engineVersion = engineVersion
        self.version = version
        self.generatedAt = generatedAt
        self.windowStart = windowStart
        self.coverageLimited = coverageLimited
        self.chatsScanned = chatsScanned
        self.messagesScanned = messagesScanned
        self.officialChatsSkipped = officialChatsSkipped
        self.candidates = candidates
        self.workItems = workItems
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        engineVersion = try values.decodeIfPresent(Int.self, forKey: .engineVersion)
        version = try values.decode(Int.self, forKey: .version)
        generatedAt = try values.decode(Double.self, forKey: .generatedAt)
        windowStart = try values.decode(Double.self, forKey: .windowStart)
        coverageLimited = try values.decode(Bool.self, forKey: .coverageLimited)
        chatsScanned = try values.decodeIfPresent(Int.self, forKey: .chatsScanned)
        messagesScanned = try values.decodeIfPresent(Int.self, forKey: .messagesScanned)
        officialChatsSkipped = try values.decodeIfPresent(Int.self, forKey: .officialChatsSkipped)
        candidates = try values.decode([AmbientObservationCandidate].self, forKey: .candidates)
        workItems = try values.decodeIfPresent([AmbientWorkItem].self, forKey: .workItems) ?? []
    }
}

struct AmbientWorkItem: Codable, Equatable, Identifiable {
    let id: String
    let chatId: String
    let chatName: String
    let title: String
    let titleKey: String
    let ownerState: String
    let resolutionState: String
    let createdAt: Double
    let updatedAt: Double
    let lastEvidenceAt: Double
    let confidence: Double
    let sourceMessageIds: [String]
}

private struct AmbientObservationBridgeReport: Codable {
    let engineVersion: Int
    let generatedAt: Double
    let windowStart: Double
    let coverageLimited: Bool
    let chatsScanned: Int?
    let messagesScanned: Int?
    let officialChatsSkipped: Int?
    let candidates: [AmbientObservationCandidate]
    let workItems: [AmbientWorkItem]?
}

enum AmbientObservationStore {
    private static let maximumPlaintextBytes = 768 * 1024
    private static let maximumFileBytes = 1024 * 1024

    private static var url: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Yomi/ambient-observations.cache")
    }

    static func decodeBridge(_ data: Data) -> AmbientObservationSnapshot? {
        guard let report = try? JSONDecoder().decode(AmbientObservationBridgeReport.self, from: data) else { return nil }
        return AmbientObservationSnapshot(
            engineVersion: report.engineVersion,
            version: 1, generatedAt: report.generatedAt, windowStart: report.windowStart,
            coverageLimited: report.coverageLimited,
            chatsScanned: report.chatsScanned,
            messagesScanned: report.messagesScanned,
            officialChatsSkipped: report.officialChatsSkipped,
            candidates: report.candidates,
            workItems: report.workItems ?? [])
    }

    static func load() -> AmbientObservationSnapshot? {
        guard let url, let encrypted = try? Data(contentsOf: url),
            encrypted.count <= maximumFileBytes,
            let plaintext = DesktopSecureSnapshotCodec.open(encrypted),
            let snapshot = try? JSONDecoder().decode(AmbientObservationSnapshot.self, from: plaintext)
        else { return nil }
        return snapshot
    }

    static func save(_ snapshot: AmbientObservationSnapshot) {
        guard let url, let plaintext = try? JSONEncoder().encode(snapshot),
            plaintext.count <= maximumPlaintextBytes,
            let encrypted = DesktopSecureSnapshotCodec.seal(plaintext),
            encrypted.count <= maximumFileBytes
        else { return }
        DispatchQueue.global(qos: .utility).async {
            try? FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? encrypted.write(to: url, options: .atomic)
        }
    }
}
