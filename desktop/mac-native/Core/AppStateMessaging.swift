import Foundation

private final class SendMessageCallbackBox: @unchecked Sendable {
    let call: (Bool, String?) -> Void
    init(_ call: @escaping (Bool, String?) -> Void) { self.call = call }
}

extension AppState {
    func loadOwnedStickers() {
        guard !isLoadingStickers,
            let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            if YomiPathResolver.findNodePath() == nil { stickerLoadError = i18n.t("runtime_missing") }
            return
        }
        isLoadingStickers = true
        stickerLoadError = nil
        let language = i18n.currentLanguage.rawValue
        DispatchQueue.global(qos: .userInitiated).async {
            let process = DesktopBridgeRunner.makeProcess(nodePath: nodePath, paths: paths)
            process.arguments = [paths.runMjs, "list-stickers", language]
            let output = DesktopBridgeRunner.outputPipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            do {
                try DesktopBridgeRunner.start(process)
                let data = DesktopBridgeRunner.read(output)
                DesktopBridgeRunner.wait(process)
                guard DesktopBridgeRunner.status(process) == 0,
                    let text = String(data: data, encoding: .utf8),
                    let start = text.firstIndex(of: "["),
                    let json = String(text[start...]).data(using: .utf8),
                    let packages = try? JSONDecoder().decode([StickerPackageItem].self, from: json)
                else { throw NSError(domain: "Yomi", code: 1) }
                DispatchQueue.main.async {
                    self.stickerPackages = packages
                    self.isLoadingStickers = false
                    if let first = packages.first { self.loadStickerPreviews(packageId: first.packageId) }
                }
            } catch {
                DispatchQueue.main.async {
                    self.isLoadingStickers = false
                    self.stickerLoadError = self.i18n.t("sticker_load_failed")
                }
            }
        }
    }

    func loadStickerPreviews(packageId: String) {
        guard !packageId.isEmpty,
            let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else { return }
        isLoadingStickers = true
        stickerLoadError = nil
        let language = i18n.currentLanguage.rawValue
        DispatchQueue.global(qos: .userInitiated).async {
            let process = DesktopBridgeRunner.makeProcess(nodePath: nodePath, paths: paths)
            process.arguments = [paths.runMjs, "sticker-previews", packageId, "12", language]
            let output = DesktopBridgeRunner.outputPipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            do {
                try DesktopBridgeRunner.start(process)
                let data = DesktopBridgeRunner.read(output)
                DesktopBridgeRunner.wait(process)
                guard DesktopBridgeRunner.status(process) == 0,
                    let text = String(data: data, encoding: .utf8),
                    let start = text.firstIndex(of: "["),
                    let json = String(text[start...]).data(using: .utf8),
                    let previews = try? JSONDecoder().decode([StickerPreviewItem].self, from: json)
                else { throw NSError(domain: "Yomi", code: 2) }
                DispatchQueue.main.async {
                    self.stickerPreviews = previews
                    self.isLoadingStickers = false
                }
            } catch {
                DispatchQueue.main.async {
                    self.isLoadingStickers = false
                    self.stickerLoadError = self.i18n.t("sticker_preview_load_failed")
                }
            }
        }
    }

    private func sendLineCommand(
        chatId: String,
        arguments: [String],
        environment: [String: String]? = nil,
        securityScopedURL: URL? = nil,
        failureMessage: String,
        recordReply: Bool = false,
        completion: @escaping (Bool, String?) -> Void
    ) {
        guard !chatId.isEmpty, !isSendingReply,
            let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            completion(false, nil)
            return
        }
        isSendingReply = true
        replyFeedback = nil
        replyFeedbackIsError = false
        let callback = SendMessageCallbackBox(completion)
        let scoped = securityScopedURL?.startAccessingSecurityScopedResource() ?? false
        DispatchQueue.global(qos: .userInitiated).async {
            defer { if scoped { securityScopedURL?.stopAccessingSecurityScopedResource() } }
            let process = DesktopBridgeRunner.makeProcess(nodePath: nodePath, paths: paths)
            process.environment = environment ?? Self.bridgeEnvironment()
            process.arguments = [paths.runMjs] + arguments
            let output = DesktopBridgeRunner.outputPipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            var succeeded = false
            var messageID: String?
            do {
                try DesktopBridgeRunner.start(process)
                let data = DesktopBridgeRunner.read(output)
                DesktopBridgeRunner.wait(process)
                if DesktopBridgeRunner.status(process) == 0,
                    let response = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    response["sent"] as? Bool == true
                {
                    succeeded = true
                    messageID = response["messageId"] as? String
                }
            } catch {}
            let result = succeeded
            let deliveredMessageID = messageID
            DispatchQueue.main.async {
                self.isSendingReply = false
                self.replyFeedbackIsError = !result
                self.replyFeedback = result ? nil : failureMessage
                if result, recordReply { YomiAttentionLearningStore.recordReply(chatId) }
                callback.call(result, deliveredMessageID)
            }
        }
    }

    func sendLineSticker(
        chatId: String,
        sticker: StickerPreviewItem,
        completion: @escaping (Bool, String?) -> Void = { _, _ in }
    ) {
        guard let package = stickerPackages.first(where: { $0.packageId == sticker.packageId }) else {
            completion(false, nil)
            return
        }
        sendLineCommand(
            chatId: chatId,
            arguments: ["send-sticker", chatId, sticker.stickerId, sticker.packageId, package.version],
            failureMessage: i18n.t("sticker_send_failed"),
            completion: completion)
    }

    func sendLineReply(
        chatId: String,
        text: String,
        mentions: [LineMentionTarget] = [],
        completion: @escaping (Bool, String?) -> Void = { _, _ in }
    ) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            completion(false, nil)
            return
        }
        var environment = Self.bridgeEnvironment()
        if let data = try? JSONEncoder().encode(mentions) {
            environment["YOMI_MENTIONS_JSON"] = String(decoding: data, as: UTF8.self)
        }
        sendLineCommand(
            chatId: chatId,
            arguments: ["send-message", chatId, trimmed],
            environment: environment,
            failureMessage: i18n.t("message_send_failed_retry"),
            recordReply: true,
            completion: completion)
    }

    func sendLineImage(
        chatId: String,
        fileURL: URL,
        completion: @escaping (Bool, String?) -> Void = { _, _ in }
    ) {
        sendLineCommand(
            chatId: chatId,
            arguments: ["send-image", chatId, fileURL.path],
            failureMessage: i18n.t("image_send_failed"),
            completion: completion)
    }

    func sendLineFile(
        chatId: String,
        fileURL: URL,
        completion: @escaping (Bool, String?) -> Void = { _, _ in }
    ) {
        sendLineCommand(
            chatId: chatId,
            arguments: ["send-file", chatId, fileURL.path],
            securityScopedURL: fileURL,
            failureMessage: i18n.t("file_send_failed"),
            completion: completion)
    }
}
