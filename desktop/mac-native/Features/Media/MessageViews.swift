import AVFoundation
import Cocoa
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Image Caching & Remote Avatar Loader

final class ImageCache: @unchecked Sendable {
    static let shared = ImageCache()
    private let memoryCache = NSCache<NSURL, NSImage>()
    private let cacheDir: URL
    private let diskLimitBytes = 64 * 1024 * 1024
    private let maximumAge: TimeInterval = 30 * 24 * 60 * 60

    init() {
        memoryCache.countLimit = 300
        memoryCache.totalCostLimit = 48 * 1024 * 1024
        let paths = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
        cacheDir = paths[0].appendingPathComponent("yomi/avatars", isDirectory: true)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        pruneDiskCache()
    }

    func image(for url: URL) -> NSImage? {
        if let mem = memoryCache.object(forKey: url as NSURL) {
            return mem
        }
        let safeKey = yomiStableCacheKey(url.absoluteString)
        let fileUrl = cacheDir.appendingPathComponent(safeKey)
        if let data = try? Data(contentsOf: fileUrl), let img = NSImage(data: data) {
            memoryCache.setObject(img, forKey: url as NSURL, cost: imageCost(img))
            return img
        }
        return nil
    }

    func memoryImage(for url: URL) -> NSImage? {
        memoryCache.object(forKey: url as NSURL)
    }

    func save(image: NSImage, data: Data, for url: URL) {
        memoryCache.setObject(image, forKey: url as NSURL, cost: imageCost(image))
        let safeKey = yomiStableCacheKey(url.absoluteString)
        let fileUrl = cacheDir.appendingPathComponent(safeKey)
        try? data.write(to: fileUrl, options: .atomic)
        pruneDiskCache()
    }

    private func pruneDiskCache() {
        DispatchQueue.global(qos: .utility).async { [cacheDir, diskLimitBytes, maximumAge] in
            guard
                let entries = try? FileManager.default.contentsOfDirectory(
                    at: cacheDir,
                    includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
                    options: [.skipsHiddenFiles])
            else { return }
            let now = Date()
            var files: [(url: URL, size: Int, modified: Date)] = []
            for url in entries {
                guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]),
                    let size = values.fileSize,
                    let modified = values.contentModificationDate
                else { continue }
                if now.timeIntervalSince(modified) > maximumAge {
                    try? FileManager.default.removeItem(at: url)
                } else {
                    files.append((url, size, modified))
                }
            }
            var total = files.reduce(0) { $0 + $1.size }
            for file in files.sorted(by: { $0.modified < $1.modified }) where total > diskLimitBytes {
                try? FileManager.default.removeItem(at: file.url)
                total -= file.size
            }
        }
    }

    private func imageCost(_ image: NSImage) -> Int {
        guard let representation = image.representations.first else { return 1 }
        return max(1, representation.pixelsWide * representation.pixelsHigh * 4)
    }
}

final class ImageLoader: ObservableObject, @unchecked Sendable {
    @Published var image: NSImage?
    @Published private(set) var failed = false
    private var currentUrl: URL?

    func load(urlStr: String) {
        guard !urlStr.isEmpty else {
            self.image = nil
            self.failed = true
            return
        }
        let normalized = urlStr.replacingOccurrences(of: "line-scdn.net//", with: "line-scdn.net/")
        guard let url = URL(string: normalized) else {
            self.image = nil
            self.failed = true
            return
        }
        if currentUrl == url && self.image != nil {
            return
        }
        self.currentUrl = url
        self.failed = false
        if let cached = ImageCache.shared.memoryImage(for: url) {
            self.image = cached
            return
        }
        DispatchQueue.global(qos: .utility).async {
            if let cached = ImageCache.shared.image(for: url) {
                DispatchQueue.main.async {
                    if self.currentUrl == url { self.image = cached }
                }
                return
            }
            var request = URLRequest(url: url)
            request.timeoutInterval = 12
            URLSession.shared.dataTask(with: request) { data, response, _ in
                guard let data, let response = response as? HTTPURLResponse,
                    (200..<300).contains(response.statusCode), let img = NSImage(data: data)
                else {
                    DispatchQueue.main.async {
                        if self.currentUrl == url { self.failed = true }
                    }
                    return
                }
                ImageCache.shared.save(image: img, data: data, for: url)
                DispatchQueue.main.async {
                    if self.currentUrl == url { self.image = img }
                }
            }.resume()
        }
    }
}

struct CachedAvatarView: View {
    let pictureUrl: String?
    let title: String
    var mid: String = ""
    var size: CGFloat = 38
    var isMuted: Bool = false

    @StateObject private var loader = ImageLoader()

    var monogramText: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return String(trimmed.prefix(1))
        }
        if !mid.isEmpty {
            return String(mid.prefix(2).uppercased())
        }
        return "Y"
    }

    var body: some View {
        ZStack {
            if let image = loader.image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else {
                fallbackMonogram
            }
        }
        .frame(width: size, height: size)
        .overlay(
            Circle()
                .stroke(Color.white.opacity(0.18), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.15), radius: 3, x: 0, y: 1.5)
        .onAppear {
            if let url = pictureUrl, !url.isEmpty {
                loader.load(urlStr: url)
            }
        }
        .onChange(of: pictureUrl) { _, newUrl in
            if let url = newUrl, !url.isEmpty {
                loader.load(urlStr: url)
            } else {
                loader.image = nil
            }
        }
    }

    var fallbackMonogram: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        gradient: Gradient(
                            colors: isMuted
                                ? [
                                    Color.white.opacity(0.12),
                                    Color.white.opacity(0.08),
                                ]
                                : [
                                    EnterpriseTheme.accent.opacity(0.9),
                                    EnterpriseTheme.accent,
                                ]),
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            Text(monogramText)
                .font(.system(size: max(10, size * 0.38), weight: .bold))
                .foregroundColor(.white)
        }
    }
}

// MARK: - LINE Chat Models

struct LineChatItem: Identifiable, Codable, Hashable {
    let id: String
    var title: String
    var lastMessage: String
    var timeString: String
    var timestamp: Double?
    var unreadCount: Int
    var isMuted: Bool
    var isGroup: Bool
    var hasMention: Bool
    var pictureUrl: String?
    var isOfficial: Bool?
    var attentionScore: Int
    var attentionTier: AttentionTier
    var attentionReason: String
    var timestampValue: Double { timestamp ?? 0 }

    /// Single source of truth for the attention inbox. Unread alone is not
    /// sufficient: official promotions are down-ranked while requests,
    /// deadlines and explicit user priority are explainable signals.
    var needsAttention: Bool {
        ![.pending, .filtered].contains(attentionEvaluation.tier)
            && (unreadCount > 0 || hasMention || YomiAttentionPolicyStore.isPriority(id))
    }
}

struct BuddyRichMenuArea: Codable, Hashable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let type: String
    let uri: String?
    let text: String?
}

struct BuddyRichMenu: Codable, Hashable {
    let label: String
    let richMenuId: String
    let selected: Bool
    let width: Double
    let height: Double
    let imageUrl: String
    let areas: [BuddyRichMenuArea]
}

struct LineFlexMessageAction: Codable, Hashable {
    let type: String
    let label: String
    let uri: String?
    let text: String?
    let data: String?
}

struct LineFlexMessageRegion: Codable, Hashable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let action: LineFlexMessageAction
}

struct LineFlexResolvedStyle: Codable, Hashable {
    let axis: String?
    let spacing: Double
    let paddingTop: Double
    let paddingEnd: Double
    let paddingBottom: Double
    let paddingStart: Double
    let marginBefore: Double
    let fontSize: Double
    let fontWeight: Int
    let lineLimit: Int?
    let aspectRatio: Double
    let contentMode: String
    let buttonStyle: String
    let buttonHeight: Double
    let cornerRadius: Double
    let borderWidth: Double
    let flexGrow: Double
    let position: String
    let offsetTop: Double?
    let offsetBottom: Double?
    let offsetStart: Double?
    let offsetEnd: Double?
    let widthPoints: Double?
    let widthFraction: Double?
    let maxWidthPoints: Double?
    let maxWidthFraction: Double?
    let heightPoints: Double?
    let heightFraction: Double?
    let maxHeightPoints: Double?
    let maxHeightFraction: Double?
}

struct LineFlexMessageGradient: Codable, Hashable {
    let type: String
    let angle: Double
    let startColor: String
    let centerColor: String?
    let endColor: String
    let centerPosition: Double?
}

struct LineFlexMessageNode: Codable, Hashable {
    let type: String
    let block: String?
    let layout: String?
    let text: String?
    let url: String?
    let color: String?
    let backgroundColor: String?
    let background: LineFlexMessageGradient?
    let size: String?
    let weight: String?
    let wrap: Bool?
    let margin: String?
    let spacing: String?
    let paddingAll: String?
    let paddingTop: String?
    let paddingBottom: String?
    let paddingStart: String?
    let paddingEnd: String?
    let style: String?
    let height: String?
    let width: String?
    let maxWidth: String?
    let maxHeight: String?
    let justifyContent: String?
    let alignItems: String?
    let cornerRadius: String?
    let borderColor: String?
    let borderWidth: String?
    let separator: Bool
    let separatorColor: String?
    let maxLines: Int?
    let decoration: String?
    let position: String?
    let offsetTop: String?
    let offsetBottom: String?
    let offsetStart: String?
    let offsetEnd: String?
    let resolved: LineFlexResolvedStyle
    let aspectRatio: String?
    let aspectMode: String?
    let align: String?
    let gravity: String?
    let flex: Double?
    let action: LineFlexMessageAction?
    let children: [LineFlexMessageNode]
}

struct LineFlexMessageDocument: Codable, Hashable {
    let version: Int
    let layoutVersion: Int?
    let layoutFingerprint: String?
    let kind: String
    let altText: String
    let width: Double?
    let height: Double?
    let imageUrl: String?
    let regions: [LineFlexMessageRegion]
    let root: LineFlexMessageNode?
}

struct AttentionRefinement: Codable {
    let id: String
    let attentionScore: Int
    let attentionTier: AttentionTier
    let attentionReason: String
}

struct LineChatMessage: Identifiable, Codable, Hashable {
    let id: String
    var fromMid: String
    var fromName: String
    var fromPictureUrl: String?
    var isSelf: Bool
    var text: String
    var timeString: String
    var timestamp: Double?
    var contentType: Int?
    var mediaType: String?
    var mediaUrl: String?
    var actionUrl: String?
    var flexDocument: LineFlexMessageDocument?
    var fileName: String?
    var isDecryptFailure: Bool?
    var isUnsent: Bool?
    var isDeliveryFailed: Bool?
    var isDeliveryPending: Bool?
    var mentionRanges: [MessageTextRange]?
    var threadMid: String?
    var isThreadRoot: Bool?
    var threadReplies: [LineChatMessage]?
    var emojiRanges: [MessageEmojiRange]?
    // LINE's message payload has no recipient-read timestamp. Do not derive
    // a read badge from isSelf or deliveredTime; that would claim a state the
    // protocol did not report.
}

struct MessageTextRange: Codable, Hashable {
    let location: Int
    let length: Int
}

struct MessageEmojiRange: Codable, Hashable {
    let location: Int
    let length: Int
    let url: String
}

struct LineMentionTarget: Codable, Hashable {
    let mid: String
    let name: String
}

struct StickerPackageItem: Identifiable, Codable, Hashable {
    let packageId: String
    let title: String
    let version: String
    var id: String { packageId }
}

struct StickerPreviewItem: Identifiable, Codable, Hashable {
    let stickerId: String
    let packageId: String
    let data: String
    let mimeType: String
    var id: String { "\(packageId):\(stickerId)" }
}

struct MediaPreviewPayload: Codable {
    let data: String?
    let filePath: String?
    let mimeType: String?
    let fileName: String?
}

/// Defense-in-depth for stale runtimes or an unexpected raw bridge payload.
/// The TypeScript boundary is authoritative, but the desktop must never paint
/// E2EE transport fields even if an older dist/bridge is still running.
func sanitizeDesktopMessagePreview(_ value: String) -> String {
    let lower = value.lowercased()
    let sensitive = ["keymaterial", "ciphertext", "nonce", "chunks", "keys"]
    if sensitive.contains(where: { lower.contains("\"\($0)\"") || lower.contains("\($0):") }) {
        return "[yomi:encrypted]"
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("{") else { return value }
    guard let data = trimmed.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        return value
    }
    for key in ["text", "message", "body", "content", "caption"] {
        if let nested = object[key] as? String {
            let safe = sanitizeDesktopMessagePreview(nested)
            if safe != nested || !safe.isEmpty { return safe }
        }
    }
    return "[yomi:encrypted]"
}

func localizedDesktopMessagePreview(_ value: String, using i18n: I18n) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("[yomi:") else { return value }
    if trimmed.hasPrefix("[yomi:call_duration:"), trimmed.hasSuffix("]") {
        let rawSeconds = trimmed.dropFirst("[yomi:call_duration:".count).dropLast()
        if let seconds = Int(rawSeconds) {
            let duration = String(format: "%02d:%02d", seconds / 60, seconds % 60)
            return i18n.t("message_call_duration").replacingOccurrences(of: "%@", with: duration)
        }
        return i18n.t("message_call")
    }
    if trimmed.hasPrefix("[yomi:line_content:") {
        let type = trimmed.dropFirst("[yomi:line_content:".count).dropLast()
        return i18n.t("message_line_content").replacingOccurrences(of: "%@", with: String(type))
    }
    let code = String(trimmed.dropFirst(6).dropLast())
    let key = "message_\(code)"
    let localized = i18n.t(key)
    // A future protocol content type must remain user-readable even before its
    // copy is added to I18n. Never expose an internal semantic key in the UI.
    return localized == key ? i18n.t("message_message") : localized
}

// MARK: - Attention-First Chat List Row

private struct SearchHighlightedText: View {
    let value: String
    let query: String
    let fontSize: CGFloat
    let weight: Font.Weight
    let color: Color
    var matchColor: Color = EnterpriseTheme.accent

    private var highlighted: Text {
        var output = Text("")
        var cursor = value.startIndex
        for range in searchMatchRanges(in: value, query: query) {
            if cursor < range.lowerBound {
                output = Text("\(output)\(Text(String(value[cursor..<range.lowerBound])).foregroundColor(color))")
            }
            let match = Text(String(value[range]))
                .font(.system(size: fontSize, weight: .bold))
                .foregroundColor(matchColor)
            output = Text("\(output)\(match)")
            cursor = range.upperBound
        }
        if cursor < value.endIndex {
            output = Text("\(output)\(Text(String(value[cursor...])).foregroundColor(color))")
        }
        return output
    }

    var body: some View {
        highlighted
            .font(.system(size: fontSize, weight: weight))
            .lineLimit(1)
    }
}

struct ChatRowView: View {
    @ObservedObject var state: AppState
    let item: LineChatItem
    var isSelected: Bool = false
    var searchQuery: String = ""
    let onSelect: () -> Void
    @State private var isHovered: Bool = false

    // Selected rows use a deep ink/accent surface in both appearances. Keep
    // every trailing value derived from the row state so an unread accent
    // never wins over the selected-state contrast colour.
    private var timeColor: Color {
        if isSelected { return EnterpriseTheme.selectedSecondaryText }
        return item.unreadCount > 0 && !item.isMuted
            ? EnterpriseTheme.accent
            : EnterpriseTheme.secondaryText
    }

    private var selectedBadgeBackground: Color {
        isSelected ? EnterpriseTheme.selectedText : EnterpriseTheme.accent
    }

    private var selectedBadgeText: Color {
        isSelected ? EnterpriseTheme.selected : Color.white
    }

    private var localizedLastMessage: String {
        localizedDesktopMessagePreview(
            sanitizeDesktopMessagePreview(item.lastMessage),
            using: state.i18n
        )
    }

    var body: some View {
        Button(action: {
            onSelect()
        }) {
            HStack(spacing: 10) {
                // 1. Avatar (Cached)
                CachedAvatarView(
                    pictureUrl: item.pictureUrl,
                    title: item.title,
                    size: 38,
                    isMuted: item.isMuted
                )

                // 2. Middle column: Title and message preview
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 5) {
                        SearchHighlightedText(
                            value: item.title,
                            query: searchQuery,
                            fontSize: 14.5,
                            weight: isSelected ? .bold : .semibold,
                            color: isSelected ? EnterpriseTheme.selectedText : EnterpriseTheme.text,
                            matchColor: isSelected ? EnterpriseTheme.selectedText : EnterpriseTheme.accent
                        )

                        if item.isGroup {
                            Image(systemName: "person.2.fill")
                                .font(.system(size: 12))
                                .foregroundColor(isSelected ? EnterpriseTheme.selectedSecondaryText : EnterpriseTheme.secondaryText)
                        }
                    }

                    SearchHighlightedText(
                        value: searchDisplayText(localizedLastMessage, query: searchQuery).value,
                        query: searchQuery,
                        fontSize: 13,
                        weight: .regular,
                        color: isSelected ? EnterpriseTheme.selectedSecondaryText : EnterpriseTheme.secondaryText,
                        matchColor: isSelected ? EnterpriseTheme.selectedText : EnterpriseTheme.accent
                    )
                }

                Spacer(minLength: 8)

                // 3. Right column: Timestamp (Top) & Badges/Mute (Bottom)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(item.timeString)
                        .font(.system(size: 12, weight: item.unreadCount > 0 && !item.isMuted ? .semibold : .regular))
                        .foregroundColor(timeColor)

                    HStack(spacing: 4) {
                        // Reserve both trailing slots even when absent. This
                        // keeps mute icons and unread badges on one reference
                        // line across every row state.
                        Group {
                            if item.isMuted || YomiAttentionPolicyStore.isMuted(item.id) {
                                Image(
                                    systemName: item.isMuted
                                        ? "bell.slash.fill" : "bolt.slash.fill"
                                )
                                .font(.system(size: 11))
                                .foregroundColor(isSelected ? EnterpriseTheme.selectedSecondaryText : EnterpriseTheme.secondaryText)
                            } else {
                                Color.clear
                            }
                        }
                        .frame(width: 18, height: 18, alignment: .center)

                        Group {
                            if item.unreadCount > 0 {
                                Text("\(item.unreadCount)")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundColor(selectedBadgeText)
                                    .padding(.horizontal, 5.5)
                                    .padding(.vertical, 1)
                                    .background(
                                        item.isMuted
                                            ? (isSelected
                                                ? EnterpriseTheme.selectedSecondaryText.opacity(0.42) : Color.secondary.opacity(0.35))
                                            : selectedBadgeBackground
                                    )
                                    .clipShape(Capsule())
                            } else {
                                Color.clear
                            }
                        }
                        .frame(width: 28, height: 18, alignment: .center)
                    }
                    .frame(height: 18, alignment: .trailing)
                }
                // Keep the trailing reference line stable when macOS adds or
                // removes the overlay scrollbar. The row owns a fixed gutter;
                // timestamps and badges never reflow with indicator changes.
                .frame(width: 58, alignment: .trailing)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 68, alignment: .leading)
            .background(
                isSelected
                    ? EnterpriseTheme.selected
                    : (isHovered ? EnterpriseTheme.raisedSurface : Color.clear)
            )
            .cornerRadius(8)
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(PlainButtonStyle())
        .onHover { hovering in
            isHovered = hovering
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(item.title). \(localizedLastMessage)"))
        .accessibilityValue(Text(isSelected ? "已選取" : ""))
        .contextMenu {
            Button(action: {
                state.setYomiMuted(
                    chatId: item.id,
                    enabled: !YomiAttentionPolicyStore.isMuted(item.id))
            }) {
                Label(
                    YomiAttentionPolicyStore.isMuted(item.id)
                        ? state.i18n.t("attention_restore") : state.i18n.t("attention_exclude"),
                    systemImage: YomiAttentionPolicyStore.isMuted(item.id)
                        ? "bolt.fill" : "bolt.slash.fill")
            }
            Button(action: { state.setYomiPriority(chatId: item.id, enabled: !YomiAttentionPolicyStore.isPriority(item.id)) }) {
                Label(YomiAttentionPolicyStore.isPriority(item.id) ? "取消優先" : "永遠列為優先", systemImage: "bolt.fill")
            }
            Divider()
            Button(action: {
                state.setLineMuted(chatId: item.id, enabled: !item.isMuted)
            }) {
                Label(
                    state.i18n.t(item.isMuted ? "line_unmute" : "line_mute"),
                    systemImage: item.isMuted ? "bell.fill" : "bell.slash.fill")
            }
            .disabled(!item.id.hasPrefix("u"))
        }
    }
}

// MARK: - Message Media & Bubble Rows
