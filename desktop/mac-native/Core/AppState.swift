import AVFoundation
import Cocoa
import Combine
import Dispatch
import SwiftUI
import UniformTypeIdentifiers

enum InboxRefreshIntent: String {
    case startup
    case manual
    case periodic
    case lifecycle
    case retry

    var priority: Int {
        switch self {
        case .manual, .retry: return 2
        case .startup: return 1
        case .periodic, .lifecycle: return 0
        }
    }
}

enum InboxRefreshPhase: String {
    case idle
    case syncing
    case hydratingMessages
    case classifying
    case observing
    case publishing
    case failed
}

final class InboxRefreshCoordinator {
    private(set) var generation: UInt64 = 0
    private(set) var phase: InboxRefreshPhase = .idle
    private(set) var currentIntent: InboxRefreshIntent?
    private var queuedIntent: InboxRefreshIntent?

    var isRunning: Bool { phase != .idle && phase != .failed }

    func request(
        _ intent: InboxRefreshIntent,
        start: (_ generation: UInt64, _ intent: InboxRefreshIntent) -> Void
    ) {
        if isRunning {
            if queuedIntent == nil || intent.priority > queuedIntent!.priority {
                queuedIntent = intent
            }
            return
        }
        generation &+= 1
        currentIntent = intent
        phase = .syncing
        start(generation, intent)
    }

    func transition(to next: InboxRefreshPhase, generation: UInt64) -> Bool {
        guard generation == self.generation, isRunning else { return false }
        phase = next
        return true
    }

    func finish(
        generation: UInt64,
        succeeded: Bool,
        restart: (_ generation: UInt64, _ intent: InboxRefreshIntent) -> Void
    ) {
        guard generation == self.generation else { return }
        phase = succeeded ? .idle : .failed
        currentIntent = nil
        guard let queuedIntent else { return }
        self.queuedIntent = nil
        phase = .idle
        request(queuedIntent, start: restart)
    }
}

struct DesktopMessageDecodeBatch {
    let messages: [LineChatMessage]
    let inputCount: Int
    let failureCount: Int
}

final class DesktopRefreshCallback: @unchecked Sendable {
    let call: (Bool) -> Void
    init(_ call: @escaping (Bool) -> Void) { self.call = call }
}

struct PendingReadCursor {
    let readThroughTimestamp: Double
    let createdAt: Date
}

func decodeDesktopMessageBatch(_ data: Data) -> DesktopMessageDecodeBatch? {
    guard let values = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return nil }
    let decoder = JSONDecoder()
    var messages: [LineChatMessage] = []
    var failures = 0
    for value in values {
        guard JSONSerialization.isValidJSONObject(value),
            let item = try? JSONSerialization.data(withJSONObject: value),
            let message = try? decoder.decode(LineChatMessage.self, from: item)
        else {
            failures += 1
            continue
        }
        messages.append(message)
    }
    return DesktopMessageDecodeBatch(
        messages: messages, inputCount: values.count, failureCount: failures)
}

final class IntegrationCallbackBox: @unchecked Sendable {
    let call: (Bool, String) -> Void
    init(_ call: @escaping (Bool, String) -> Void) { self.call = call }
}

// MARK: - State Observable Object

enum SyncMode: String, CaseIterable, Identifiable {
    case realtime = "Realtime Push (長輪詢即時)"
    case interval1m = "Periodic 1 min (定時 1 分鐘)"
    case interval5m = "Periodic 5 min (定時 5 分鐘)"

    var id: String { self.rawValue }
    var shortLabel: String {
        switch self {
        case .realtime: return "Realtime"
        case .interval1m: return "Every 1m"
        case .interval5m: return "Every 5m"
        }
    }

    @MainActor
    func localizedLabel(using i18n: I18n) -> String {
        switch self {
        case .realtime: return i18n.t("settings_realtime")
        case .interval1m: return i18n.t("settings_every_1m")
        case .interval5m: return i18n.t("settings_every_5m")
        }
    }
}

// MARK: - Deterministic attention policy

enum AttentionTier: String, Codable, CaseIterable {
    case pending, now, today, know, filtered

    var label: String {
        switch self {
        case .pending: return "分析中"
        case .now: return "現在處理"
        case .today: return "今天處理"
        case .know: return "值得知道"
        case .filtered: return "已過濾"
        }
    }
}

struct AttentionEvaluation: Equatable {
    let score: Int
    let tier: AttentionTier
    let reason: String
}

enum YomiAttentionPolicyStore {
    private static let priorityKey = "yomi_attention_priority"
    private static let mutedKey = "yomi_attention_muted"

    private static func ids(for key: String) -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
    }

    private static func save(_ ids: Set<String>, key: String) {
        UserDefaults.standard.set(Array(ids).sorted(), forKey: key)
    }

    static func isPriority(_ id: String) -> Bool { ids(for: priorityKey).contains(id) }
    static func isMuted(_ id: String) -> Bool { ids(for: mutedKey).contains(id) }
    static func setPriority(_ id: String, enabled: Bool) {
        var values = ids(for: priorityKey)
        if enabled { values.insert(id) } else { values.remove(id) }
        save(values, key: priorityKey)
    }
    static func setMuted(_ id: String, enabled: Bool) {
        var values = ids(for: mutedKey)
        if enabled { values.insert(id) } else { values.remove(id) }
        save(values, key: mutedKey)
    }
}

extension LineChatItem {
    var effectiveMuted: Bool { isMuted || YomiAttentionPolicyStore.isMuted(id) }

    var attentionEvaluation: AttentionEvaluation {
        if effectiveMuted { return AttentionEvaluation(score: -100, tier: .filtered, reason: "muted") }
        if YomiAttentionPolicyStore.isPriority(id) { return AttentionEvaluation(score: 70, tier: .now, reason: "manual_priority") }
        guard ![.pending, .filtered].contains(attentionTier), !hasMention else {
            return AttentionEvaluation(score: attentionScore, tier: attentionTier, reason: attentionReason)
        }
        let bias = YomiAttentionLearningStore.bias(for: id)
        let score = min(70, max(-100, attentionScore + bias))
        let tier: AttentionTier = score >= 55 ? .now : score >= 35 ? .today : score >= 20 ? .know : .filtered
        let reason = tier == attentionTier ? attentionReason : (bias > 0 ? "personalized_up" : "personalized_down")
        return AttentionEvaluation(score: score, tier: tier, reason: reason)
    }

    func localizedAttentionReason(using i18n: I18n) -> String {
        i18n.t("attention_reason_\(attentionEvaluation.reason)")
    }
}

// Appearance is a user-facing preference, not a diagnostic setting. Keep it
// persisted so the main window and the settings page always agree.
enum AppAppearance: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "跟隨系統"
        case .light: return "淺色"
        case .dark: return "深色"
        }
    }

    @MainActor
    func label(using i18n: I18n) -> String {
        switch self {
        case .system: return i18n.t("settings_system")
        case .light: return i18n.t("settings_light")
        case .dark: return i18n.t("settings_dark")
        }
    }

    var icon: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max.fill"
        case .dark: return "moon.fill"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

struct IdeIntegrationItem: Identifiable {
    let id: String
    let name: String
    let badge: String
    let icon: String
    let details: String
    var isIntegrated: Bool
}

struct ChatMessageItem: Identifiable, Equatable {
    let id = UUID()
    let isUser: Bool
    var text: String
    var toolCall: String?
    let timestamp: Date = Date()
}

final class AppState: ObservableObject, @unchecked Sendable {
    @Published var i18n = I18n.shared
    @Published var isConnected: Bool = false
    @Published var mid: String = ""
    @Published var displayName: String = ""
    @Published var pictureUrl: String = ""
    @Published var statusMessage: String = ""
    @Published var isSyncing: Bool = false
    @Published var notificationsEnabled: Bool = true
    @Published var hasUnreadAttention: Bool = false
    @Published var unreadCount: Int = 0
    @Published var syncMode: SyncMode = .realtime
    /// Empty until the first sync has actually completed.  The UI must never
    /// imply freshness before the bridge returns a valid conversations payload.
    @Published var lastSyncTimeString: String = ""
    @Published var syncError: String? = nil

    @Published var isIntegrating: Bool = false

    // AI Chat & Provider State
    @Published var aiConfig: AiConfig = AiConfigManager.loadConfig()
    @Published var chatMessages: [ChatMessageItem] = []
    @Published var isAiThinking: Bool = false
    @Published var codexStatus: String = "尚未啟動"
    @Published var codexApprovalRequest: AgentApprovalRequest?
    @Published var codexElicitationRequest: AgentElicitationRequest?
    @Published var isShowingAiSettings: Bool = false
    @Published var agentHealthMap: [AiProviderType: AgentHealthStatus] = [:]

    // AI App Detection
    @Published var isClaudeAppInstalled: Bool = false
    @Published var isCodexAppInstalled: Bool = false
    @Published var isSpotlightPinned: Bool = false

    // Real Decrypted LINE Chat State
    @Published var chats: [LineChatItem] = []
    @Published var selectedChatId: String? = nil
    @Published var currentChatMessages: [LineChatMessage] = []
    @Published var currentBuddyRichMenu: BuddyRichMenu?
    @Published var stickerPackages: [StickerPackageItem] = []
    @Published var stickerPreviews: [StickerPreviewItem] = []
    @Published var isLoadingStickers: Bool = false
    @Published var stickerLoadError: String? = nil
    @Published var mediaPreviewImages: [String: NSImage] = [:]
    @Published var mediaPreviewAudioData: [String: Data] = [:]
    @Published var mediaPreviewAudioMIMEs: [String: String] = [:]
    @Published var mediaPreviewVideoURLs: [String: URL] = [:]
    @Published var mediaPreviewFailures: Set<String> = []
    @Published var mediaDownloadingMessageIds: Set<String> = []
    @Published var mediaDownloadedFileURLs: [String: URL] = [:]
    var mediaOriginalLoaded = Set<String>()
    var mediaPreviewImageCosts: [String: Int] = [:]
    var mediaPreviewImageAccess: [String: Date] = [:]
    var mediaPreviewAudioAccess: [String: Date] = [:]
    @Published var isLoadingChats: Bool = false
    @Published private(set) var inboxRefreshPhase: InboxRefreshPhase = .idle
    @Published private(set) var inboxRefreshGeneration: UInt64 = 0
    let inboxRefreshCoordinator = InboxRefreshCoordinator()
    /// True only after the first chats payload has been successfully decoded.
    /// This prevents the pre-load state from being presented as an empty inbox.
    @Published var hasLoadedChatsOnce: Bool = false
    @Published var chatLoadError: String? = nil
    @Published var isLoadingMessages: Bool = false
    @Published var messageLoadError: String? = nil
    @Published private(set) var messageDecodeFailureCount: Int = 0
    @Published private(set) var messageCacheSource: String = "none"
    @Published private(set) var messageCachePaintLatencyMs: Double = 0
    var pendingReadCursors: [String: PendingReadCursor] = [:]
    /// The conversation whose content is currently visible in the main pane.
    /// Selection alone is insufficient: settings and briefing can replace the
    /// detail surface without changing the selected chat.
    var visibleConversationId: String?
    /// LINE may publish a conversation-list operation before the matching
    /// history page becomes readable. Track one delayed retry so that a
    /// transient empty page is never presented as a genuinely empty chat.
    var messageEmptyRetryChats = Set<String>()
    @Published var showAttentionOnly: Bool = true
    // Composer is always a direct LINE reply. AI is an optional assist layer.
    @Published var appearance: AppAppearance {
        didSet {
            UserDefaults.standard.set(appearance.rawValue, forKey: "yomi_appearance")
        }
    }
    @Published var isSendingReply: Bool = false
    @Published var replyFeedback: String? = nil
    @Published var replyFeedbackIsError: Bool = false
    @Published var ambientObservationSnapshot: AmbientObservationSnapshot?
    /// Persistent Work Items are intentionally separate from attention
    /// briefing cards. They represent event clusters, not individual
    /// messages, and are promoted by the shared ambient pipeline.
    @Published var workItems: [AmbientWorkItem] = []
    @Published var workContexts: [YomiWorkContext] = []
    @Published var workPreview: YomiWorkContext?
    @Published var activeWorkContextId: String?
    @Published var isAmbientObserverRunning: Bool = false
    @Published var ambientObserverError: String?

    var onUnreadStatusChanged: ((Bool) -> Void)?
    var onSessionEnded: (() -> Void)?

    private var pollTimer: Timer?
    private var chatPollTimer: Timer?
    var ambientObserverTimer: Timer?
    var ambientRefreshQueued = false
    var ambientRefreshCallbacks: [DesktopRefreshCallback] = []
    let ambientObserverOCRQueue = DispatchQueue(label: "dev.rikai.yomi.ambient-ocr", qos: .utility)
    var ambientObserverOCRQueued = Set<String>()
    var mediaPreviewLoading = Set<String>()
    private var semanticRefreshRunning = false
    private var semanticRefreshCallbacks: [DesktopRefreshCallback] = []
    private var chatRefreshInFlight = false
    private var i18nObservation: AnyCancellable?
    var agentBackend: AgentBackend?
    private var messageLoadGeneration: UInt64 = 0
    var messageCache: [String: [LineChatMessage]] = [:]
    private var messageRefreshInFlight = Set<String>()
    private var messageLastRefresh: [String: Date] = [:]
    private var hasStartedStartupMessageHydration = false
    static func bridgeEnvironment() -> [String: String] {
        // The native desktop owns one user-only credential file. Child Node
        // bridges must share it directly instead of invoking macOS' `security`
        // CLI, which would make every short-lived bridge a new Keychain client
        // and repeatedly prompt for the login password.
        var environment = ProcessInfo.processInfo.environment
        environment["YOMI_NO_KEYCHAIN"] = "1"
        return environment
    }

    init() {
        self.workContexts = WorkContextStore.load()
        let savedAppearance = UserDefaults.standard.string(forKey: "yomi_appearance") ?? AppAppearance.system.rawValue
        self.appearance = AppAppearance(rawValue: savedAppearance) ?? .system
        self.ambientObservationSnapshot = AmbientObservationStore.load()
        self.workItems = self.ambientObservationSnapshot?.workItems ?? []
        // I18n is shared across the app. Forward its published language
        // changes through AppState so every view observing state redraws
        // immediately instead of only updating the segmented picker.
        self.i18nObservation = I18n.shared.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
        loadCachedChatSnapshot()
        checkInstalledAiApps()
        refreshState()
        if CredentialManager.loadCredentials()?.lineAuthToken?.isEmpty == false {
            refreshInbox(.startup)
        }
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.refreshState()
        }
        chatPollTimer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { [weak self] _ in
            guard let self = self, self.isConnected else { return }
            self.refreshInbox(.periodic)
        }
        startAmbientObserver()
    }

    func checkInstalledAiApps() {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? ""
        let claudeApp = FileManager.default.fileExists(atPath: "/Applications/Claude.app")
        let claudeDir = FileManager.default.fileExists(atPath: "\(home)/Library/Application Support/Claude")
        self.isClaudeAppInstalled = claudeApp || claudeDir

        let codexDir = FileManager.default.fileExists(atPath: "\(home)/.codex")
        let chatgptApp = FileManager.default.fileExists(atPath: "/Applications/ChatGPT.app")
        self.isCodexAppInstalled = codexDir || chatgptApp
    }

    func updateAiConfig(_ config: AiConfig) {
        self.aiConfig = config
        AiConfigManager.saveConfig(config)
    }

    func refreshInbox(_ intent: InboxRefreshIntent = .manual) {
        inboxRefreshCoordinator.request(intent) { [weak self] generation, acceptedIntent in
            self?.runInboxRefresh(generation: generation, intent: acceptedIntent)
        }
    }

    private func runInboxRefresh(generation: UInt64, intent: InboxRefreshIntent) {
        inboxRefreshGeneration = generation
        inboxRefreshPhase = .syncing
        loadRecentChats(silent: intent == .periodic) { [weak self] chatsSucceeded in
            guard let self, chatsSucceeded else {
                self?.finishInboxRefresh(generation: generation, succeeded: false)
                return
            }
            let continueRefresh: () -> Void = { [weak self] in
                guard let self else { return }
                self.continueInboxRefresh(generation: generation, intent: intent)
            }
            guard intent == .startup, !self.hasStartedStartupMessageHydration else {
                continueRefresh()
                return
            }

            self.hasStartedStartupMessageHydration = true
            guard self.inboxRefreshCoordinator.transition(to: .hydratingMessages, generation: generation) else {
                return
            }
            self.inboxRefreshPhase = .hydratingMessages
            self.isSyncing = true
            self.hydrateStartupMessageCache(completion: continueRefresh)
        }
    }

    private func continueInboxRefresh(generation: UInt64, intent: InboxRefreshIntent) {
        guard self.inboxRefreshCoordinator.transition(to: .classifying, generation: generation) else { return }
        self.inboxRefreshPhase = .classifying
        self.isSyncing = intent != .periodic
        self.refreshSemanticAttention { [weak self] classificationSucceeded in
            guard let self else { return }
            if intent == .periodic {
                self.finishInboxRefresh(
                    generation: generation,
                    succeeded: classificationSucceeded)
                return
            }
            guard self.inboxRefreshCoordinator.transition(to: .observing, generation: generation) else { return }
            self.inboxRefreshPhase = .observing
            self.refreshAmbientObservations { [weak self] observationSucceeded in
                guard let self,
                    self.inboxRefreshCoordinator.transition(to: .publishing, generation: generation)
                else { return }
                self.inboxRefreshPhase = .publishing
                let unresolvedChatIDs = Set(
                    self.ambientObservationSnapshot?.candidates
                        .filter { $0.responseState != "received" }
                        .map(\.chatId) ?? [])
                self.hasUnreadAttention = self.chats.contains { item in
                    !YomiAttentionPolicyStore.isMuted(item.id)
                        && (item.needsAttention || unresolvedChatIDs.contains(item.id))
                }
                self.onUnreadStatusChanged?(self.hasUnreadAttention)
                self.finishInboxRefresh(
                    generation: generation,
                    succeeded: classificationSucceeded && observationSucceeded)
            }
        }
    }

    private func finishInboxRefresh(generation: UInt64, succeeded: Bool) {
        inboxRefreshCoordinator.finish(
            generation: generation,
            succeeded: succeeded
        ) { [weak self] nextGeneration, nextIntent in
            self?.runInboxRefresh(generation: nextGeneration, intent: nextIntent)
        }
        inboxRefreshPhase = inboxRefreshCoordinator.phase
        inboxRefreshGeneration = inboxRefreshCoordinator.generation
        isSyncing = inboxRefreshCoordinator.currentIntent.map { $0 != .periodic } ?? false
    }

    func refreshState() {
        if let creds = CredentialManager.loadCredentials(),
            let token = creds.lineAuthToken, !token.isEmpty
        {
            let loadedMid = creds.lineMid ?? "Active"
            let loadedName = creds.displayName ?? "LINE User"
            let rawPic = creds.pictureUrl ?? (creds.picturePath != nil ? "https://obs.line-scdn.net/\(creds.picturePath!)" : "")
            let loadedPic = rawPic.replacingOccurrences(of: "line-scdn.net//", with: "line-scdn.net/")
            let loadedStatus = creds.statusMessage ?? ""

            DispatchQueue.main.async {
                let justConnected = !self.isConnected
                if justConnected { self.isConnected = true }
                if self.mid != loadedMid { self.mid = loadedMid }
                if self.displayName != loadedName { self.displayName = loadedName }
                if self.pictureUrl != loadedPic { self.pictureUrl = loadedPic }
                if self.statusMessage != loadedStatus { self.statusMessage = loadedStatus }
                // Start a full sync when credentials become available.
                if justConnected { self.refreshInbox(.startup) }
            }
        } else {
            DispatchQueue.main.async {
                if self.isConnected { self.isConnected = false }
                if !self.mid.isEmpty { self.mid = "" }
                if !self.displayName.isEmpty { self.displayName = "" }
                if !self.pictureUrl.isEmpty { self.pictureUrl = "" }
                if !self.statusMessage.isEmpty { self.statusMessage = "" }
                if self.hasUnreadAttention { self.hasUnreadAttention = false }
                if self.unreadCount != 0 { self.unreadCount = 0 }
                self.onUnreadStatusChanged?(false)
            }
        }
    }

    func loadRecentChats(silent: Bool = false, completion: ((Bool) -> Void)? = nil) {
        let callback = completion.map(DesktopRefreshCallback.init)
        guard !chatRefreshInFlight else {
            callback?.call(false)
            return
        }
        chatRefreshInFlight = true
        // A silent poll must still expose loading feedback when it is the first
        // load. Once a payload has been shown, keep the current list stable while
        // background polling refreshes it.
        let shouldShowLoading = !hasLoadedChatsOnce
        if shouldShowLoading || !silent {
            self.isLoadingChats = true
            self.chatLoadError = nil
        }
        if !silent { self.isSyncing = true }

        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            self.isLoadingChats = false
            self.isSyncing = false
            self.chatRefreshInFlight = false
            self.chatLoadError = "Node.js or Yomi runtime is unavailable."
            self.syncError = self.chatLoadError
            callback?.call(false)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let process = DesktopBridgeRunner.makeProcess(nodePath: nodePath, paths: paths)
            process.launchPath = nodePath
            process.environment = Self.bridgeEnvironment()
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "desktop-inbox"]

            let pipe = DesktopBridgeRunner.outputPipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice

            do {
                try DesktopBridgeRunner.start(process)
                let data = DesktopBridgeRunner.read(pipe)
                DesktopBridgeRunner.wait(process)

                if DesktopBridgeRunner.status(process) == 0,
                    let jsonStr = String(data: data, encoding: .utf8),
                    let jsonStart = jsonStr.firstIndex(of: "{")
                {
                    let cleanJson = String(jsonStr[jsonStart...])
                    if let jsonData = cleanJson.data(using: .utf8),
                        let response = try? JSONDecoder().decode(DesktopInboxBridgeResponse.self, from: jsonData)
                    {
                        let decoded = response.chats
                        DispatchQueue.main.async {
                            guard response.session.connected else {
                                self.chatRefreshInFlight = false
                                self.isSyncing = false
                                self.handleLineSessionEnded(reason: response.session.reason)
                                callback?.call(false)
                                return
                            }
                            let previousChats = self.chats
                            let selectedID = self.selectedChatId
                            let previousSelectedTimestamp = selectedID.flatMap { id in
                                previousChats.first(where: { $0.id == id })?.timestampValue
                            }
                            let incoming = decoded.map { item in
                                var safe = item
                                safe.lastMessage = sanitizeDesktopMessagePreview(item.lastMessage)
                                if let cursor = self.pendingReadCursors[item.id] {
                                    if item.unreadCount == 0 {
                                        self.pendingReadCursors.removeValue(forKey: item.id)
                                    } else if Date().timeIntervalSince(cursor.createdAt) < 60,
                                        item.timestampValue <= cursor.readThroughTimestamp
                                    {
                                        safe.unreadCount = 0
                                    } else {
                                        self.pendingReadCursors.removeValue(forKey: item.id)
                                    }
                                }
                                return safe
                            }
                            if incoming != self.chats { self.chats = incoming }
                            if let selected = self.selectedChatId,
                                !decoded.contains(where: { $0.id == selected })
                            {
                                self.selectedChatId = nil
                                self.currentChatMessages = []
                            }
                            self.hasLoadedChatsOnce = true
                            if self.chats != previousChats { DesktopChatSnapshotStore.save(self.chats) }
                            self.chatLoadError = nil
                            self.isLoadingChats = false
                            self.chatRefreshInFlight = false

                            let totalUnread = self.chats.reduce(0) { $0 + $1.unreadCount }
                            let hasAttention = self.chats.contains { $0.needsAttention }
                            if self.unreadCount != totalUnread { self.unreadCount = totalUnread }
                            if self.hasUnreadAttention != hasAttention {
                                self.hasUnreadAttention = hasAttention
                                self.onUnreadStatusChanged?(hasAttention)
                            }
                            if !silent { self.isSyncing = false }
                            self.syncError = nil
                            let formatter = DateFormatter()
                            formatter.dateFormat = "HH:mm"
                            let syncedAt = formatter.string(from: Date())
                            if self.lastSyncTimeString != syncedAt { self.lastSyncTimeString = syncedAt }

                            if let selected = selectedID,
                                let nextTimestamp = self.chats.first(where: { $0.id == selected })?.timestampValue,
                                nextTimestamp != previousSelectedTimestamp
                            {
                                self.loadChatMessages(chatId: selected, showLoading: false, markReadOnSuccess: false)
                            }
                            callback?.call(true)
                        }
                        return
                    }
                }
            } catch {}

            DispatchQueue.main.async {
                self.isLoadingChats = false
                self.isSyncing = false
                self.chatRefreshInFlight = false
                self.chatLoadError = "Unable to decode the LINE conversations response."
                self.syncError = self.chatLoadError
                callback?.call(false)
            }
        }
    }

    private func loadCachedChatSnapshot() {
        DesktopChatSnapshotStore.loadAsync { [weak self] cachedChats in
            guard let self, !cachedChats.isEmpty else { return }
            self.chats = cachedChats.map { item in
                var safe = item
                safe.lastMessage = sanitizeDesktopMessagePreview(item.lastMessage)
                return safe
            }
            self.hasLoadedChatsOnce = true
            self.unreadCount = self.chats.reduce(0) { $0 + $1.unreadCount }
            self.hasUnreadAttention = self.chats.contains(where: \.needsAttention)
        }
    }

    /// Refine only uncached unread previews after the usable inbox has already
    /// painted. Results are persisted by the bridge and merged without showing
    /// a global loading state.
    private func refreshSemanticAttention(completion: ((Bool) -> Void)? = nil) {
        if let completion { semanticRefreshCallbacks.append(DesktopRefreshCallback(completion)) }
        guard !semanticRefreshRunning else { return }
        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            finishSemanticRefresh(succeeded: false)
            return
        }
        let pending = Array(chats.filter { $0.attentionTier == .pending }.prefix(8))
        guard !pending.isEmpty else {
            finishSemanticRefresh(succeeded: true)
            return
        }
        guard let payload = try? JSONEncoder().encode(pending) else {
            finishSemanticRefresh(succeeded: false)
            return
        }
        semanticRefreshRunning = true
        DispatchQueue.global(qos: .utility).async {
            let process = DesktopBridgeRunner.makeProcess(nodePath: nodePath, paths: paths)
            process.launchPath = nodePath
            process.environment = Self.bridgeEnvironment()
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "attention-classify"]
            let outputPipe = DesktopBridgeRunner.outputPipe()
            let inputPipe = DesktopBridgeRunner.outputPipe()
            process.standardOutput = outputPipe
            process.standardError = FileHandle.nullDevice
            process.standardInput = inputPipe
            do {
                try DesktopBridgeRunner.start(process)
                inputPipe.fileHandleForWriting.write(payload)
                try? inputPipe.fileHandleForWriting.close()
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 120) {
                    if DesktopBridgeRunner.isRunning(process) { DesktopBridgeRunner.terminate(process) }
                }
                let data = DesktopBridgeRunner.read(outputPipe)
                DesktopBridgeRunner.wait(process)
                if DesktopBridgeRunner.status(process) == 0,
                    let raw = String(data: data, encoding: .utf8),
                    let start = raw.firstIndex(of: "["),
                    let json = String(raw[start...]).data(using: .utf8),
                    let refined = try? JSONDecoder().decode([AttentionRefinement].self, from: json)
                {
                    DispatchQueue.main.async {
                        let byID = Dictionary(uniqueKeysWithValues: refined.map { ($0.id, $0) })
                        self.chats = self.chats.map { item in
                            guard let value = byID[item.id] else { return item }
                            var updated = item
                            updated.attentionScore = value.attentionScore
                            updated.attentionTier = value.attentionTier
                            updated.attentionReason = value.attentionReason
                            return updated
                        }
                        self.hasUnreadAttention = self.chats.contains(where: \.needsAttention)
                        self.onUnreadStatusChanged?(self.hasUnreadAttention)
                        DesktopChatSnapshotStore.save(self.chats)
                        self.semanticRefreshRunning = false
                        if self.chats.contains(where: { $0.attentionTier == .pending }) {
                            self.refreshSemanticAttention()
                        } else {
                            self.finishSemanticRefresh(succeeded: true)
                        }
                    }
                    return
                }
            } catch {}
            DispatchQueue.main.async {
                self.semanticRefreshRunning = false
                self.finishSemanticRefresh(succeeded: false)
            }
        }
    }

    private func finishSemanticRefresh(succeeded: Bool) {
        let callbacks = semanticRefreshCallbacks
        semanticRefreshCallbacks.removeAll()
        for callback in callbacks { callback.call(succeeded) }
    }

    func loadChatMessages(chatId: String, showLoading: Bool = true, markReadOnSuccess: Bool = false) {
        guard !chatId.isEmpty else { return }
        let shouldMarkRead = markReadOnSuccess || visibleConversationId == chatId
        let isSwitchingChat = self.selectedChatId != chatId
        if isSwitchingChat { messageLoadGeneration &+= 1 }
        let generation = messageLoadGeneration
        self.selectedChatId = chatId
        self.loadBuddyRichMenu(chatId: chatId)
        // Memory cache is the fast path. Disk decryption stays off-main so
        // opening a conversation never blocks the first paint.
        let cached = messageCache[chatId] ?? []
        let listTimestamp = chats.first(where: { $0.id == chatId })?.timestampValue ?? 0
        let cachedIsCurrent = (cached.last?.timestamp ?? 0) >= listTimestamp
        if !cached.isEmpty {
            messageCache[chatId] = cached
            self.currentChatMessages = cached
            self.isLoadingMessages = false
            self.messageLoadError = nil
            self.messageCacheSource = "memory"
            self.messageCachePaintLatencyMs = 0
            if shouldMarkRead, cachedIsCurrent { self.markChatRead(chatId: chatId) }
        } else if isSwitchingChat {
            self.currentChatMessages = []
            // Give the encrypted disk snapshot one frame budget before
            // escalating to a full skeleton. A cache hit should paint as
            // content, never flash a network-loading placeholder first.
            self.isLoadingMessages = false
            self.messageCacheSource = "none"
        } else if showLoading || self.currentChatMessages.isEmpty {
            self.isLoadingMessages = true
        }
        self.messageLoadError = nil

        if messageRefreshInFlight.contains(chatId) { return }
        if !cached.isEmpty, cachedIsCurrent,
            let refreshedAt = messageLastRefresh[chatId],
            Date().timeIntervalSince(refreshedAt) < 15
        {
            return
        }

        if messageCache[chatId] == nil {
            let diskLoadStartedAt = Date()
            DesktopMessageSnapshotStore.loadAsync(accountId: self.mid, chatId: chatId) { [weak self] diskMessages in
                guard let self, !diskMessages.isEmpty,
                    self.selectedChatId == chatId,
                    self.messageLoadGeneration == generation,
                    self.currentChatMessages.isEmpty
                else { return }
                self.messageCache[chatId] = diskMessages
                self.currentChatMessages = diskMessages
                self.isLoadingMessages = false
                self.messageLoadError = nil
                self.messageCacheSource = "disk"
                self.messageCachePaintLatencyMs = Date().timeIntervalSince(diskLoadStartedAt) * 1000
            }
        }

        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            self.isLoadingMessages = false
            self.messageLoadError = "找不到訊息服務。請重新整理後再試一次。"
            return
        }
        messageRefreshInFlight.insert(chatId)
        if self.currentChatMessages.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
                guard let self, self.selectedChatId == chatId,
                    self.messageLoadGeneration == generation,
                    self.currentChatMessages.isEmpty,
                    self.messageRefreshInFlight.contains(chatId)
                else { return }
                self.isLoadingMessages = true
            }
        }
        // The first load of a large E2EE group may need to restore keys and
        // decode media metadata before it can emit JSON. Cached conversations
        // keep a tighter background-refresh bound because content is already
        // visible and a later poll can safely try again.
        let bridgeTimeout: TimeInterval = cached.isEmpty ? 20 : 12

        DispatchQueue.global(qos: .userInitiated).async {
            let process = DesktopBridgeRunner.makeProcess(nodePath: nodePath, paths: paths)
            process.launchPath = nodePath
            process.environment = Self.bridgeEnvironment()
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "messages", chatId, "40"]

            let pipe = DesktopBridgeRunner.outputPipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice

            do {
                try DesktopBridgeRunner.start(process)
                // A stuck bridge must never hold the detail pane forever.
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + bridgeTimeout) {
                    if DesktopBridgeRunner.isRunning(process) { DesktopBridgeRunner.terminate(process) }
                }
                let data = DesktopBridgeRunner.read(pipe)
                DesktopBridgeRunner.wait(process)

                if let jsonStr = String(data: data, encoding: .utf8),
                    let jsonStart = jsonStr.firstIndex(of: "[")
                {
                    let cleanJson = String(jsonStr[jsonStart...])
                    if let jsonData = cleanJson.data(using: .utf8),
                        let batch = decodeDesktopMessageBatch(jsonData),
                        batch.inputCount == 0 || !batch.messages.isEmpty
                    {
                        DispatchQueue.main.async {
                            self.messageRefreshInFlight.remove(chatId)
                            guard self.selectedChatId == chatId, self.messageLoadGeneration == generation else { return }
                            self.messageDecodeFailureCount = batch.failureCount
                            let messages = batch.messages.map { message in
                                var safe = message
                                safe.text = sanitizeDesktopMessagePreview(message.text)
                                return safe
                            }
                            let displayed =
                                self.currentChatMessages.isEmpty
                                ? (self.messageCache[chatId] ?? [])
                                : self.currentChatMessages
                            if messages.isEmpty, displayed.isEmpty, listTimestamp > 0 {
                                if !self.messageEmptyRetryChats.contains(chatId) {
                                    self.messageEmptyRetryChats.insert(chatId)
                                    self.isLoadingMessages = true
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                                        guard self.selectedChatId == chatId else { return }
                                        self.loadChatMessages(
                                            chatId: chatId,
                                            showLoading: false,
                                            markReadOnSuccess: shouldMarkRead)
                                    }
                                    return
                                }
                                self.messageEmptyRetryChats.remove(chatId)
                                self.isLoadingMessages = false
                                self.messageLoadError = self.i18n.t("message_history_not_ready")
                                return
                            }
                            self.messageEmptyRetryChats.remove(chatId)
                            let merged = DesktopMessageSnapshotStore.merge(existing: displayed, incoming: messages)
                            self.messageCache[chatId] = merged
                            DesktopMessageSnapshotStore.save(merged, accountId: self.mid, chatId: chatId)
                            self.currentChatMessages = merged
                            self.messageCacheSource = "network"
                            if let latest = merged.last,
                                let chatIndex = self.chats.firstIndex(where: { $0.id == chatId }),
                                (latest.timestamp ?? 0) >= self.chats[chatIndex].timestampValue
                            {
                                self.chats[chatIndex].lastMessage = latest.text
                                self.chats[chatIndex].timeString = latest.timeString
                                self.chats[chatIndex].timestamp = latest.timestamp
                                DesktopChatSnapshotStore.save(self.chats)
                            }
                            self.messageLastRefresh[chatId] = Date()
                            self.isLoadingMessages = false
                            self.messageLoadError = nil
                            // Reading follows successful presentation, never a row click.
                            if shouldMarkRead { self.markChatRead(chatId: chatId) }
                        }
                        return
                    }
                }
            } catch {}

            DispatchQueue.main.async {
                self.messageRefreshInFlight.remove(chatId)
                guard self.selectedChatId == chatId, self.messageLoadGeneration == generation else { return }
                self.isLoadingMessages = false
                self.messageLoadError = "這個對話暫時載入不了。請再試一次。"
            }
        }
    }

    func clearAttentionAlert() {
        if hasUnreadAttention {
            hasUnreadAttention = false
            unreadCount = 0
            onUnreadStatusChanged?(false)
        }
    }

    /// Yomi attention policy is intentionally separate from LINE's
    /// notificationDisabled flag. This is local, reversible, and survives
    /// syncs without pretending that the LINE protocol mutation succeeded.
    func setYomiMuted(chatId: String, enabled: Bool) {
        YomiAttentionPolicyStore.setMuted(chatId, enabled: enabled)
        objectWillChange.send()
        replyFeedbackIsError = false
        replyFeedback = i18n.t(enabled ? "attention_excluded_success" : "attention_restored_success")
    }

    func setYomiPriority(chatId: String, enabled: Bool) {
        YomiAttentionPolicyStore.setPriority(chatId, enabled: enabled)
        objectWillChange.send()
        replyFeedbackIsError = false
        replyFeedback = enabled ? "已標記為 Yomi 優先對話" : "已取消 Yomi 優先標記"
    }

    func reportUnsupportedLineMute(chatId: String) {
        // The current Talk service exposes notificationDisabled as read-only;
        // do not show a false-success state or silently mutate local policy.
        replyFeedbackIsError = true
        replyFeedback = i18n.t("line_mute_unsupported")
    }

}
