import AVFoundation
import AVKit
import Cocoa
import SwiftUI

final class AudioPreviewController: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var isPlaying = false
    private var player: AVAudioPlayer?

    func toggle(data: Data) {
        if let player, player.isPlaying {
            player.pause()
            isPlaying = false
            return
        }
        do {
            if player == nil {
                let next = try AVAudioPlayer(data: data)
                next.delegate = self
                next.prepareToPlay()
                player = next
            }
            player?.play()
            isPlaying = true
        } catch {
            isPlaying = false
        }
    }

    func stop() {
        player?.stop()
        isPlaying = false
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        isPlaying = false
    }

    deinit {
        player?.stop()
    }
}

struct AudioMessageView: View {
    @ObservedObject var state: AppState
    let chatId: String
    let msg: LineChatMessage
    @StateObject private var controller = AudioPreviewController()

    private var data: Data? { state.mediaPreviewAudioData[msg.id] }

    private var statusText: String {
        if state.mediaPreviewFailures.contains(msg.id) {
            return state.i18n.t("audio_play_failed")
        }
        return data == nil ? state.i18n.t("audio_loading") : state.i18n.t("audio_play")
    }

    var body: some View {
        HStack(spacing: 10) {
            Button {
                if let data { controller.toggle(data: data) }
            } label: {
                Image(systemName: controller.isPlaying ? "pause.fill" : "play.fill")
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.borderedProminent)
            .disabled(data == nil)
            VStack(alignment: .leading, spacing: 3) {
                Text(msg.fileName ?? state.i18n.t("message_audio"))
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                Text(statusText)
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minWidth: 210, maxWidth: 320, alignment: .leading)
        .background(EnterpriseTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .onAppear {
            state.loadMediaPreview(chatId: chatId, messageId: msg.id, original: true)
        }
        .onDisappear {
            controller.stop()
        }
    }
}

struct VideoMessageView: View {
    @ObservedObject var state: AppState
    let chatId: String
    let msg: LineChatMessage
    @State private var player: AVPlayer?
    @State private var videoAspectRatio: CGFloat = 16.0 / 9.0

    private var displaySize: CGSize {
        let ratio =
            videoAspectRatio.isFinite && videoAspectRatio > 0
            ? videoAspectRatio
            : 16.0 / 9.0
        let maximum = CGSize(width: 420, height: 320)
        if maximum.width / ratio <= maximum.height {
            return CGSize(width: maximum.width, height: maximum.width / ratio)
        }
        return CGSize(width: maximum.height * ratio, height: maximum.height)
    }

    var body: some View {
        Group {
            if let url = state.mediaPreviewVideoURLs[msg.id] {
                VideoPlayer(player: player)
                    .frame(width: displaySize.width, height: displaySize.height)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .onAppear {
                        if player == nil { player = AVPlayer(url: url) }
                    }
                    .task(id: url) {
                        await loadVideoAspectRatio(from: url)
                    }
                    .onDisappear {
                        player?.pause()
                    }
            } else if state.mediaPreviewFailures.contains(msg.id) {
                MediaAttachmentCard(state: state, chatId: chatId, msg: msg, mediaTypeOverride: "video")
            } else {
                VStack(spacing: 7) {
                    ProgressView()
                    Text(state.i18n.t("video_loading"))
                        .font(.system(size: 13, weight: .medium))
                }
                .foregroundColor(.secondary)
                .frame(width: 240, height: 135)
                .background(EnterpriseTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .onAppear {
                    state.loadMediaPreview(chatId: chatId, messageId: msg.id, original: true)
                }
            }
        }
    }

    private func loadVideoAspectRatio(from url: URL) async {
        let asset = AVURLAsset(url: url)
        guard
            let tracks = try? await asset.loadTracks(withMediaType: .video),
            let track = tracks.first,
            let naturalSize = try? await track.load(.naturalSize),
            let transform = try? await track.load(.preferredTransform)
        else { return }

        let orientedSize = naturalSize.applying(transform)
        let width = abs(orientedSize.width)
        let height = abs(orientedSize.height)
        guard width > 0, height > 0 else { return }
        await MainActor.run {
            videoAspectRatio = width / height
        }
    }
}

struct LineMediaContentView: View {
    @ObservedObject var state: AppState
    let chatId: String
    let msg: LineChatMessage
    var onRichMessageAction: (String) -> Void = { _ in }

    var body: some View {
        if msg.mediaType == "sticker", let url = msg.mediaUrl, !url.isEmpty {
            if let image = inlineDataImage(url) {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 240, maxHeight: 240)
            } else {
                RemoteMediaImageView(url: url, label: state.i18n.t("message_sticker"))
            }
        } else if msg.mediaType == "rich" {
            RichMediaContentView(
                state: state,
                msg: msg,
                onMessageAction: onRichMessageAction
            )
        } else if msg.mediaType == "image" {
            if let value = msg.mediaUrl, let image = inlineImage(value) {
                ZoomableMessageImage(image: image)
            } else if let image = state.mediaPreviewImages[msg.id] {
                ZoomableMessageImage(image: image) {
                    state.loadMediaPreview(chatId: chatId, messageId: msg.id, original: true)
                }
            } else if state.mediaPreviewFailures.contains(msg.id) {
                Button {
                    state.loadMediaPreview(chatId: chatId, messageId: msg.id)
                } label: {
                    VStack(spacing: 8) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 20, weight: .semibold))
                        Text(state.i18n.t("image_preview_failed"))
                            .font(.system(size: 13, weight: .medium))
                        Text(state.i18n.t("image_retry"))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(EnterpriseTheme.accent)
                    }
                    .foregroundColor(.secondary)
                    .frame(width: 190, height: 110)
                    .background(EnterpriseTheme.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .contentShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .help(state.i18n.t("image_retry"))
                .accessibilityLabel(state.i18n.t("image_retry"))
            } else {
                VStack(spacing: 7) {
                    ProgressView()
                    Text(state.i18n.t("image_loading"))
                        .font(.system(size: 13, weight: .medium))
                }
                .foregroundColor(.secondary)
                .frame(width: 190, height: 110)
                .background(EnterpriseTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .onAppear { state.loadMediaPreview(chatId: chatId, messageId: msg.id) }
            }
        } else if msg.mediaType == "audio" {
            AudioMessageView(state: state, chatId: chatId, msg: msg)
        } else if msg.mediaType == "video" {
            VideoMessageView(state: state, chatId: chatId, msg: msg)
        } else if msg.mediaType == "call" {
            HStack(spacing: 8) {
                Image(systemName: "phone.fill")
                    .foregroundColor(EnterpriseTheme.accent)
                Text(localizedDesktopMessagePreview(msg.text, using: state.i18n))
                    .font(.system(size: 14, weight: .medium))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(EnterpriseTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        } else {
            MediaAttachmentCard(state: state, chatId: chatId, msg: msg)
        }
    }

    private func inlineDataImage(_ value: String) -> NSImage? {
        guard value.hasPrefix("data:"), let comma = value.firstIndex(of: ","),
            let data = Data(base64Encoded: String(value[value.index(after: comma)...]))
        else { return nil }
        return NSImage(data: data)
    }

    private func inlineImage(_ value: String) -> NSImage? {
        if let dataImage = inlineDataImage(value) { return dataImage }
        guard let url = URL(string: value), url.isFileURL else { return nil }
        return NSImage(contentsOf: url)
    }
}

private struct MessageEventRow: View {
    let msg: LineChatMessage
    let senderName: String
    let icon: String
    let description: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            CachedAvatarView(pictureUrl: msg.fromPictureUrl, title: msg.fromName, size: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(senderName)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.secondary)
                HStack(spacing: 7) {
                    Image(systemName: icon)
                        .foregroundColor(tint)
                    Text(description)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundColor(.secondary)
                    Text(msg.timeString)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary.opacity(0.65))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(tint.opacity(0.06))
                .clipShape(Capsule())
            }
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity)
    }
}

struct ChatMessageBubbleRow: View {
    @ObservedObject var state: AppState
    let chatId: String
    let msg: LineChatMessage
    var onMention: (String, String) -> Void = { _, _ in }
    var onOpenThread: (LineChatMessage) -> Void = { _ in }
    var onRichMessageAction: (String) -> Void = { _ in }

    private var hasMedia: Bool { msg.mediaType != nil }
    private var isSystemEvent: Bool { msg.contentType == 18 }
    private var isDecryptFailure: Bool { msg.isDecryptFailure == true }
    private var isUnsent: Bool { msg.isUnsent == true }
    private var threadReplies: [LineChatMessage] { msg.threadReplies ?? [] }

    private var localizedText: String {
        localizedDesktopMessagePreview(
            sanitizeDesktopMessagePreview(msg.text),
            using: state.i18n
        )
    }

    private var eventSenderName: String {
        msg.isSelf ? state.i18n.t("message_you") : msg.fromName
    }

    private var eventDescription: String {
        if isUnsent {
            return state.i18n.t("message_unsent_by").replacingOccurrences(of: "%@", with: eventSenderName)
        }
        return state.i18n.t("message_decrypt_event")
    }

    private var needsRichTextRenderer: Bool {
        !((msg.emojiRanges ?? []).isEmpty)
            || localizedText.range(of: #"https?://"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    @ViewBuilder
    private var content: some View {
        if hasMedia {
            LineMediaContentView(
                state: state,
                chatId: chatId,
                msg: msg,
                onRichMessageAction: onRichMessageAction
            )
        } else if needsRichTextRenderer {
            LinkifiedMessageText(
                value: localizedText,
                color: msg.isSelf ? .white : .primary,
                mentionRanges: msg.mentionRanges ?? [],
                emojiRanges: msg.emojiRanges ?? []
            )
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(msg.isSelf ? EnterpriseTheme.selected : EnterpriseTheme.surface)
            .cornerRadius(12)
        } else {
            Text(localizedText)
                .font(.system(size: 15))
                .foregroundColor(msg.isSelf ? .white : .primary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(msg.isSelf ? EnterpriseTheme.selected : EnterpriseTheme.surface)
                .cornerRadius(12)
        }
    }

    @ViewBuilder
    private var threadedContent: some View {
        VStack(alignment: msg.isSelf ? .trailing : .leading, spacing: 5) {
            content
            if msg.isThreadRoot == true {
                Button {
                    onOpenThread(msg)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "bubble.left.and.bubble.right")
                        Text(
                            String(
                                format: state.i18n.t("thread_reply_count"),
                                threadReplies.count))
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                    }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(EnterpriseTheme.accent)
                }
                .buttonStyle(.plain)
                .disabled(threadReplies.isEmpty)
                .accessibilityLabel(
                    String(format: state.i18n.t("thread_accessibility"), threadReplies.count))

            }
        }
    }

    @ViewBuilder
    var body: some View {
        Group {
            if isDecryptFailure {
                MessageEventRow(
                    msg: msg,
                    senderName: eventSenderName,
                    icon: "info.circle.fill",
                    description: eventDescription,
                    tint: .red
                )
                .accessibilityLabel(
                    state.i18n.t("message_decrypt_accessibility")
                        .replacingOccurrences(of: "%@", with: eventSenderName))
            } else if isUnsent {
                MessageEventRow(
                    msg: msg,
                    senderName: eventSenderName,
                    icon: "arrow.uturn.backward.circle",
                    description: eventDescription,
                    tint: .secondary
                )
                .accessibilityLabel(eventDescription)
            } else if isSystemEvent {
                HStack(spacing: 8) {
                    Spacer(minLength: 32)
                    Text(localizedText)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .textSelection(.enabled)
                    Text(msg.timeString)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary.opacity(0.65))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 32)
                }
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .accessibilityLabel("\(state.i18n.t("message_chat_event"))：\(localizedText)")
            } else {
                HStack(alignment: hasMedia ? .top : .bottom, spacing: 8) {
                    if msg.isSelf {
                        Spacer(minLength: 40)
                        if msg.isDeliveryPending == true {
                            ProgressView()
                                .controlSize(.small)
                                .help(state.i18n.t("message_sending"))
                                .accessibilityLabel(state.i18n.t("message_sending"))
                                .padding(.bottom, 2)
                        } else if msg.isDeliveryFailed == true {
                            Image(systemName: "exclamationmark.circle.fill")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundColor(.red)
                                .help(state.i18n.t("message_send_failed"))
                                .accessibilityLabel(state.i18n.t("message_send_failed"))
                                .padding(.bottom, 2)
                        }
                        Text(msg.timeString)
                            .font(.system(size: 12))
                            .foregroundColor(.secondary.opacity(0.7))
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(.bottom, 2)
                        threadedContent
                    } else {
                        Button {
                            onMention(msg.fromMid, msg.fromName)
                        } label: {
                            CachedAvatarView(pictureUrl: msg.fromPictureUrl, title: msg.fromName, size: 28)
                        }
                        .buttonStyle(.plain)
                        .help("提及 \(msg.fromName)")
                        VStack(alignment: .leading, spacing: 3) {
                            Text(msg.fromName)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(.secondary)
                            HStack(alignment: .bottom, spacing: 6) {
                                threadedContent
                                Text(msg.timeString)
                                    .font(.system(size: 12))
                                    .foregroundColor(.secondary.opacity(0.7))
                                    .lineLimit(1)
                                    .fixedSize(horizontal: true, vertical: false)
                                    .padding(.bottom, 2)
                            }
                        }
                        Spacer(minLength: 40)
                    }
                }
                .frame(maxWidth: .infinity, alignment: msg.isSelf ? .trailing : .leading)
            }
        }
    }
}

struct ThreadInspectorView: View {
    @ObservedObject var state: AppState
    let chatId: String
    let root: LineChatMessage
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.i18n.t("thread_title"))
                        .font(.system(size: 16, weight: .bold))
                    Text(
                        String(
                            format: state.i18n.t("thread_reply_count"),
                            root.threadReplies?.count ?? 0)
                    )
                    .font(.system(size: 12)).foregroundColor(.secondary)
                }
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark").frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(state.i18n.t("thread_close"))
            }
            .padding(.horizontal, 20)
            .frame(height: 72)
            Divider()

            MaterialScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(state.i18n.t("thread_original_message"))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(.secondary)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(root.fromName).font(.system(size: 12, weight: .semibold)).foregroundColor(.secondary)
                            Text(root.text).font(.system(size: 14.5)).textSelection(.enabled)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(EnterpriseTheme.raisedSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        Text(state.i18n.t("thread_replies"))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(.secondary)
                        ForEach(root.threadReplies ?? []) { reply in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text(reply.fromName).font(.system(size: 12, weight: .semibold))
                                    Spacer()
                                    Text(reply.timeString)
                                        .font(.system(size: 11))
                                        .foregroundColor(.secondary)
                                        .lineLimit(1)
                                        .fixedSize(horizontal: true, vertical: false)
                                }
                                if reply.mediaType != nil {
                                    LineMediaContentView(state: state, chatId: chatId, msg: reply)
                                        .frame(maxWidth: 260, alignment: .leading)
                                } else {
                                    Text(reply.text)
                                        .font(.system(size: 14))
                                        .textSelection(.enabled)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            .padding(12)
                            .background(EnterpriseTheme.raisedSurface.opacity(0.72))
                            .overlay(alignment: .leading) {
                                Rectangle().fill(EnterpriseTheme.accent.opacity(0.5)).frame(width: 2)
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    }
                }
                .padding(20)
            }
        }
        .frame(minWidth: 300, idealWidth: 360, maxWidth: 440)
        .background(EnterpriseTheme.canvas)
    }
}

/// A native AppKit text system for message bodies.
///
/// SwiftUI's `Text` can only provide hover state for the whole view. That made
/// an entire bubble use a pointing-hand cursor when it contained one URL, and
/// made cursor push/pop state leak when a view disappeared while hovered.
/// NSTextView owns the hit testing instead: only ranges carrying `.link` get
/// the link cursor, while ordinary text keeps the I-beam/arrow behaviour.
final class LinkMessageTextView: NSTextView {
    static let font = NSFont.systemFont(ofSize: 15)

    override var isFlipped: Bool { true }

    func measuredSize(for width: CGFloat) -> NSSize {
        guard let textContainer, let layoutManager else { return NSSize(width: width, height: 20) }
        let measuredWidth = max(1, width)
        textContainer.containerSize = NSSize(width: measuredWidth, height: CGFloat.greatestFiniteMagnitude)
        textContainer.widthTracksTextView = false
        layoutManager.ensureLayout(for: textContainer)
        let used = layoutManager.usedRect(for: textContainer)
        let height = ceil(max(1, used.height + textContainerInset.height * 2))
        return NSSize(width: measuredWidth, height: height)
    }

    override var intrinsicContentSize: NSSize {
        let width = bounds.width > 1 ? bounds.width : 320
        return measuredSize(for: width)
    }

}

/// Renders only http/https URLs as links, preserving message text and line
/// breaks. NSDataDetector may identify other URL-like schemes; those ranges
/// deliberately remain ordinary text and are never clickable.
@MainActor
private final class InlineEmojiImageStore {
    static let shared = InlineEmojiImageStore()
    private let limit = 512
    private var images: [String: NSImage] = [:]
    private var order: [String] = []

    func image(for url: String) -> NSImage? {
        guard let image = images[url] else { return nil }
        order.removeAll { $0 == url }
        order.append(url)
        return image
    }

    func insert(_ image: NSImage, for url: String) {
        images[url] = image
        order.removeAll { $0 == url }
        order.append(url)
        while order.count > limit, let oldest = order.first {
            order.removeFirst()
            images.removeValue(forKey: oldest)
        }
    }
}

struct LinkifiedMessageText: NSViewRepresentable {
    let value: String
    let color: Color
    var mentionRanges: [MessageTextRange] = []
    var emojiRanges: [MessageEmojiRange] = []

    private var foregroundColor: NSColor {
        NSColor(color)
    }

    private var linkColor: NSColor {
        NSColor(EnterpriseTheme.accent)
    }

    fileprivate func attributedString(emojiImages: [String: NSImage] = [:]) -> NSAttributedString {
        let result = NSMutableAttributedString(
            string: value,
            attributes: [
                .font: LinkMessageTextView.font,
                .foregroundColor: foregroundColor,
            ]
        )
        for mention in mentionRanges {
            let range = NSRange(location: mention.location, length: mention.length)
            guard range.location >= 0, range.length > 0, NSMaxRange(range) <= result.length else { continue }
            result.addAttributes(
                [
                    .foregroundColor: NSColor.systemBlue,
                    .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
                ],
                range: range
            )
        }
        for emoji in emojiRanges.sorted(by: { $0.location > $1.location }) {
            let range = NSRange(location: emoji.location, length: emoji.length)
            guard NSMaxRange(range) <= result.length, let image = emojiImages[emoji.url] else { continue }
            let attachment = NSTextAttachment()
            let rendered = NSImage(size: NSSize(width: 19, height: 19))
            rendered.lockFocus()
            image.draw(in: NSRect(x: 0, y: 0, width: 19, height: 19))
            rendered.unlockFocus()
            attachment.image = rendered
            attachment.bounds = NSRect(x: 0, y: -3, width: 19, height: 19)
            result.replaceCharacters(in: range, with: NSAttributedString(attachment: attachment))
        }
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return result
        }

        let nsValue = value as NSString
        detector.enumerateMatches(
            in: value,
            options: [],
            range: NSRange(location: 0, length: nsValue.length)
        ) { match, _, _ in
            guard let match, let url = match.url,
                let scheme = url.scheme?.lowercased(),
                scheme == "http" || scheme == "https",
                match.range.location != NSNotFound,
                NSMaxRange(match.range) <= result.length
            else { return }
            result.addAttributes(
                [
                    .link: url,
                    .foregroundColor: linkColor,
                    .underlineStyle: NSUnderlineStyle.single.rawValue,
                ], range: match.range)
        }
        return result
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeNSView(context: Context) -> LinkMessageTextView {
        let textView = LinkMessageTextView(frame: .zero)
        textView.delegate = context.coordinator
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.allowsUndo = false
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.insertionPointColor = .clear
        textView.textContainerInset = .zero
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        context.coordinator.render(in: textView)
        textView.linkTextAttributes = [
            .foregroundColor: linkColor,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .cursor: NSCursor.pointingHand,
        ]
        textView.setAccessibilityLabel(value)
        return textView
    }

    func updateNSView(_ textView: LinkMessageTextView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.render(in: textView)
        textView.linkTextAttributes = [
            .foregroundColor: linkColor,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .cursor: NSCursor.pointingHand,
        ]
        textView.setAccessibilityLabel(value)
        // NSTextView/AppKit will lay out after textStorage changes. Do not
        // invalidate intrinsic size from layout/update unconditionally: that
        // creates an AppKit-to-SwiftUI constraint recursion for long or link-rich
        // messages.
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: LinkMessageTextView, context: Context) -> CGSize? {
        let maximumWidth = min(proposal.width ?? 460, 460)
        let naturalWidth = ceil(
            nsView.attributedString().boundingRect(
                with: NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading]
            ).width
        )
        let width = min(maximumWidth, max(1, naturalWidth))
        return nsView.measuredSize(for: width)
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: LinkifiedMessageText
        private var renderedValue: String?
        private var renderedColor: NSColor?
        private var renderedMentions: [MessageTextRange] = []
        private var renderedEmojiRanges: [MessageEmojiRange] = []
        private var renderedEmojiURLs = Set<String>()
        private var loadingEmojiURLs = Set<String>()
        private var emojiRetryCounts: [String: Int] = [:]

        init(parent: LinkifiedMessageText) {
            self.parent = parent
            super.init()
        }

        func render(in textView: LinkMessageTextView) {
            var images: [String: NSImage] = [:]
            var missing: [String] = []
            for emoji in parent.emojiRanges {
                let normalized = emoji.url.replacingOccurrences(
                    of: "line-scdn.net//", with: "line-scdn.net/")
                if let image = InlineEmojiImageStore.shared.image(for: normalized) {
                    images[emoji.url] = image
                } else if let url = URL(string: normalized),
                    let image = ImageCache.shared.memoryImage(for: url)
                {
                    InlineEmojiImageStore.shared.insert(image, for: normalized)
                    images[emoji.url] = image
                } else if !missing.contains(emoji.url) {
                    missing.append(emoji.url)
                }
            }
            let availableEmojiURLs = Set(images.keys)
            if renderedValue == parent.value,
                renderedColor?.isEqual(parent.foregroundColor) == true,
                renderedMentions == parent.mentionRanges,
                renderedEmojiRanges == parent.emojiRanges,
                renderedEmojiURLs == availableEmojiURLs
            {
                return
            }
            let next = parent.attributedString(emojiImages: images)
            if textView.textStorage?.isEqual(to: next) != true {
                textView.textStorage?.setAttributedString(next)
            }
            renderedValue = parent.value
            renderedColor = parent.foregroundColor
            renderedMentions = parent.mentionRanges
            renderedEmojiRanges = parent.emojiRanges
            renderedEmojiURLs = availableEmojiURLs
            for urlString in missing {
                guard loadingEmojiURLs.insert(urlString).inserted else { continue }
                let normalized = urlString.replacingOccurrences(
                    of: "line-scdn.net//", with: "line-scdn.net/")
                guard let url = URL(string: normalized) else { continue }
                let target = EmojiRenderTarget(coordinator: self, textView: textView)
                URLSession.shared.dataTask(with: url) { data, response, _ in
                    Task { @MainActor in
                        target.coordinator?.loadingEmojiURLs.remove(urlString)
                        guard let data, let response = response as? HTTPURLResponse,
                            (200..<300).contains(response.statusCode)
                        else {
                            self.scheduleEmojiRetry(urlString, textView: target.textView)
                            return
                        }
                        guard let self = target.coordinator, let textView = target.textView,
                            let image = NSImage(data: data),
                            self.parent.emojiRanges.contains(where: { $0.url == urlString })
                        else {
                            self.scheduleEmojiRetry(urlString, textView: target.textView)
                            return
                        }
                        ImageCache.shared.save(image: image, data: data, for: url)
                        InlineEmojiImageStore.shared.insert(image, for: normalized)
                        self.emojiRetryCounts.removeValue(forKey: urlString)
                        self.render(in: textView)
                        textView.invalidateIntrinsicContentSize()
                    }
                }.resume()
            }
        }

        private func scheduleEmojiRetry(_ urlString: String, textView: LinkMessageTextView?) {
            let attempt = (emojiRetryCounts[urlString] ?? 0) + 1
            emojiRetryCounts[urlString] = attempt
            guard attempt <= 3 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(attempt) * 0.4) { [weak self, weak textView] in
                guard let self, let textView else { return }
                self.renderedEmojiRanges = []
                self.render(in: textView)
            }
        }

        @MainActor
        final class EmojiRenderTarget: @unchecked Sendable {
            weak var coordinator: Coordinator?
            weak var textView: LinkMessageTextView?

            init(coordinator: Coordinator, textView: LinkMessageTextView) {
                self.coordinator = coordinator
                self.textView = textView
            }
        }

        private func allowed(_ url: URL) -> Bool {
            guard let scheme = url.scheme?.lowercased() else { return false }
            return scheme == "http" || scheme == "https"
        }

        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            guard let url = link as? URL, allowed(url) else { return true }
            NSWorkspace.shared.open(url)
            return true
        }

        func textView(
            _ textView: NSTextView,
            shouldInteractWith url: URL,
            in characterRange: NSRange
        ) -> Bool {
            allowed(url)
        }
    }
}
