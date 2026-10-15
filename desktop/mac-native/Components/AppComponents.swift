import Cocoa
import SwiftUI

enum MaterialMotion {
    static func quick(reduceMotion: Bool) -> Animation {
        reduceMotion ? .linear(duration: 0.01) : .easeOut(duration: 0.16)
    }

    static func standard(reduceMotion: Bool) -> Animation {
        reduceMotion ? .linear(duration: 0.01) : .spring(response: 0.28, dampingFraction: 0.86)
    }

    static func emphasized(reduceMotion: Bool) -> Animation {
        reduceMotion ? .linear(duration: 0.01) : .spring(response: 0.36, dampingFraction: 0.88)
    }
}

private struct MaterialScrollOffsetKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct MaterialScrollContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct MaterialScrollView<Content: View>: View {
    private let content: Content
    private let pinsToBottom: Bool
    private let coordinateSpace = UUID()
    private let bottomID = UUID()
    @State private var offset: CGFloat = 0
    @State private var contentHeight: CGFloat = 0
    @State private var indicatorVisible = false
    @State private var pinnedToBottom = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(pinsToBottom: Bool = false, @ViewBuilder content: () -> Content) {
        self.pinsToBottom = pinsToBottom
        self.content = content()
    }

    var body: some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 0) {
                        content
                        Color.clear.frame(height: 1).id(bottomID)
                    }
                    .background(
                        GeometryReader { geometry in
                            Color.clear
                                .preference(
                                    key: MaterialScrollOffsetKey.self,
                                    value: geometry.frame(in: .named(coordinateSpace)).minY
                                )
                                .preference(
                                    key: MaterialScrollContentHeightKey.self,
                                    value: geometry.size.height
                                )
                        })
                }
                .coordinateSpace(name: coordinateSpace)
                .onPreferenceChange(MaterialScrollOffsetKey.self) { value in
                    offset = value
                    if pinsToBottom {
                        pinnedToBottom = -value + viewport.size.height >= contentHeight - 24
                    }
                }
                .onPreferenceChange(MaterialScrollContentHeightKey.self) { nextHeight in
                    let shouldPin = pinsToBottom && pinnedToBottom && nextHeight > contentHeight
                    contentHeight = nextHeight
                    if shouldPin {
                        DispatchQueue.main.async { proxy.scrollTo(bottomID, anchor: .bottom) }
                    }
                }
                .onAppear {
                    if pinsToBottom {
                        DispatchQueue.main.async { proxy.scrollTo(bottomID, anchor: .bottom) }
                    }
                }
                .background(ScrollWheelActivityMonitor(isScrolling: $indicatorVisible))
                .overlay(alignment: .topTrailing) {
                    indicator(viewportHeight: viewport.size.height)
                }
            }
        }
    }

    @ViewBuilder
    private func indicator(viewportHeight: CGFloat) -> some View {
        if contentHeight > viewportHeight + 1 {
            let availableHeight = max(1, viewportHeight - 8)
            let thumbHeight = max(24, availableHeight * min(1, viewportHeight / contentHeight))
            let travel = max(0, availableHeight - thumbHeight)
            let scrollable = max(1, contentHeight - viewportHeight)
            let progress = min(1, max(0, -offset / scrollable))
            Capsule()
                .fill(Color.secondary.opacity(0.58))
                .frame(width: 3, height: thumbHeight)
                .offset(x: -3, y: 4 + travel * progress)
                .opacity(indicatorVisible ? 1 : 0)
                .animation(MaterialMotion.quick(reduceMotion: reduceMotion), value: indicatorVisible)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

}

private struct ScrollWheelActivityMonitor: NSViewRepresentable {
    @Binding var isScrolling: Bool

    func makeCoordinator() -> Coordinator { Coordinator(isScrolling: $isScrolling) }

    func makeNSView(context: Context) -> ProbeView {
        let view = ProbeView()
        context.coordinator.probe = view
        context.coordinator.start()
        return view
    }

    func updateNSView(_ nsView: ProbeView, context: Context) {
        context.coordinator.isScrolling = $isScrolling
    }

    final class ProbeView: NSView {}

    @MainActor
    final class Coordinator: NSObject {
        var isScrolling: Binding<Bool>
        weak var probe: ProbeView?
        private var monitor: Any?

        init(isScrolling: Binding<Bool>) {
            self.isScrolling = isScrolling
        }

        func start() {
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                guard let self, let probe = self.probe, event.window === probe.window else { return event }
                let point = probe.convert(event.locationInWindow, from: nil)
                guard probe.bounds.contains(point) else { return event }
                self.show()
                return event
            }
        }

        private func show() {
            NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(hide), object: nil)
            withAnimation(.easeOut(duration: 0.12)) { isScrolling.wrappedValue = true }
            perform(#selector(hide), with: nil, afterDelay: 0.7)
        }

        @objc private func hide() {
            withAnimation(.easeOut(duration: 0.2)) { isScrolling.wrappedValue = false }
        }

        deinit {
            if let monitor { NSEvent.removeMonitor(monitor) }
        }
    }
}

// MARK: - User Profile Avatar Component

struct UserAvatarView: View {
    let pictureUrl: String
    let displayName: String
    let mid: String

    var body: some View {
        CachedAvatarView(
            pictureUrl: pictureUrl,
            title: displayName,
            mid: mid,
            size: 38
        )
    }
}

// MARK: - SwiftUI Popover UI (Right-Click Menu)

struct PopoverContentView: View {
    @ObservedObject var state: AppState
    @ObservedObject private var updater = DesktopUpdateManager.shared
    var onOpenLoginWindow: () -> Void
    var onOpenIntegrationWindow: () -> Void
    var onOpenChatSpotlight: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // 1. Header (Brand + E2EE Status Indicator + Refresh)
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Yomi")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(.primary)

                    HStack(spacing: 5) {
                        Circle()
                            .fill(
                                state.isConnected
                                    ? (state.hasUnreadAttention ? EnterpriseTheme.accent : Color.green) : Color.secondary.opacity(0.6)
                            )
                            .frame(width: 6.5, height: 6.5)

                        Text(
                            state.isConnected
                                ? (state.isSyncing
                                    ? state.i18n.t("syncing_status")
                                    : (state.hasUnreadAttention
                                        ? state.i18n.t("popover_attention_title")
                                        : state.i18n.t("e2ee_protected")))
                                : state.i18n.t("not_connected")
                        )
                        .font(.system(size: 11.5))
                        .foregroundColor(state.hasUnreadAttention ? EnterpriseTheme.accent : .secondary)
                    }
                }

                Spacer()

                Button(action: {
                    state.syncNow()
                }) {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(.secondary)
                        .rotationEffect(.degrees(state.isSyncing ? 360 : 0))
                        .animation(
                            state.isSyncing ? Animation.linear(duration: 0.8).repeatForever(autoreverses: false) : .default,
                            value: state.isSyncing
                        )
                        .padding(6)
                        .background(Color.white.opacity(0.06))
                        .clipShape(Circle())
                }
                .buttonStyle(PlainButtonStyle())
                .help(state.i18n.t("refresh"))
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 10)

            // 2. Account Status Card (Connected vs Unauthenticated)
            if state.isConnected {
                Button(action: {
                    state.copyMidToClipboard()
                }) {
                    HStack(spacing: 11) {
                        UserAvatarView(
                            pictureUrl: state.pictureUrl,
                            displayName: state.displayName,
                            mid: state.mid
                        )

                        VStack(alignment: .leading, spacing: 2.5) {
                            HStack(spacing: 5) {
                                Text(state.displayName.isEmpty ? "LINE User" : state.displayName)
                                    .font(.system(size: 13.5, weight: .bold))
                                    .foregroundColor(.primary)
                                    .lineLimit(1)

                                Image(systemName: "checkmark.seal.fill")
                                    .font(.system(size: 11))
                                    .foregroundColor(.green)
                            }

                            Text("MID: \(state.mid)")
                                .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                                .foregroundColor(.secondary)
                                .lineLimit(1)
                        }

                        Spacer()

                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(Color(NSColor.tertiaryLabelColor))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(PlainHoverButtonStyle())
                .padding(.horizontal, 6)
                .padding(.bottom, 6)
            } else {
                Button(action: {
                    onOpenLoginWindow()
                }) {
                    HStack(spacing: 11) {
                        ZStack {
                            Circle()
                                .fill(EnterpriseTheme.accent.opacity(0.18))
                                .frame(width: 36, height: 36)
                            Image(systemName: "shield.lefthalf.filled")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundColor(EnterpriseTheme.accent)
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            Text(state.i18n.t("connect_line"))
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(EnterpriseTheme.accent)
                            Text(state.i18n.t("click_to_signin"))
                                .font(.system(size: 11.5))
                                .foregroundColor(.secondary)
                        }

                        Spacer()

                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(EnterpriseTheme.accent)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 7)
                    .background(EnterpriseTheme.accent.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                }
                .buttonStyle(PlainHoverButtonStyle())
                .padding(.horizontal, 6)
                .padding(.bottom, 6)
            }

            // 2.5 Attention Alert Banner (if any)
            if state.hasUnreadAttention {
                HStack(spacing: 9) {
                    Circle()
                        .fill(EnterpriseTheme.accent)
                        .frame(width: 8, height: 8)

                    VStack(alignment: .leading, spacing: 1) {
                        Text(state.i18n.t("popover_attention_title"))
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(.primary)
                        Text(state.i18n.t("popover_attention_desc"))
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    }

                    Spacer()

                    Button(action: {
                        state.clearAttentionAlert()
                    }) {
                        Text(state.i18n.t("popover_dismiss"))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(EnterpriseTheme.accent)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(EnterpriseTheme.accent.opacity(0.12))
                            .clipShape(Capsule())
                    }
                    .buttonStyle(PlainButtonStyle())
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(EnterpriseTheme.accent.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .padding(.horizontal, 6)
                .padding(.bottom, 4)
            }

            Divider()
                .padding(.horizontal, 12)
                .padding(.vertical, 4)

            // 3. High-frequency actions only. Configuration and account
            // management live in the full workspace.
            VStack(spacing: 1) {
                ActionRow(title: state.i18n.t("popover_open_yomi"), icon: "macwindow", shortcut: "⌘ O", hasChevron: true) {
                    state.openWorkspace()
                }

                ActionRow(title: state.i18n.t("popover_sync_now"), icon: "arrow.clockwise", shortcut: "⌘ R", hasChevron: false) {
                    state.syncNow()
                }

                Menu {
                    ForEach(AppLanguage.allCases) { language in
                        Button {
                            state.i18n.currentLanguage = language
                        } label: {
                            if language == state.i18n.currentLanguage {
                                Label(language.displayName, systemImage: "checkmark")
                            } else {
                                Text(language.displayName)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "globe").frame(width: 18)
                        Text(state.i18n.t("settings_language"))
                        Spacer()
                        Text(state.i18n.currentLanguage.displayName)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.secondary)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 34)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 6)

            Divider()
                .padding(.horizontal, 12)
                .padding(.vertical, 4)

            // 4. Update and lifecycle
            VStack(spacing: 1) {
                ActionRow(
                    title: updater.availableVersion == nil
                        ? state.i18n.t("updates_check")
                        : state.i18n.t("updates_download"),
                    icon: "arrow.down.circle",
                    tag: updater.availableVersion,
                    hasChevron: updater.availableVersion != nil
                ) {
                    updater.openAvailableUpdate()
                }

                ActionRow(title: state.i18n.t("menu_quit"), icon: "power", shortcut: "⌘ Q", hasChevron: false) {
                    NSApp.terminate(nil)
                }
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 10)
        }
        .frame(width: 320)
        .background(
            ZStack {
                VisualEffectBackground()
                RoundedRectangle(cornerRadius: 14)
                    .stroke(Color.white.opacity(0.15), lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 14))
        )
        .padding(6)
    }
}

// MARK: - Components

struct ActionRow: View {
    let title: String
    let icon: String
    var shortcut: String? = nil
    var tag: String? = nil
    var hasChevron: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: icon)
                    .font(.system(size: 12.5))
                    .foregroundColor(.primary)
                    .frame(width: 16)

                Text(title)
                    .font(.system(size: 12.5))
                    .foregroundColor(.primary)

                Spacer()

                if let tag = tag {
                    Text(tag)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(
                            tag == "Spotlight" ? EnterpriseTheme.accent : (tag == "Primary" ? Color.green : EnterpriseTheme.accent)
                        )
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1.5)
                        .background(
                            (tag == "Spotlight" ? EnterpriseTheme.accent : (tag == "Primary" ? Color.green : EnterpriseTheme.accent))
                                .opacity(0.15)
                        )
                        .clipShape(Capsule())
                } else if let sc = shortcut {
                    Text(sc)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(Color(NSColor.tertiaryLabelColor))
                } else if hasChevron {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(Color(NSColor.tertiaryLabelColor))
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(PlainHoverButtonStyle())
    }
}

struct PlainHoverButtonStyle: ButtonStyle {
    @State private var isHovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(
                        configuration.isPressed
                            ? Color(NSColor.selectedContentBackgroundColor).opacity(0.4)
                            : (isHovered ? EnterpriseTheme.accent.opacity(0.12) : Color.clear))
            )
            .onHover { isHovered = $0 }
    }
}

struct VisualEffectBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .popover
    var blendingMode: NSVisualEffectView.BlendingMode = .behindWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blendingMode
        view.state = .active
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

// MARK: - Native Dynamic Status Icon Generator (Official Yomi Logo)

func createStatusIcon(hasUnread: Bool = false) -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let image = NSImage(size: size, flipped: false) { rect in
        let strokeColor = NSColor.labelColor
        strokeColor.setStroke()

        // Left chevron: (30, 24) -> (48, 50) -> (30, 76) mapped to 18x18
        let leftPath = NSBezierPath()
        leftPath.lineWidth = 1.7
        leftPath.lineCapStyle = .round
        leftPath.lineJoinStyle = .round
        leftPath.move(to: NSPoint(x: 5.2, y: 14.0))
        leftPath.line(to: NSPoint(x: 8.3, y: 9.0))
        leftPath.line(to: NSPoint(x: 5.2, y: 4.0))
        leftPath.stroke()

        // Right chevron: (70, 24) -> (52, 50) -> (70, 76) mapped to 18x18
        let rightPath = NSBezierPath()
        rightPath.lineWidth = 1.7
        rightPath.lineCapStyle = .round
        rightPath.lineJoinStyle = .round
        rightPath.move(to: NSPoint(x: 12.8, y: 14.0))
        rightPath.line(to: NSPoint(x: 9.7, y: 9.0))
        rightPath.line(to: NSPoint(x: 12.8, y: 4.0))
        rightPath.stroke()

        // Signature Yomi accent center dot (#B23A28).
        let dotRect = NSRect(x: 7.6, y: 7.6, width: 2.8, height: 2.8)
        let dotPath = NSBezierPath(ovalIn: dotRect)
        NSColor(red: 178 / 255, green: 58 / 255, blue: 40 / 255, alpha: 1.0).setFill()
        dotPath.fill()

        if hasUnread {
            let unreadRect = NSRect(x: 12.5, y: 12.5, width: 4.5, height: 4.5)
            let unreadPath = NSBezierPath(ovalIn: unreadRect)
            NSColor(red: 178 / 255, green: 58 / 255, blue: 40 / 255, alpha: 1.0).setFill()
            unreadPath.fill()

            unreadPath.lineWidth = 0.8
            NSColor.white.setStroke()
            unreadPath.stroke()
        }

        return true
    }
    image.isTemplate = false
    return image
}
