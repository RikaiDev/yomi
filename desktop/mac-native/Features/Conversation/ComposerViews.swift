import Cocoa
import SwiftUI

enum ComposerHistoryStore {
    private static let limit = 50

    static func load(chatId: String, yomi: Bool) -> [String] {
        UserDefaults.standard.stringArray(forKey: key(chatId: chatId, yomi: yomi)) ?? []
    }

    static func append(_ value: String, chatId: String, yomi: Bool) {
        guard !value.isEmpty else { return }
        var values = load(chatId: chatId, yomi: yomi)
        if values.last != value { values.append(value) }
        UserDefaults.standard.set(Array(values.suffix(limit)), forKey: key(chatId: chatId, yomi: yomi))
    }

    private static func key(chatId: String, yomi: Bool) -> String {
        "composer.history.\(yomi ? "yomi" : "line").\(chatId)"
    }
}

struct ComposerActionButton: View {
    let title: String
    let icon: String
    var tint: Color = .secondary
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 9)
                .padding(.vertical, 7)
                .background(EnterpriseTheme.controlFill)
                .foregroundColor(tint)
                .cornerRadius(6)
        }
        .buttonStyle(PlainButtonStyle())
        .help(title)
        .accessibilityLabel(title)
    }
}

/// AppKit-backed multiline editor. SwiftUI's TextEditor modifier does not
/// consistently hide the enclosing NSScrollView's indicators on macOS.
struct HiddenScrollTextEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    @Binding var measuredHeight: CGFloat
    var onSubmit: () -> Void
    var onHistoryPrevious: () -> String?
    var onHistoryNext: () -> String?
    var onFileDrop: ([URL]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        // Keep the editor scrollable for long replies, but never paint a
        // scrollbar in the composer.  `autohidesScrollers` alone still lets
        // AppKit create an overlay thumb on some macOS versions.
        scrollView.scrollerStyle = .overlay
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.verticalScroller = nil
        scrollView.horizontalScroller = nil
        scrollView.autohidesScrollers = false
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalRuler = false
        let textView = ComposerTextView()
        textView.onCommandReturn = context.coordinator.submit
        textView.onHistoryPrevious = context.coordinator.historyPrevious
        textView.onHistoryNext = context.coordinator.historyNext
        textView.onFileURLsDropped = context.coordinator.fileURLsDropped
        context.coordinator.textView = textView
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.font = NSFont.systemFont(ofSize: 15)
        textView.textColor = .labelColor
        textView.insertionPointColor = .controlAccentColor
        textView.allowsUndo = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainerInset = NSSize(width: 11, height: 7)
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.setAccessibilityLabel("回覆訊息")
        scrollView.documentView = textView
        scrollView.verticalScroller = nil
        scrollView.horizontalScroller = nil
        context.coordinator.installActivationObservers()
        context.coordinator.updateInsets(for: textView, in: scrollView)
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        if textView.string != text {
            let selection = textView.selectedRange()
            textView.string = text
            let textLength = (text as NSString).length
            textView.setSelectedRange(
                NSRange(
                    location: min(selection.location, textLength),
                    length: min(selection.length, max(0, textLength - min(selection.location, textLength)))))
        }
        if let composer = textView as? ComposerTextView {
            composer.onCommandReturn = context.coordinator.submit
            composer.onHistoryPrevious = context.coordinator.historyPrevious
            composer.onHistoryNext = context.coordinator.historyNext
            composer.onFileURLsDropped = context.coordinator.fileURLsDropped
        }
        context.coordinator.parent = self
        context.coordinator.updateInsets(for: textView, in: scrollView)
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.verticalScroller = nil
        scrollView.horizontalScroller = nil
        scrollView.autohidesScrollers = false
        context.coordinator.restoreFocusIfNeeded()
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: HiddenScrollTextEditor
        weak var textView: NSTextView?
        private var observers: [NSObjectProtocol] = []
        private var wasFocusedBeforeDeactivation = false
        init(_ parent: HiddenScrollTextEditor) { self.parent = parent }

        func updateInsets(for textView: NSTextView, in scrollView: NSScrollView) {
            let lineHeight = textView.layoutManager?.defaultLineHeight(for: textView.font ?? NSFont.systemFont(ofSize: 15)) ?? 18
            // Insets describe text rhythm, not the current container height.
            // Deriving them from a previously expanded frame creates a feedback
            // loop that prevents an emptied composer from shrinking again.
            let verticalInset: CGFloat = 7
            let inset = NSSize(width: 11, height: verticalInset)
            if textView.textContainerInset != inset {
                textView.textContainerInset = inset
            }
            textView.layoutManager?.ensureLayout(for: textView.textContainer!)
            let contentHeight = max(
                lineHeight, textView.layoutManager?.usedRect(for: textView.textContainer!).height ?? lineHeight)
            let nextHeight = min(104, max(44, ceil(contentHeight + verticalInset * 2)))
            if abs(parent.measuredHeight - nextHeight) > 0.5 {
                DispatchQueue.main.async { [weak self] in self?.parent.measuredHeight = nextHeight }
            }
        }

        func installActivationObservers() {
            guard observers.isEmpty else { return }
            let center = NotificationCenter.default
            observers.append(
                center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor [weak self] in
                        guard let self, let textView = self.textView else { return }
                        self.wasFocusedBeforeDeactivation = textView.window?.firstResponder === textView
                        if self.wasFocusedBeforeDeactivation { self.parent.isFocused = true }
                    }
                })
            observers.append(
                center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor [weak self] in
                        guard let self, self.wasFocusedBeforeDeactivation, let textView = self.textView else { return }
                        guard let window = textView.window else { return }
                        window.makeFirstResponder(textView)
                        self.parent.isFocused = true
                        self.wasFocusedBeforeDeactivation = false
                        if let scrollView = textView.enclosingScrollView {
                            self.updateInsets(for: textView, in: scrollView)
                        }
                    }
                })
        }

        func textDidBeginEditing(_ notification: Notification) {
            parent.isFocused = true
            if let textView { updateInsets(for: textView, in: textView.enclosingScrollView ?? NSScrollView()) }
        }

        func textDidEndEditing(_ notification: Notification) {
            parent.isFocused = false
            if let textView { updateInsets(for: textView, in: textView.enclosingScrollView ?? NSScrollView()) }
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.text = view.string
            if let scrollView = view.enclosingScrollView { updateInsets(for: view, in: scrollView) }
        }

        /// SwiftUI may update or temporarily detach the representable when a
        /// background message sync publishes a new conversation snapshot.
        /// Composer focus belongs to the user's editing session, so restore
        /// AppKit's first responder after that layout pass while the binding
        /// still says the user is editing. Explicit clicks elsewhere first
        /// trigger `textDidEndEditing` and therefore are never overridden.
        func restoreFocusIfNeeded() {
            guard parent.isFocused, let textView else { return }
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self, self.parent.isFocused, let textView,
                    let window = textView.window, window.isKeyWindow,
                    window.firstResponder !== textView
                else { return }
                window.makeFirstResponder(textView)
            }
        }

        func submit() {
            parent.onSubmit()
        }

        func fileURLsDropped(_ urls: [URL]) {
            parent.onFileDrop(urls)
        }

        func historyPrevious() -> String? { parent.onHistoryPrevious() }
        func historyNext() -> String? { parent.onHistoryNext() }

        deinit {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
        }
    }
}

final class ComposerTextView: NSTextView {
    var onCommandReturn: (() -> Void)?
    var onHistoryPrevious: (() -> String?)?
    var onHistoryNext: (() -> String?)?
    var onFileURLsDropped: (([URL]) -> Void)?

    convenience init() {
        let textStorage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        let textContainer = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        textStorage.addLayoutManager(layoutManager)
        layoutManager.addTextContainer(textContainer)
        self.init(frame: .zero, textContainer: textContainer)
    }

    override init(frame frameRect: NSRect, textContainer container: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: container)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        registerForDraggedTypes([.fileURL])
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        fileURLs(from: sender).isEmpty ? super.draggingEntered(sender) : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = fileURLs(from: sender)
        guard !urls.isEmpty else { return super.performDragOperation(sender) }
        onFileURLsDropped?(urls)
        return true
    }

    override func keyDown(with event: NSEvent) {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.keyCode == 36 {
            if modifiers.contains(.shift) {
                super.keyDown(with: event)
                return
            }
            onCommandReturn?()
            return
        }
        let cursor = selectedRange().location
        if event.keyCode == 126, cursor == 0, let value = onHistoryPrevious?() {
            replace(with: value)
            return
        }
        if event.keyCode == 125, cursor == (string as NSString).length, let value = onHistoryNext?() {
            replace(with: value)
            return
        }
        super.keyDown(with: event)
    }

    private func replace(with value: String) {
        string = value
        setSelectedRange(NSRange(location: (value as NSString).length, length: 0))
        delegate?.textDidChange?(Notification(name: NSText.didChangeNotification, object: self))
    }

    private func fileURLs(from sender: NSDraggingInfo) -> [URL] {
        sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self], options: [:]) as? [URL] ?? []
    }
}

struct StickerPickerView: View {
    @ObservedObject var state: AppState
    let chatId: String
    let onSend: (StickerPreviewItem) -> Void

    private let columns = [GridItem(.adaptive(minimum: 64, maximum: 82), spacing: 8)]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("貼圖")
                .font(.system(size: 15, weight: .semibold))
            if !state.stickerPackages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(state.stickerPackages) { package in
                            Button(package.title.isEmpty ? package.packageId : package.title) {
                                state.loadStickerPreviews(packageId: package.packageId)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .accessibilityLabel("貼圖包 \(package.title)")
                        }
                    }
                }
            }
            if state.isLoadingStickers {
                ProgressView("載入貼圖…")
                    .frame(maxWidth: .infinity, minHeight: 120)
            } else if let error = state.stickerLoadError {
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                    Text(error).font(.system(size: 13))
                    Button("重試") { state.loadOwnedStickers() }
                }
                .frame(maxWidth: .infinity, minHeight: 120)
            } else if state.stickerPreviews.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "face.smiling")
                    Text("沒有可用貼圖").font(.system(size: 13))
                }
                .frame(maxWidth: .infinity, minHeight: 120)
            } else {
                MaterialScrollView {
                    LazyVGrid(columns: columns, spacing: 8) {
                        ForEach(state.stickerPreviews) { sticker in
                            Button {
                                onSend(sticker)
                            } label: {
                                if let data = Data(base64Encoded: sticker.data), let image = NSImage(data: data) {
                                    Image(nsImage: image)
                                        .resizable()
                                        .aspectRatio(contentMode: .fit)
                                        .frame(width: 64, height: 64)
                                } else {
                                    Image(systemName: "photo")
                                        .frame(width: 64, height: 64)
                                }
                            }
                            .buttonStyle(.plain)
                            .padding(4)
                            .clipShape(RoundedRectangle(cornerRadius: 7))
                            .accessibilityLabel("貼圖 \(sticker.stickerId)")
                        }
                    }
                }
                .frame(minHeight: 130, maxHeight: 220)
            }
        }
        .padding(14)
        .frame(width: 330)
        .onAppear {
            if state.stickerPackages.isEmpty { state.loadOwnedStickers() }
        }
    }
}
