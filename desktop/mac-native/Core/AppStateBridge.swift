import Foundation

struct DesktopInboxBridgeResponse: Decodable {
    let session: DesktopBridgeSession
    let chats: [LineChatItem]
}

struct DesktopBridgeSession: Decodable {
    let connected: Bool
    let reason: String?
}

private struct DesktopStartupMessagesResponse: Decodable {
    let session: DesktopBridgeSession
    let messages: [String: [LineChatMessage]]
}

/// Owns the short-lived Node bridge lifecycle. AppState only prepares command
/// arguments and maps the returned bytes into observable state.
enum DesktopBridgeRunner {
    static func makeProcess(nodePath: String, paths: (projectDir: String, runMjs: String)) -> Process {
        let process = Process()
        process.launchPath = nodePath
        process.currentDirectoryPath = paths.projectDir
        process.environment = AppState.bridgeEnvironment()
        return process
    }

    static func outputPipe() -> Pipe { Pipe() }
    static func start(_ process: Process) throws { try process.run() }
    static func read(_ pipe: Pipe) -> Data { pipe.fileHandleForReading.readDataToEndOfFile() }
    static func wait(_ process: Process) { process.waitUntilExit() }
    static func status(_ process: Process) -> Int32 { process.terminationStatus }
    static func isRunning(_ process: Process) -> Bool { process.isRunning }
    static func terminate(_ process: Process) { process.terminate() }
}

extension AppState {
    func handleLineSessionEnded(reason: String?) {
        // Only a server-confirmed revocation/expiry may erase persisted
        // credentials. A missing bridge response or transient startup failure
        // must lead to the login page without destroying a recoverable token.
        if reason == "revoked" || reason == "expired" {
            CredentialManager.clearCredentials()
        }
        chats = []
        currentChatMessages = []
        messageCache.removeAll()
        selectedChatId = nil
        hasLoadedChatsOnce = false
        isLoadingChats = false
        isLoadingMessages = false
        isConnected = false
        mid = ""
        displayName = ""
        pictureUrl = ""
        statusMessage = ""
        unreadCount = 0
        hasUnreadAttention = false
        chatLoadError = i18n.t(
            reason == "revoked" ? "line_session_revoked" : "line_session_expired")
        syncError = chatLoadError
        lastSyncTimeString = ""
        onUnreadStatusChanged?(false)
        onSessionEnded?()
    }

    func conversationDidBecomeVisible(chatId: String) {
        visibleConversationId = chatId
        guard selectedChatId == chatId else { return }
        if let messageID = VisibleReadCursorPolicy.latestPresentedMessageID(
            chatID: chatId,
            selectedChatID: selectedChatId,
            visibleChatID: visibleConversationId,
            presentedMessageIDs: currentChatMessages.map(\.id))
        {
            markChatRead(chatId: chatId, messageId: messageID)
        } else {
            loadChatMessages(chatId: chatId, markReadOnSuccess: true)
        }
    }

    func conversationDidStopBeingVisible(chatId: String) {
        if visibleConversationId == chatId { visibleConversationId = nil }
    }

    func setLineMuted(chatId: String, enabled: Bool) {
        guard chatId.hasPrefix("u"), let index = chats.firstIndex(where: { $0.id == chatId }) else {
            replyFeedbackIsError = true
            replyFeedback = i18n.t("line_mute_unsupported")
            return
        }
        let previous = chats[index].isMuted
        chats[index].isMuted = enabled
        DesktopChatSnapshotStore.save(chats)

        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else { return }
        DispatchQueue.global(qos: .utility).async {
            let process = DesktopBridgeRunner.makeProcess(nodePath: nodePath, paths: paths)
            process.arguments = [paths.runMjs, "set-chat-muted", chatId, enabled ? "true" : "false"]
            let output = DesktopBridgeRunner.outputPipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            do { try DesktopBridgeRunner.start(process) } catch {
                DispatchQueue.main.async { self.finishLineMute(chatId: chatId, value: previous, succeeded: false) }
                return
            }
            _ = DesktopBridgeRunner.read(output)
            DesktopBridgeRunner.wait(process)
            let succeeded = DesktopBridgeRunner.status(process) == 0
            DispatchQueue.main.async {
                self.finishLineMute(chatId: chatId, value: succeeded ? enabled : previous, succeeded: succeeded)
            }
        }
    }

    private func finishLineMute(chatId: String, value: Bool, succeeded: Bool) {
        if let index = chats.firstIndex(where: { $0.id == chatId }) { chats[index].isMuted = value }
        DesktopChatSnapshotStore.save(chats)
        replyFeedbackIsError = !succeeded
        replyFeedback =
            succeeded
            ? i18n.t(value ? "line_mute_success" : "line_unmute_success")
            : i18n.t("line_mute_failed")
    }

    func markChatRead(chatId: String, messageId: String? = nil) {
        guard !chatId.isEmpty else { return }

        // Use the exact newest message already presented to the user. Asking a
        // separate short-lived bridge to rediscover it can transiently return
        // an empty page, leaving LINE's server cursor unread while the local
        // badge has already been cleared.
        let displayedMessageId = messageId ?? currentChatMessages.last?.id
        let readThroughTimestamp =
            currentChatMessages.last?.timestamp
            ?? chats.first(where: { $0.id == chatId })?.timestampValue
            ?? 0
        pendingReadCursors[chatId] = PendingReadCursor(
            readThroughTimestamp: readThroughTimestamp,
            createdAt: Date())

        if let idx = chats.firstIndex(where: { $0.id == chatId }) {
            if chats[idx].unreadCount > 0, chats[idx].attentionEvaluation.tier == .know {
                YomiAttentionLearningStore.recordPassiveReview(chatId)
            }
            chats[idx].unreadCount = 0
            unreadCount = chats.reduce(0) { $0 + $1.unreadCount }
            hasUnreadAttention = chats.contains { $0.needsAttention }
            onUnreadStatusChanged?(hasUnreadAttention)
            DesktopChatSnapshotStore.save(chats)
        }

        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else { return }

        DispatchQueue.global(qos: .utility).async {
            let process = DesktopBridgeRunner.makeProcess(nodePath: nodePath, paths: paths)
            process.launchPath = nodePath
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "mark-read", chatId]
            if let displayedMessageId, !displayedMessageId.isEmpty {
                process.arguments?.append(displayedMessageId)
            }
            let output = DesktopBridgeRunner.outputPipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            do {
                try DesktopBridgeRunner.start(process)
            } catch {
                DispatchQueue.main.async { self.refreshInbox(.retry) }
                return
            }
            let data = DesktopBridgeRunner.read(output)
            DesktopBridgeRunner.wait(process)
            let marked =
                DesktopBridgeRunner.status(process) == 0
                && ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["marked"] as? Bool == true
            if !marked {
                // Reconcile the optimistic badge with LINE instead of leaving
                // a false local read state that reappears on the next launch.
                DispatchQueue.main.async {
                    self.pendingReadCursors.removeValue(forKey: chatId)
                    self.refreshInbox(.retry)
                }
            }
        }
    }
}

extension AppState {
    func hydrateStartupMessageCache(completion: @escaping () -> Void) {
        var targetIDs: [String] = []
        let unreadIDs = chats.filter { $0.unreadCount > 0 }.map(\.id)
        for id in unreadIDs + chats.map(\.id) where !targetIDs.contains(id) {
            targetIDs.append(id)
            // Sync the active desktop working set at launch. This is one
            // shared-session batch; opening a row never starts a new session.
            if targetIDs.count == 20 { break }
        }

        guard !targetIDs.isEmpty else {
            completion()
            return
        }

        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            completion()
            return
        }
        let accountId = mid
        let callback = DesktopRefreshCallback { _ in completion() }

        DispatchQueue.global(qos: .utility).async {
            let process = DesktopBridgeRunner.makeProcess(nodePath: nodePath, paths: paths)
            process.launchPath = nodePath
            process.environment = Self.bridgeEnvironment()
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "desktop-startup-messages"] + targetIDs
            let pipe = DesktopBridgeRunner.outputPipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice

            do {
                try DesktopBridgeRunner.start(process)
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 60) {
                    if DesktopBridgeRunner.isRunning(process) { DesktopBridgeRunner.terminate(process) }
                }
                let data = DesktopBridgeRunner.read(pipe)
                DesktopBridgeRunner.wait(process)
                if let jsonStr = String(data: data, encoding: .utf8),
                    let jsonStart = jsonStr.firstIndex(of: "{"),
                    let jsonData = String(jsonStr[jsonStart...]).data(using: .utf8),
                    let response = try? JSONDecoder().decode(DesktopStartupMessagesResponse.self, from: jsonData)
                {
                    guard response.session.connected else {
                        DispatchQueue.main.async {
                            self.handleLineSessionEnded(reason: response.session.reason)
                            callback.call(false)
                        }
                        return
                    }
                    var hydrated: [String: [LineChatMessage]] = [:]
                    for (chatId, rawMessages) in response.messages {
                        let existing = DesktopMessageSnapshotStore.load(accountId: accountId, chatId: chatId)
                        let messages = rawMessages.map { message in
                            var safe = message
                            safe.text = sanitizeDesktopMessagePreview(message.text)
                            return safe
                        }
                        let merged = DesktopMessageSnapshotStore.merge(existing: existing, incoming: messages)
                        DesktopMessageSnapshotStore.save(merged, accountId: accountId, chatId: chatId)
                        hydrated[chatId] = merged
                    }
                    DispatchQueue.main.async {
                        for (chatId, messages) in hydrated {
                            self.messageCache[chatId] = messages
                        }
                        if let selected = self.selectedChatId,
                            let messages = hydrated[selected], self.currentChatMessages.isEmpty
                        {
                            self.currentChatMessages = messages
                            self.isLoadingMessages = false
                            self.messageLoadError = nil
                        }
                        callback.call(true)
                    }
                    return
                }
            } catch {}

            DispatchQueue.main.async { callback.call(false) }
        }
    }
}
