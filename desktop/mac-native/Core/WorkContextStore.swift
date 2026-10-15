import AppKit
import Foundation

struct WorkMaterialReference: Codable, Equatable, Identifiable {
    let chatId: String
    let messageId: String
    let senderName: String?
    let sentAt: Double
    let text: String?
    let mediaType: String?
    let ocrText: String?
    let sourceUrl: String?

    var id: String { "\(chatId):\(messageId)" }
    var isAttachment: Bool { mediaType != nil && mediaType != "text" }
}

struct WorkActivityEntry: Codable, Equatable, Identifiable {
    let id: String
    let occurredAt: Double
    let kind: String
    let summary: String
    let sourceMessageId: String?
}

struct YomiWorkContext: Codable, Equatable, Identifiable {
    let id: String
    let candidateId: String
    let createdAt: Double
    var updatedAt: Double
    var title: String
    let sourceChatId: String
    let sourceChatName: String
    var initiator: String?
    var owner: String?
    var collaborators: [String]
    var externalParties: [String]
    var deliverables: [String]
    var openQuestions: [String]
    var status: String
    var nextStep: String
    var aiActions: [String]
    var materials: [WorkMaterialReference]
    var activity: [WorkActivityEntry]

    var attachmentCount: Int { materials.filter(\.isAttachment).count }

    static func draft(from candidate: AmbientObservationCandidate) -> YomiWorkContext {
        let materials = candidate.evidence.map {
            WorkMaterialReference(
                chatId: $0.chatId, messageId: $0.messageId,
                senderName: $0.senderName, sentAt: $0.sentAt, text: $0.text,
                mediaType: $0.mediaType, ocrText: $0.ocrText, sourceUrl: $0.sourceUrl)
        }
        let combined = materials.compactMap(\.text).joined(separator: "\n")
        let mentions = Self.mentions(in: combined)
        let initiator = materials.first(where: { $0.senderName?.isEmpty == false })?.senderName
        let collaborators = Array(NSOrderedSet(array: candidate.ownerHints + mentions).array as? [String] ?? [])
        let deliverables = combined.contains("簡報") ? ["年度成果與後續工作規劃簡報"] : [candidate.title]
        var unknowns = ["負責窗口", "完成期限"]
        if combined.contains("會議") { unknowns.insert("會議時間", at: 0) }
        let now = Date().timeIntervalSince1970 * 1000
        return YomiWorkContext(
            id: "work-\(UUID().uuidString.lowercased())", candidateId: candidate.id,
            createdAt: now, updatedAt: now, title: candidate.title,
            sourceChatId: candidate.chatId, sourceChatName: candidate.chatName,
            initiator: initiator, owner: collaborators.first, collaborators: collaborators, externalParties: [],
            deliverables: deliverables, openQuestions: unknowns, status: "needs_clarification",
            nextStep: Self.defaultNextStep(collaborators: collaborators),
            aiActions: ["草擬詢問訊息", "整理交付物大綱", "追蹤相關回覆"],
            materials: materials,
            activity: materials.map {
                WorkActivityEntry(
                    id: "source-\($0.messageId)", occurredAt: $0.sentAt,
                    kind: "source", summary: $0.text ?? ($0.mediaType.map { "LINE \($0)" } ?? "LINE 訊息"),
                    sourceMessageId: $0.messageId)
            })
    }

    private static func mentions(in text: String) -> [String] {
        let pattern = #"@([^\s@，,。！？!?：:]+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap { match in
            guard match.numberOfRanges > 1, let value = Range(match.range(at: 1), in: text) else { return nil }
            return String(text[value])
        }
    }

    private static func defaultNextStep(collaborators: [String]) -> String {
        collaborators.isEmpty
            ? "確認負責窗口與下一步安排"
            : "聯絡 \(collaborators.joined(separator: "、")) 確認窗口與時程"
    }
}

private struct WorkContextSnapshot: Codable {
    let version: Int
    var items: [YomiWorkContext]
}

enum WorkContextStore {
    private static var url: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Yomi/work-contexts.cache")
    }

    static func load() -> [YomiWorkContext] {
        guard let url, let encrypted = try? Data(contentsOf: url),
            let plaintext = DesktopSecureSnapshotCodec.open(encrypted),
            let snapshot = try? JSONDecoder().decode(WorkContextSnapshot.self, from: plaintext),
            snapshot.version == 1
        else { return [] }
        return snapshot.items
    }

    static func save(_ items: [YomiWorkContext]) {
        guard let url,
            let data = try? JSONEncoder().encode(WorkContextSnapshot(version: 1, items: items)),
            let encrypted = DesktopSecureSnapshotCodec.seal(data)
        else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? encrypted.write(to: url, options: .atomic)
    }
}

extension AppState {
    var activeWorkContext: YomiWorkContext? {
        guard let activeWorkContextId else { return nil }
        return workContexts.first(where: { $0.id == activeWorkContextId })
    }

    func previewWork(_ candidate: AmbientObservationCandidate) {
        workPreview = YomiWorkContext.draft(from: candidate)
        selectedChatId = nil
    }

    func dismissWorkPreview() { workPreview = nil }

    func confirmWorkPreview() {
        guard var draft = workPreview else { return }
        draft.updatedAt = Date().timeIntervalSince1970 * 1000
        draft.activity.append(
            WorkActivityEntry(
                id: "created-\(UUID().uuidString)", occurredAt: draft.updatedAt,
                kind: "created", summary: "已確認建立工作", sourceMessageId: nil))
        workContexts.removeAll { $0.id == draft.id }
        workContexts.insert(draft, at: 0)
        activeWorkContextId = draft.id
        workPreview = nil
        WorkContextStore.save(workContexts)
    }

    func exitWorkMode() { activeWorkContextId = nil }

    func updateWorkPreview(
        title: String? = nil,
        initiator: String? = nil,
        owner: String? = nil,
        collaborators: [String]? = nil,
        externalParties: [String]? = nil,
        deliverables: [String]? = nil,
        openQuestions: [String]? = nil,
        status: String? = nil,
        nextStep: String? = nil,
        aiActions: [String]? = nil
    ) {
        if let title { workPreview?.title = title }
        if let initiator { workPreview?.initiator = initiator.nilIfBlank }
        if let owner { workPreview?.owner = owner.nilIfBlank }
        if let collaborators { workPreview?.collaborators = collaborators }
        if let externalParties { workPreview?.externalParties = externalParties }
        if let deliverables { workPreview?.deliverables = deliverables }
        if let openQuestions { workPreview?.openQuestions = openQuestions }
        if let status { workPreview?.status = status }
        if let nextStep { workPreview?.nextStep = nextStep }
        if let aiActions { workPreview?.aiActions = aiActions }
    }

    func completeActiveWork() {
        guard let id = activeWorkContextId,
            let index = workContexts.firstIndex(where: { $0.id == id })
        else { return }
        let now = Date().timeIntervalSince1970 * 1000
        workContexts[index].status = "completed"
        workContexts[index].updatedAt = now
        workContexts[index].activity.append(
            WorkActivityEntry(
                id: "completed-\(UUID().uuidString)", occurredAt: now,
                kind: "completed", summary: "工作已完成", sourceMessageId: nil))
        WorkContextStore.save(workContexts)
        activeWorkContextId = nil
    }

    func executeActiveWorkNextStep(using provider: AiProviderType) {
        guard let work = activeWorkContext else { return }
        let resourcePointers = work.materials.map {
            "- chatId=\($0.chatId), messageId=\($0.messageId), mediaType=\($0.mediaType ?? "text")"
        }.joined(separator: "\n")
        let prompt = """
            執行 Yomi 工作 \(work.id)：\(work.title)
            下一步：\(work.nextStep)
            來源對話：\(work.sourceChatName)（chatId: \(work.sourceChatId)）
            來源素材：
            \(resourcePointers)

            請直接使用 Yomi MCP 的 get_chat_messages 與 get_message_media 讀取上述 LINE 素材；不得要求使用者下載、複製或重新附加已存在於 Yomi 的內容。先產出可供使用者確認的成果；任何發訊息或外部寫入仍須明確核准。
            """
        if let index = workContexts.firstIndex(where: { $0.id == work.id }) {
            let now = Date().timeIntervalSince1970 * 1000
            workContexts[index].updatedAt = now
            workContexts[index].activity.append(
                WorkActivityEntry(
                    id: "delegated-\(UUID().uuidString)", occurredAt: now,
                    kind: "delegated", summary: "已交給 \(provider.displayName) 執行下一步", sourceMessageId: nil))
            WorkContextStore.save(workContexts)
        }
        if provider == .yomiZeroConfig {
            sendAiQuery(prompt: prompt)
        } else {
            chatMessages.append(ChatMessageItem(isUser: true, text: prompt, toolCall: nil))
            startCodingToolAgent(prompt: prompt, provider: provider)
        }
    }

    @MainActor
    func shareActiveWork() {
        guard let work = activeWorkContext else { return }
        materializeWorkMaterials(work) { urls in
            WorkContextSharing.present(work: work, materialURLs: urls)
        }
    }
}

extension String {
    fileprivate var nilIfBlank: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

// NSSharingServicePicker must be created and shown on the main thread, so the
// picker is main-actor isolated rather than a shared mutable static.
@MainActor
private enum WorkContextSharing {
    private static var activePicker: NSSharingServicePicker?

    static func present(work: YomiWorkContext, materialURLs: [URL]) {
        guard let view = NSApp.keyWindow?.contentView else { return }
        let pointers = work.materials.map {
            "- chatId: \($0.chatId), messageId: \($0.messageId), mediaType: \($0.mediaType ?? "text")"
        }.joined(separator: "\n")
        let brief = """
            # \(work.title)

            Work ID: \(work.id)
            狀態：\(work.status)
            來源：\(work.sourceChatName)（\(work.materials.count) 則訊息）
            發起人：\(work.initiator ?? "待確認")
            負責人：\(work.owner ?? "待確認")
            協作人：\(work.collaborators.joined(separator: "、"))
            外部對象：\(work.externalParties.joined(separator: "、"))
            交付物：\(work.deliverables.joined(separator: "、"))
            待確認：\(work.openQuestions.joined(separator: "、"))
            下一步：\(work.nextStep)

            ## Yomi LINE resource pointers
            \(pointers)

            若已連接 Yomi MCP，請用 get_chat_messages / get_message_media 直接讀取完整來源；否則使用一併分享的附件。不要要求使用者重新下載或附加。
            """
        let items: [Any] = [brief as NSString] + materialURLs
        let picker = NSSharingServicePicker(items: items)
        activePicker = picker
        picker.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
    }
}
