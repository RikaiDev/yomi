import Foundation

private final class BuddyRichMenuCache: @unchecked Sendable {
    static let shared = BuddyRichMenuCache()
    private let lock = NSLock()
    private var values: [String: BuddyRichMenu] = [:]

    func value(for id: String) -> BuddyRichMenu? {
        lock.lock()
        defer { lock.unlock() }
        return values[id]
    }

    func set(_ value: BuddyRichMenu, for id: String) {
        lock.lock()
        values[id] = value
        lock.unlock()
    }
}

extension AppState {
    func loadBuddyRichMenu(chatId: String) {
        if let cached = BuddyRichMenuCache.shared.value(for: chatId) {
            currentBuddyRichMenu = cached
            return
        }
        currentBuddyRichMenu = nil
        guard chatId.starts(with: "u"),
            chats.first(where: { $0.id == chatId })?.isOfficial == true,
            let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else { return }

        DispatchQueue.global(qos: .utility).async {
            let process = Process()
            process.launchPath = nodePath
            process.currentDirectoryPath = paths.projectDir
            process.environment = Self.bridgeEnvironment()
            process.arguments = [paths.runMjs, "rich-menu", chatId]
            let output = Pipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                guard process.terminationStatus == 0,
                    let raw = String(data: data, encoding: .utf8),
                    let start = raw.firstIndex(of: "{"),
                    let json = String(raw[start...]).data(using: .utf8),
                    let menu = try? JSONDecoder().decode(BuddyRichMenu.self, from: json)
                else { return }
                DispatchQueue.main.async {
                    guard self.selectedChatId == chatId else { return }
                    BuddyRichMenuCache.shared.set(menu, for: chatId)
                    self.currentBuddyRichMenu = menu
                }
            } catch {}
        }
    }
}
