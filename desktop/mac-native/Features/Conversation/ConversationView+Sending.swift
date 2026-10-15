import Cocoa
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

extension ConversationDetailView {
    func chooseFile() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowedContentTypes = [.item]
        panel.prompt = "選擇"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            stage(url: url)
        }
    }

    func handlePhotoSelection(_ item: PhotosPickerItem?) {
        guard let item else { return }
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self) else { return }
            await MainActor.run { stageImageData(data) }
        }
        selectedPhotoItem = nil
    }

    func stageImageData(_ data: Data) {
        do {
            let url = try ComposerAttachmentStore.stageJPEG(data)
            stage(url: url)
            showCameraPopover = false
            camera.stop()
            camera.capturedData = nil
        } catch {
            state.replyFeedbackIsError = true
            state.replyFeedback = state.i18n.t("composer_image_stage_failed")
        }
    }

    func stage(url: URL) {
        let isImage = (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType?.conforms(to: .image)) ?? false
        let count = isYomiMode ? yomiStagedAttachments.count : stagedAttachments.count
        guard count < 8 else {
            state.replyFeedbackIsError = true
            state.replyFeedback = state.i18n.t("composer_attachment_limit")
            return
        }
        let attachment = ComposerAttachment(url: url, isImage: isImage)
        if isYomiMode { yomiStagedAttachments.append(attachment) } else { stagedAttachments.append(attachment) }
        // A file picker or drag is an attachment action, never a request to
        // paste its local path into the message. Keep typed prose intact while
        // removing the path-only draft AppKit may have inserted.
        let pathValues = Set([url.path, url.absoluteString])
        if isYomiMode, pathValues.contains(yomiPromptDraft) {
            yomiPromptDraft = ""
        } else if !isYomiMode, pathValues.contains(composerInput) {
            composerInput = ""
        }
    }

    func stagePastedFileReference(_ value: String) {
        let candidate = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty else { return }
        let url: URL
        if candidate.hasPrefix("file://"), let parsed = URL(string: candidate) {
            url = parsed
        } else if candidate.hasPrefix("/") {
            url = URL(fileURLWithPath: candidate)
        } else {
            return
        }
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let attachments = isYomiMode ? yomiStagedAttachments : stagedAttachments
        guard !attachments.contains(where: { $0.url.standardizedFileURL == url.standardizedFileURL }) else {
            return
        }
        stage(url: url)
    }

    func removeAttachment(_ id: UUID) {
        let url: URL?
        if isYomiMode, let index = yomiStagedAttachments.firstIndex(where: { $0.id == id }) {
            url = yomiStagedAttachments.remove(at: index).url
        } else if let index = stagedAttachments.firstIndex(where: { $0.id == id }) {
            url = stagedAttachments.remove(at: index).url
        } else {
            url = nil
        }
        guard let url else { return }
        ComposerAttachmentStore.removeIfTemporary(url)
    }

    func stageDroppedProviders(_ providers: [NSItemProvider]) -> Bool {
        let count = isYomiMode ? yomiStagedAttachments.count : stagedAttachments.count
        for provider in providers.prefix(max(0, 8 - count)) {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil as [AnyHashable: Any]?) { item, _ in
                    let url: URL?
                    if let value = item as? URL {
                        url = value
                    } else if let data = item as? Data {
                        url = URL(dataRepresentation: data, relativeTo: nil)
                    } else {
                        url = nil
                    }
                    guard let url else { return }
                    DispatchQueue.main.async { stage(url: url) }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                    guard let data else { return }
                    DispatchQueue.main.async { stageImageData(data) }
                }
            }
        }
        return true
    }

    func submitComposer() {
        let trimmed = composerInput.trimmingCharacters(in: .whitespacesAndNewlines)
        voiceInput.stop()
        var sendAttachments: (() -> Void)!
        sendAttachments = {
            guard !stagedAttachments.isEmpty else {
                composerInput = ""
                composerFocused = false
                state.loadChatMessages(chatId: chat.id)
                return
            }
            // Transfer ownership from the composer to the optimistic outgoing
            // message immediately. LINE-style composers clear the draft as
            // soon as upload begins; only a failed upload restores it.
            let attachment = stagedAttachments.removeFirst()
            let localID = "local-attachment-\(UUID().uuidString)"
            let mediaType = attachment.isImage ? "image" : "file"
            let contentType = attachment.isImage ? 1 : 14
            let text =
                attachment.isImage
                ? state.i18n.t("message_image")
                : state.i18n.t("message_file")
            let previewURL = attachment.isImage ? attachment.url.absoluteString : nil
            outgoingMessages.append(
                optimisticOutgoingMessage(
                    localID: localID,
                    text: text,
                    contentType: contentType,
                    mediaType: mediaType,
                    mediaUrl: previewURL,
                    fileName: attachment.url.lastPathComponent))
            let finish: (Bool, String?) -> Void = { success, messageID in
                if let index = outgoingMessages.firstIndex(where: { $0.id == localID }) {
                    outgoingMessages[index] = settledOutgoingMessage(
                        localID: localID,
                        serverMessageID: messageID,
                        succeeded: success,
                        text: text,
                        contentType: contentType,
                        mediaType: mediaType,
                        mediaUrl: previewURL,
                        fileName: attachment.url.lastPathComponent)
                }
                if success {
                    ComposerAttachmentStore.removeIfTemporary(attachment.url)
                    state.loadChatMessages(chatId: chat.id, showLoading: false)
                    sendAttachments()
                } else {
                    stagedAttachments.insert(attachment, at: 0)
                }
            }
            if attachment.isImage {
                state.sendLineImage(chatId: chat.id, fileURL: attachment.url, completion: finish)
            } else {
                state.sendLineFile(chatId: chat.id, fileURL: attachment.url, completion: finish)
            }
        }
        if !trimmed.isEmpty {
            let outgoingMentions = mentionTargets
            let localID = "local-pending-\(UUID().uuidString)"
            outgoingMessages.append(
                optimisticOutgoingMessage(localID: localID, text: trimmed))
            composerInput = ""
            mentionTargets = []
            composerFocused = false
            state.sendLineReply(chatId: chat.id, text: trimmed, mentions: outgoingMentions) { success, messageID in
                if success {
                    if let index = outgoingMessages.firstIndex(where: { $0.id == localID }) {
                        outgoingMessages[index] = settledOutgoingMessage(
                            localID: localID, serverMessageID: messageID, succeeded: true, text: trimmed)
                    }
                    ComposerHistoryStore.append(trimmed, chatId: chat.id, yomi: false)
                    lineHistoryIndex = nil
                    sendAttachments()
                    state.loadChatMessages(chatId: chat.id, showLoading: false)
                } else {
                    if let index = outgoingMessages.firstIndex(where: { $0.id == localID }) {
                        outgoingMessages[index] = settledOutgoingMessage(
                            localID: localID, serverMessageID: messageID, succeeded: false, text: trimmed)
                    }
                }
            }
        } else {
            sendAttachments()
        }
    }

    func sendSticker(_ sticker: StickerPreviewItem) {
        guard !state.isSendingReply else { return }
        let localID = "local-sticker-\(UUID().uuidString)"
        let previewURL = "data:image/png;base64,\(sticker.data)"
        outgoingMessages.append(
            optimisticOutgoingMessage(
                localID: localID,
                text: state.i18n.t("message_sticker"),
                contentType: 7,
                mediaType: "sticker",
                mediaUrl: previewURL))
        showStickerPicker = false
        state.sendLineSticker(chatId: chat.id, sticker: sticker) { success, messageID in
            guard let index = outgoingMessages.firstIndex(where: { $0.id == localID }) else { return }
            outgoingMessages[index] = settledOutgoingMessage(
                localID: localID,
                serverMessageID: messageID,
                succeeded: success,
                text: state.i18n.t("message_sticker"),
                contentType: 7,
                mediaType: "sticker",
                mediaUrl: previewURL)
            if success {
                state.loadChatMessages(chatId: chat.id, showLoading: false)
            }
        }
    }
}
