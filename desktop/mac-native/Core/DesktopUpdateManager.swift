import Cocoa
import Foundation

/// Lightweight release updater for the standalone macOS build.
///
/// Checks GitHub Releases automatically, presents update state inside Yomi,
/// and opens the signed release artifact for installation. Release downloads
/// remain user-visible; Yomi never replaces an application bundle silently.
@MainActor
final class DesktopUpdateManager: ObservableObject {
    static let shared = DesktopUpdateManager()

    @Published private(set) var isChecking = false
    @Published private(set) var availableVersion: String?
    @Published private(set) var releaseURL: URL?
    @Published private(set) var lastError: String?

    @Published var automaticallyChecksForUpdates: Bool {
        didSet {
            UserDefaults.standard.set(automaticallyChecksForUpdates, forKey: Self.automaticCheckKey)
        }
    }

    private static let automaticCheckKey = "yomi_automatically_checks_for_updates"
    private static let lastCheckKey = "yomi_last_update_check"
    private static let checkInterval: TimeInterval = 6 * 60 * 60
    private let releasesEndpoint = URL(string: "https://api.github.com/repos/RikaiDev/yomi/releases?per_page=20")!

    private init() {
        if UserDefaults.standard.object(forKey: Self.automaticCheckKey) == nil {
            automaticallyChecksForUpdates = true
        } else {
            automaticallyChecksForUpdates = UserDefaults.standard.bool(forKey: Self.automaticCheckKey)
        }
    }

    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    var statusText: String {
        if isChecking { return I18n.shared.t("updates_checking") }
        if let availableVersion { return I18n.shared.t("updates_available").replacingOccurrences(of: "%@", with: availableVersion) }
        if lastError != nil { return I18n.shared.t("updates_check_failed") }
        return I18n.shared.t("updates_up_to_date")
    }

    func checkOnLaunchIfNeeded() {
        guard automaticallyChecksForUpdates else { return }
        let lastCheck = UserDefaults.standard.object(forKey: Self.lastCheckKey) as? Date ?? .distantPast
        guard Date().timeIntervalSince(lastCheck) >= Self.checkInterval else { return }
        checkForUpdates(userInitiated: false)
    }

    func checkForUpdates(userInitiated: Bool = true) {
        guard !isChecking else { return }
        isChecking = true
        lastError = nil

        var request = URLRequest(url: releasesEndpoint)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Yomi/(currentVersion)", forHTTPHeaderField: "User-Agent")

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.isChecking = false
                UserDefaults.standard.set(Date(), forKey: Self.lastCheckKey)
                guard error == nil,
                    let http = response as? HTTPURLResponse,
                    (200..<300).contains(http.statusCode),
                    let data,
                    let releases = try? JSONDecoder().decode([GitHubRelease].self, from: data),
                    let release = releases.first(where: { !$0.draft && ($0.tagName.hasPrefix("desktop-v") || $0.tagName.hasPrefix("v")) })
                else {
                    self.lastError = error?.localizedDescription ?? "GitHub release check failed"
                    if userInitiated { self.presentCheckResult() }
                    return
                }

                let candidate = release.tagName.replacingOccurrences(of: "desktop-v", with: "")
                    .replacingOccurrences(of: "v", with: "")
                if Self.isNewer(candidate, than: self.currentVersion) {
                    self.availableVersion = candidate
                    self.releaseURL = URL(string: release.htmlURL)
                } else {
                    self.availableVersion = nil
                    self.releaseURL = nil
                }

                if userInitiated, self.availableVersion == nil {
                    self.lastError = nil
                }
                if userInitiated { self.presentCheckResult() }
            }
        }.resume()
    }

    func openAvailableUpdate() {
        guard let releaseURL else {
            checkForUpdates()
            return
        }
        NSWorkspace.shared.open(releaseURL)
    }

    private func presentCheckResult() {
        let alert = NSAlert()
        alert.messageText = statusText
        if availableVersion != nil {
            alert.informativeText = I18n.shared.t("updates_install_note")
            alert.addButton(withTitle: I18n.shared.t("updates_download"))
            alert.addButton(withTitle: I18n.shared.t("popover_dismiss"))
            if alert.runModal() == .alertFirstButtonReturn, let releaseURL {
                NSWorkspace.shared.open(releaseURL)
            }
        } else {
            alert.addButton(withTitle: I18n.shared.t("popover_dismiss"))
            alert.runModal()
        }
    }

    private static func isNewer(_ candidate: String, than current: String) -> Bool {
        let candidateParts = candidate.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
        let currentParts = current.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
        for index in 0..<max(candidateParts.count, currentParts.count) {
            let lhs = index < candidateParts.count ? candidateParts[index] : 0
            let rhs = index < currentParts.count ? currentParts[index] : 0
            if lhs != rhs { return lhs > rhs }
        }
        return false
    }
}

private struct GitHubRelease: Decodable {
    let tagName: String
    let htmlURL: String
    let draft: Bool

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case htmlURL = "html_url"
        case draft
    }
}
