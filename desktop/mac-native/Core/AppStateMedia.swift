import Cocoa
import Foundation

private enum MediaFileCache {
    private static let maximumBytes = 256 * 1024 * 1024
    private static let maximumAge: TimeInterval = 14 * 24 * 60 * 60

    private static var directory: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Yomi/media", isDirectory: true)
    }

    static func existingVideo(messageId: String) -> URL? {
        guard let directory else { return nil }
        let url = directory.appendingPathComponent("\(messageId).mp4")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    static func saveVideo(_ data: Data, messageId: String) -> URL? {
        guard messageId.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }),
            let directory
        else { return nil }
        let url = directory.appendingPathComponent("\(messageId).mp4")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            prune(directory)
            return url
        } catch { return nil }
    }

    private static func prune(_ directory: URL) {
        guard
            let entries = try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
                options: [.skipsHiddenFiles])
        else { return }
        let now = Date()
        var files: [(URL, Int, Date)] = []
        for url in entries {
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]),
                let size = values.fileSize, let modified = values.contentModificationDate
            else { continue }
            if now.timeIntervalSince(modified) > maximumAge {
                try? FileManager.default.removeItem(at: url)
            } else {
                files.append((url, size, modified))
            }
        }
        var total = files.reduce(0) { $0 + $1.1 }
        for file in files.sorted(by: { $0.2 < $1.2 }) where total > maximumBytes {
            try? FileManager.default.removeItem(at: file.0)
            total -= file.1
        }
    }
}

extension AppState {
    func loadMediaPreview(chatId: String, messageId: String, original: Bool = false) {
        let loadingKey = original ? "\(messageId):original" : messageId
        let cacheKey = URL(string: "yomi-media://cache/\(chatId)/\(messageId)?original=\(original ? 1 : 0)")!
        guard !chatId.isEmpty, !messageId.isEmpty,
            original ? !mediaOriginalLoaded.contains(messageId) : mediaPreviewImages[messageId] == nil,
            mediaPreviewAudioData[messageId] == nil
        else { return }
        guard !mediaPreviewLoading.contains(loadingKey) else { return }
        guard let nodePath = YomiPathResolver.findNodePath(), let paths = YomiPathResolver.findRunMjs() else {
            return
        }
        mediaPreviewLoading.insert(loadingKey)
        mediaPreviewFailures.remove(messageId)

        DispatchQueue.global(qos: .userInitiated).async {
            // `Set` is not thread-safe. Multiple media previews complete in
            // parallel when a newly opened conversation contains images; all
            // access to this UI-owned set must stay on the main queue.
            defer {
                DispatchQueue.main.async {
                    self.mediaPreviewLoading.remove(loadingKey)
                }
            }
            if let videoURL = MediaFileCache.existingVideo(messageId: messageId) {
                DispatchQueue.main.async { self.mediaPreviewVideoURLs[messageId] = videoURL }
                return
            }
            if let cachedImage = ImageCache.shared.image(for: cacheKey) {
                DispatchQueue.main.async {
                    self.mediaPreviewImages[messageId] = cachedImage
                    self.touchMediaPreviewImage(cachedImage, messageId: messageId)
                    if original { self.mediaOriginalLoaded.insert(messageId) }
                }
                return
            }
            let process = Process()
            process.launchPath = nodePath
            process.environment = Self.bridgeEnvironment()
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "media-preview", chatId, messageId]
            if original { process.arguments?.append("original") }
            process.arguments?.append("--file-output")
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice

            do {
                try process.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                guard process.terminationStatus == 0,
                    let jsonString = String(data: data, encoding: .utf8),
                    let jsonStart = jsonString.firstIndex(of: "{"),
                    let jsonData = String(jsonString[jsonStart...]).data(using: .utf8),
                    let payload = try? JSONDecoder().decode(MediaPreviewPayload.self, from: jsonData)
                else {
                    DispatchQueue.main.async { self.mediaPreviewFailures.insert(messageId) }
                    return
                }
                let decoded: Data?
                if let filePath = payload.filePath {
                    let fileURL = URL(fileURLWithPath: filePath)
                    decoded = try? Data(contentsOf: fileURL)
                    try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
                } else if let base64 = payload.data {
                    decoded = Data(base64Encoded: base64)
                } else {
                    decoded = nil
                }
                guard let decoded else {
                    DispatchQueue.main.async { self.mediaPreviewFailures.insert(messageId) }
                    return
                }
                let mimeType = payload.mimeType?.lowercased() ?? ""
                if mimeType.hasPrefix("video/"),
                    let videoURL = MediaFileCache.saveVideo(decoded, messageId: messageId)
                {
                    DispatchQueue.main.async { self.mediaPreviewVideoURLs[messageId] = videoURL }
                    return
                }
                DispatchQueue.main.async {
                    if mimeType.hasPrefix("audio/") {
                        self.mediaPreviewAudioData[messageId] = decoded
                        self.mediaPreviewAudioMIMEs[messageId] = mimeType
                        self.mediaPreviewAudioAccess[messageId] = Date()
                        self.trimMediaPreviewAudio()
                    } else if let image = NSImage(data: decoded) {
                        ImageCache.shared.save(image: image, data: decoded, for: cacheKey)
                        self.mediaPreviewImages[messageId] = image
                        self.touchMediaPreviewImage(image, messageId: messageId)
                        if original { self.mediaOriginalLoaded.insert(messageId) }
                    } else {
                        self.mediaPreviewFailures.insert(messageId)
                    }
                }
            } catch {
                DispatchQueue.main.async { self.mediaPreviewFailures.insert(messageId) }
            }
        }
    }

    private func touchMediaPreviewImage(_ image: NSImage, messageId: String) {
        mediaPreviewImageCosts[messageId] = max(
            1, image.representations.first.map { $0.pixelsWide * $0.pixelsHigh * 4 } ?? 1)
        mediaPreviewImageAccess[messageId] = Date()
        while mediaPreviewImageCosts.values.reduce(0, +) > 128 * 1024 * 1024,
            let oldest = mediaPreviewImageAccess.min(by: { $0.value < $1.value })?.key
        {
            mediaPreviewImages.removeValue(forKey: oldest)
            mediaPreviewImageCosts.removeValue(forKey: oldest)
            mediaPreviewImageAccess.removeValue(forKey: oldest)
        }
    }

    private func trimMediaPreviewAudio() {
        while mediaPreviewAudioData.values.reduce(0, { $0 + $1.count }) > 32 * 1024 * 1024,
            let oldest = mediaPreviewAudioAccess.min(by: { $0.value < $1.value })?.key
        {
            mediaPreviewAudioData.removeValue(forKey: oldest)
            mediaPreviewAudioMIMEs.removeValue(forKey: oldest)
            mediaPreviewAudioAccess.removeValue(forKey: oldest)
        }
    }

    func downloadAndSaveMediaFile(
        chatId: String,
        messageId: String,
        suggestedFileName: String?,
        promptSavePanel: Bool = false
    ) {
        guard !chatId.isEmpty, !messageId.isEmpty else { return }
        guard !mediaDownloadingMessageIds.contains(messageId) else { return }

        if let existingURL = mediaDownloadedFileURLs[messageId],
            FileManager.default.fileExists(atPath: existingURL.path)
        {
            if promptSavePanel {
                // User explicitly clicked Save As, continue to save dialog
            } else {
                NSWorkspace.shared.activateFileViewerSelecting([existingURL])
                return
            }
        }

        guard let nodePath = YomiPathResolver.findNodePath(), let paths = YomiPathResolver.findRunMjs() else {
            return
        }

        mediaDownloadingMessageIds.insert(messageId)

        DispatchQueue.global(qos: .userInitiated).async {
            defer {
                DispatchQueue.main.async {
                    self.mediaDownloadingMessageIds.remove(messageId)
                }
            }

            let process = Process()
            process.launchPath = nodePath
            process.environment = Self.bridgeEnvironment()
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "media-preview", chatId, messageId, "original", "--file-output"]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice

            do {
                try process.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                guard process.terminationStatus == 0,
                    let jsonString = String(data: data, encoding: .utf8),
                    let jsonStart = jsonString.firstIndex(of: "{"),
                    let jsonData = String(jsonString[jsonStart...]).data(using: .utf8),
                    let payload = try? JSONDecoder().decode(MediaPreviewPayload.self, from: jsonData)
                else {
                    return
                }

                let decoded: Data?
                if let filePath = payload.filePath {
                    let fileURL = URL(fileURLWithPath: filePath)
                    decoded = try? Data(contentsOf: fileURL)
                    try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
                } else if let base64 = payload.data {
                    decoded = Data(base64Encoded: base64)
                } else {
                    decoded = nil
                }

                guard let fileData = decoded, !fileData.isEmpty else { return }

                let effectiveFileName =
                    (suggestedFileName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                        ? suggestedFileName : nil)
                    ?? (payload.fileName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                        ? payload.fileName : nil)
                    ?? "attachment"

                DispatchQueue.main.async {
                    if promptSavePanel {
                        let savePanel = NSSavePanel()
                        savePanel.nameFieldStringValue = effectiveFileName
                        savePanel.canCreateDirectories = true
                        savePanel.prompt = self.i18n.t("save_as")
                        savePanel.begin { response in
                            guard response == .OK, let targetURL = savePanel.url else { return }
                            do {
                                try fileData.write(to: targetURL, options: .atomic)
                                self.mediaDownloadedFileURLs[messageId] = targetURL
                                NSWorkspace.shared.activateFileViewerSelecting([targetURL])
                            } catch {}
                        }
                    } else {
                        let downloads =
                            FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
                            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads")

                        var targetURL = downloads.appendingPathComponent(effectiveFileName)
                        var counter = 1
                        let ext = targetURL.pathExtension
                        let nameWithoutExt = targetURL.deletingPathExtension().lastPathComponent

                        while FileManager.default.fileExists(atPath: targetURL.path) {
                            let newName =
                                ext.isEmpty
                                ? "\(nameWithoutExt) (\(counter))"
                                : "\(nameWithoutExt) (\(counter)).\(ext)"
                            targetURL = downloads.appendingPathComponent(newName)
                            counter += 1
                        }

                        do {
                            try FileManager.default.createDirectory(
                                at: downloads, withIntermediateDirectories: true)
                            try fileData.write(to: targetURL, options: .atomic)
                            self.mediaDownloadedFileURLs[messageId] = targetURL
                            NSWorkspace.shared.activateFileViewerSelecting([targetURL])
                        } catch {}
                    }
                }
            } catch {}
        }
    }

    /// Resolves LINE media into an ephemeral share directory. This is an app
    /// hand-off, not a user download: no save panel, Downloads folder, or
    /// Finder hop is involved.
    func materializeWorkMaterials(
        _ work: YomiWorkContext,
        completion: @escaping ([URL]) -> Void
    ) {
        let materials = work.materials.filter(\.isAttachment)
        guard !materials.isEmpty,
            let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            completion([])
            return
        }
        let callback = DesktopMediaShareCallback(completion)
        DispatchQueue.global(qos: .userInitiated).async {
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent("YomiWorkShares/\(work.id)", isDirectory: true)
            try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            var urls: [URL] = []
            for (index, material) in materials.enumerated() {
                if let existing = self.mediaDownloadedFileURLs[material.messageId],
                    FileManager.default.fileExists(atPath: existing.path)
                {
                    urls.append(existing)
                    continue
                }
                let process = Process()
                process.launchPath = nodePath
                process.environment = Self.bridgeEnvironment()
                process.currentDirectoryPath = paths.projectDir
                process.arguments = [paths.runMjs, "media-preview", material.chatId, material.messageId, "original", "--file-output"]
                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = FileHandle.nullDevice
                do {
                    try process.run()
                    let output = pipe.fileHandleForReading.readDataToEndOfFile()
                    process.waitUntilExit()
                    guard process.terminationStatus == 0,
                        let raw = String(data: output, encoding: .utf8),
                        let start = raw.firstIndex(of: "{"),
                        let json = String(raw[start...]).data(using: .utf8),
                        let payload = try? JSONDecoder().decode(MediaPreviewPayload.self, from: json)
                    else { continue }
                    let data: Data?
                    if let filePath = payload.filePath {
                        let source = URL(fileURLWithPath: filePath)
                        data = try? Data(contentsOf: source)
                        try? FileManager.default.removeItem(at: source.deletingLastPathComponent())
                    } else if let base64 = payload.data {
                        data = Data(base64Encoded: base64)
                    } else {
                        data = nil
                    }
                    guard let data, !data.isEmpty else { continue }
                    let fallback = "line-\(index + 1)-\(material.messageId).\(self.shareExtension(material.mediaType))"
                    let name = payload.fileName?.trimmingCharacters(in: .whitespacesAndNewlines)
                    let target = root.appendingPathComponent(name?.isEmpty == false ? name! : fallback)
                    try data.write(to: target, options: .atomic)
                    urls.append(target)
                } catch { continue }
            }
            DispatchQueue.main.async { callback.call(urls) }
        }
    }

    private func shareExtension(_ mediaType: String?) -> String {
        switch mediaType {
        case "image": return "jpg"
        case "video": return "mp4"
        case "audio": return "m4a"
        default: return "bin"
        }
    }
}

private final class DesktopMediaShareCallback: @unchecked Sendable {
    let call: ([URL]) -> Void
    init(_ call: @escaping ([URL]) -> Void) { self.call = call }
}
