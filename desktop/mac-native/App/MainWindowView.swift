import Cocoa
import SwiftUI

// MARK: - Enterprise Main Window Tabs & Detail Views

enum EnterpriseTheme {
    /// Shared semantic type scale. Keep UI text at or above 12pt for legibility;
    /// only system glyphs may be optically smaller.
    enum Typography {
        static let micro: CGFloat = 12
        static let caption: CGFloat = 13
        static let body: CGFloat = 14
        static let control: CGFloat = 14
        static let section: CGFloat = 16
        static let title: CGFloat = 20
        // Primary empty/loading/error states use these shared tokens. Keep
        // their hierarchy readable at the smallest supported window size.
        static let status: CGFloat = 16
        static let description: CGFloat = 14
        static let action: CGFloat = 14
        static let stateIcon: CGFloat = 38
        static let actionHitHeight: CGFloat = 40
    }
    /// Content begins below macOS' traffic-light/titlebar region. The main
    /// window uses `.fullSizeContentView`, so SwiftUI's safe-area does not
    /// reserve this space automatically. Keep this as the single source of
    /// truth for every full-size-content surface.
    enum Layout {
        static let titlebarSafeInset: CGFloat = 52
        static let titlebarContentGap: CGFloat = 10
    }
    static let sidebarWidth: CGFloat = 188
    static let conversationListWidth: CGFloat = 320
    static let contentPadding: CGFloat = 16
    static let cornerRadius: CGFloat = 8

    // Yomi's semantic palette. These are deliberately dynamic so the light
    // theme never inherits dark-mode white overlays (which read as stark
    // white cards), while dark mode keeps its own contrast and depth.
    private static func rgb(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> NSColor {
        NSColor(calibratedRed: red, green: green, blue: blue, alpha: 1)
    }

    private static func adaptive(light: NSColor, dark: NSColor) -> Color {
        Color(
            NSColor(
                name: nil,
                dynamicProvider: { appearance in
                    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
                }))
    }

    // Official Yomi brand palette (rikaidev.github.io/yomi): paper/ink and
    // restrained terracotta accent. Keep all UI accents inside these tokens.
    static let canvas = adaptive(
        light: rgb(0.949, 0.933, 0.898),  // #F2EEE5
        dark: rgb(0.090, 0.082, 0.059)  // #17150F
    )
    static let raisedSurface = adaptive(
        light: rgb(0.949, 0.933, 0.898),  // #F2EEE5 card
        dark: rgb(0.129, 0.114, 0.086)  // #211D16
    )
    static let surface = adaptive(
        light: rgb(0.918, 0.894, 0.847),  // #EAE4D8
        dark: rgb(0.129, 0.114, 0.086)  // #211D16
    )
    static let accent = adaptive(
        light: rgb(0.698, 0.227, 0.157),  // #B23A28
        dark: rgb(0.698, 0.227, 0.157)
    )
    static let attentionNow = accent
    static let attentionToday = adaptive(
        light: rgb(0.655, 0.333, 0.078),
        dark: rgb(0.855, 0.533, 0.204)
    )
    static let attentionKnow = adaptive(
        light: rgb(0.286, 0.400, 0.478),
        dark: rgb(0.482, 0.620, 0.702)
    )
    static let selected = adaptive(
        light: rgb(0.122, 0.110, 0.090),  // #1F1C17 deep
        dark: rgb(0.698, 0.227, 0.157)  // accent
    )
    // Explicit colours for content rendered on selected deep/accent rows.
    static let selectedText = adaptive(
        light: rgb(0.929, 0.906, 0.855),  // #EDE7DA on dark
        dark: rgb(0.929, 0.906, 0.855)
    )
    static let selectedSecondaryText = adaptive(
        light: rgb(0.612, 0.576, 0.510),  // #9C9382
        dark: rgb(0.929, 0.906, 0.855)
    )
    static let text = adaptive(
        light: rgb(0.122, 0.110, 0.090),  // #1F1C17
        dark: rgb(0.929, 0.906, 0.855)  // #EDE7DA
    )
    static let secondaryText = adaptive(
        light: rgb(0.337, 0.314, 0.286),  // #565049
        dark: rgb(0.655, 0.620, 0.549)  // #A79E8C
    )
    static let hairline = adaptive(
        light: rgb(0.122, 0.110, 0.090).withAlphaComponent(0.141),  // #1F1C1724
        dark: rgb(0.929, 0.906, 0.855).withAlphaComponent(0.161)  // #EDE7DA29
    )
    static let lineStrong = adaptive(
        light: rgb(0.122, 0.110, 0.090).withAlphaComponent(0.278),
        dark: rgb(0.929, 0.906, 0.855).withAlphaComponent(0.18)
    )
    static let controlFill = adaptive(
        light: rgb(0.957, 0.941, 0.906),  // #F4F0E7 highlight
        dark: rgb(0.129, 0.114, 0.086)  // #211D16
    )

}

enum YomiMainTab: String, CaseIterable, Identifiable {
    case copilot = "copilot"
    case chats = "chats"
    case integrations = "integrations"
    case settings = "settings"

    var id: String { rawValue }

    @MainActor
    func title(using i18n: I18n) -> String {
        switch self {
        case .copilot: return i18n.t("tab_copilot")
        case .chats: return i18n.t("tab_chats")
        case .integrations: return i18n.t("tab_integrations")
        case .settings: return i18n.t("tab_settings")
        }
    }

    var icon: String {
        switch self {
        case .copilot: return "sparkles"
        case .chats: return "bubble.left.and.bubble.right.fill"
        case .integrations: return "arrow.triangle.swap"
        case .settings: return "gearshape"
        }
    }
}

/// Shared macOS app-section header. The leading inset reserves the native
/// content grid while keeping the secondary-page navigation compact.
private struct YomiSectionHeader: View {
    let title: String
    let onBack: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PlainButtonStyle())

            Text(title)
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(EnterpriseTheme.text)
                .lineLimit(1)

            Spacer(minLength: 0)
        }
        .padding(.leading, 16)
        .padding(.trailing, 16)
        .frame(height: 48, alignment: .center)
        .background(EnterpriseTheme.canvas)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(EnterpriseTheme.hairline)
                .frame(height: 1)
        }
    }
}

struct YomiEnterpriseMainWindowView: View {
    @ObservedObject var state: AppState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var selectedTab: YomiMainTab = .chats
    @AppStorage("yomi_guardian_introduction_seen_v2") private var hasSeenGuardianIntroduction = false
    @State private var showsGuardianIntroduction = false
    var onOpenLogin: () -> Void

    var body: some View {
        Group {
            if selectedTab == .chats || selectedTab == .settings {
                ChatsDetailView(
                    state: state,
                    showSettings: selectedTab == .settings,
                    onCloseSettings: { selectedTab = .chats },
                    onOpenLogin: onOpenLogin,
                    onAskAboutChat: { chatName in
                        selectedTab = .copilot
                        state.sendAiQuery(prompt: "請分析並總結我與「\(chatName)」的最新對話重點與重要事項")
                    },
                    onOpenCopilot: { selectedTab = .copilot },
                    onOpenIntegrations: { selectedTab = .integrations },
                    onOpenSettings: { selectedTab = selectedTab == .settings ? .chats : .settings }
                )
                .transition(.opacity.combined(with: .offset(x: -8)))
            } else {
                VStack(spacing: 0) {
                    if selectedTab != .settings {
                        YomiSectionHeader(
                            title: selectedTab.title(using: state.i18n),
                            onBack: { selectedTab = .chats }
                        )
                    }
                    switch selectedTab {
                    case .copilot: CopilotDetailView(state: state)
                    case .integrations: IntegrationsDetailView(state: state)
                    case .settings: EmptyView()
                    case .chats: EmptyView()
                    }
                }
                .transition(.opacity.combined(with: .offset(x: 8)))
            }
        }
        .animation(MaterialMotion.emphasized(reduceMotion: reduceMotion), value: selectedTab)
        .frame(minWidth: 840, idealWidth: 1100, maxWidth: .infinity, minHeight: 560, idealHeight: 720, maxHeight: .infinity)
        .background(EnterpriseTheme.canvas)
        .preferredColorScheme(state.appearance.colorScheme)
        .edgesIgnoringSafeArea(.all)
        .onAppear {
            guard !hasSeenGuardianIntroduction else { return }
            DispatchQueue.main.async { showsGuardianIntroduction = true }
        }
        .sheet(isPresented: $showsGuardianIntroduction) {
            GuardianIntroductionView {
                hasSeenGuardianIntroduction = true
                showsGuardianIntroduction = false
            }
        }
    }
}

// MARK: - Subviews for Enterprise Window

struct CopilotDetailView: View {
    @ObservedObject var state: AppState
    @State private var inputPrompt: String = ""
    @State private var promptHistory: [String] = []
    @State private var promptHistoryIndex: Int?
    @State private var draftBeforeHistory = ""
    @AppStorage("yomi_prompt_history_v1") private var storedPromptHistory = "[]"

    var body: some View {
        VStack(spacing: 0) {
            // Clean Top Bar (Single minimalist Model Selector & Toolbar)
            HStack(spacing: 8) {
                Menu {
                    ForEach(AiProviderType.allCases) { prov in
                        Button(action: {
                            var newConfig = state.aiConfig
                            newConfig.selectedProvider = prov
                            state.updateAiConfig(newConfig)
                        }) {
                            HStack {
                                Text(prov.rawValue)
                                if state.aiConfig.selectedProvider == prov {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text(state.aiConfig.selectedProvider == .autoDetect ? "自動選擇可用的本機 AI" : state.aiConfig.selectedProvider.displayName)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(.primary)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundColor(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Color.white.opacity(0.06))
                    .cornerRadius(6)
                }
                .buttonStyle(PlainButtonStyle())

                Spacer()

                HStack(spacing: 4) {
                    Button(action: {
                        state.isSpotlightPinned.toggle()
                    }) {
                        Image(systemName: state.isSpotlightPinned ? "pin.fill" : "pin")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundColor(state.isSpotlightPinned ? EnterpriseTheme.accent : .secondary)
                            .padding(6)
                            .background(state.isSpotlightPinned ? EnterpriseTheme.accent.opacity(0.15) : Color.clear)
                            .cornerRadius(6)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .help(state.i18n.t("pin_tooltip"))

                    Button(action: {
                        withAnimation(.spring()) {
                            state.chatMessages.removeAll()
                        }
                    }) {
                        Image(systemName: "trash")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundColor(.secondary)
                            .padding(6)
                            .cornerRadius(6)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .help(state.i18n.t("clear_tooltip"))

                    Button(action: {
                        withAnimation(.spring()) {
                            state.isShowingAiSettings.toggle()
                        }
                    }) {
                        Image(systemName: "gearshape")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(state.isShowingAiSettings ? EnterpriseTheme.accent : .secondary)
                            .padding(6)
                            .cornerRadius(6)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .help(state.i18n.t("settings_tooltip"))
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider().opacity(0.3)

            if state.isShowingAiSettings {
                VStack(spacing: 8) {
                    LocalAiEngineSelectorView(state: state)
                    Button("完成") {
                        withAnimation {
                            state.isShowingAiSettings = false
                        }
                    }
                    .buttonStyle(PlainButtonStyle())
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 4)
                    .background(EnterpriseTheme.accent)
                    .clipShape(Capsule())
                }
                .padding(10)
                .transition(.move(edge: .top).combined(with: .opacity))
                Divider().opacity(0.3)
            }

            HStack(spacing: 8) {
                Circle().fill(state.isAiThinking ? EnterpriseTheme.accent : .green).frame(width: 7, height: 7)
                Text("Yomi：\(state.codexStatus)")
                    .font(.system(size: 11, weight: .medium)).foregroundColor(.secondary)
                Spacer()
                if state.isAiThinking {
                    Button("取消") { state.cancelCodexAgent() }
                        .buttonStyle(.plain).foregroundColor(EnterpriseTheme.accent)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 7)
            if let approval = state.codexApprovalRequest {
                AgentApprovalView(request: approval) { decision in
                    state.respondToCodexApproval(decision: decision)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            if let elicitation = state.codexElicitationRequest {
                AgentElicitationView(request: elicitation) { action, content in
                    state.respondToCodexElicitation(action: action, content: content)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }

            // Chat Stream
            ScrollViewReader { proxy in
                // Keep the AI transcript scrollable while presenting a clean,
                // web-like surface. The indicator is intentionally hidden;
                // wheel, trackpad, keyboard and VoiceOver scrolling remain.
                MaterialScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if state.chatMessages.isEmpty {
                            VStack(spacing: 12) {
                                YomiGuardiansMark(mode: .yomi, size: 52)
                                    .padding(.top, 32)

                                Text(state.i18n.t("copilot_intro_title"))
                                    .font(.system(size: 16, weight: .bold))
                                    .foregroundColor(.primary)

                                Text(state.i18n.t("copilot_intro_desc"))
                                    .font(.system(size: 13))
                                    .foregroundColor(.secondary)

                                // Quick Prompt Chips (Minimalist design)
                                HStack(spacing: 8) {
                                    PromptChip(title: state.i18n.t("quick_summary")) {
                                        inputPrompt = state.i18n.t("quick_summary")
                                        submitQuery()
                                    }
                                    PromptChip(title: state.i18n.t("quick_contacts")) {
                                        inputPrompt = state.i18n.t("quick_contacts")
                                        submitQuery()
                                    }
                                    PromptChip(title: state.i18n.t("quick_latest")) {
                                        inputPrompt = state.i18n.t("quick_latest")
                                        submitQuery()
                                    }
                                }
                                .padding(.top, 8)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 30)
                        } else {
                            ForEach(state.chatMessages) { msg in
                                if msg.isUser {
                                    HStack {
                                        Spacer()
                                        Text(msg.text)
                                            .font(.system(size: 13))
                                            .foregroundColor(.white)
                                            .textSelection(.enabled)
                                            .padding(.horizontal, 12)
                                            .padding(.vertical, 8)
                                            .background(EnterpriseTheme.accent)
                                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    }
                                } else {
                                    VStack(alignment: .leading, spacing: 6) {
                                        HStack {
                                            if msg.toolCall != nil {
                                                HStack(spacing: 6) {
                                                    Image(systemName: "wrench.and.screwdriver.fill")
                                                        .font(.system(size: 10))
                                                        .foregroundColor(EnterpriseTheme.accent)
                                                    Text("Yomi 執行紀錄")
                                                        .font(.system(size: 10.5, design: .monospaced))
                                                        .foregroundColor(.secondary)
                                                }
                                                .padding(.horizontal, 8)
                                                .padding(.vertical, 3)
                                                .background(EnterpriseTheme.accent.opacity(0.1))
                                                .clipShape(Capsule())
                                            }

                                            Spacer()

                                            Button(action: {
                                                NSPasteboard.general.clearContents()
                                                NSPasteboard.general.setString(msg.text, forType: .string)
                                                state.sendNotification(title: "Yomi Copilot", body: state.i18n.t("copy_clipboard"))
                                            }) {
                                                HStack(spacing: 4) {
                                                    Image(systemName: "doc.on.doc")
                                                        .font(.system(size: 11))
                                                    Text("複製")
                                                        .font(.system(size: 10.5))
                                                }
                                                .foregroundColor(.secondary)
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2.5)
                                                .background(Color.white.opacity(0.06))
                                                .clipShape(RoundedRectangle(cornerRadius: 5))
                                            }
                                            .buttonStyle(PlainButtonStyle())
                                        }

                                        Text(msg.text)
                                            .font(.system(size: 13))
                                            .foregroundColor(.primary)
                                            .lineSpacing(3)
                                            .textSelection(.enabled)
                                            .padding(.horizontal, 12)
                                            .padding(.vertical, 8)
                                            .background(Color.white.opacity(0.06))
                                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }

                            if state.isAiThinking {
                                HStack(spacing: 8) {
                                    ProgressView()
                                        .scaleEffect(0.8)
                                    Text("Yomi 正在整理結果…")
                                        .font(.system(size: 12))
                                        .foregroundColor(.secondary)
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                            }
                        }
                    }
                    .padding(18)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            Divider().opacity(0.3)

            // Prompt Input Dock
            HStack(spacing: 10) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: 14))
                    .foregroundColor(EnterpriseTheme.accent)

                FocusableTextField(
                    placeholder: state.i18n.t("ask_placeholder"),
                    text: $inputPrompt,
                    onSubmit: {
                        submitQuery()
                    },
                    onHistoryPrevious: previousPrompt,
                    onHistoryNext: nextPrompt
                )
                .frame(height: 24)

                Button(action: {
                    submitQuery()
                }) {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 22))
                        .foregroundColor(
                            inputPrompt.trimmingCharacters(in: .whitespaces).isEmpty ? .secondary.opacity(0.4) : EnterpriseTheme.accent)
                }
                .buttonStyle(PlainButtonStyle())
                .disabled(inputPrompt.trimmingCharacters(in: .whitespaces).isEmpty || state.isAiThinking)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color(NSColor.controlBackgroundColor).opacity(0.55))
        }
        .onAppear { loadPromptHistory() }
    }

    private func submitQuery() {
        let text = inputPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        rememberPrompt(text)
        inputPrompt = ""
        promptHistoryIndex = nil
        draftBeforeHistory = ""
        state.sendAiQuery(prompt: text)
    }

    private func previousPrompt() -> String? {
        guard !promptHistory.isEmpty else { return nil }
        if let index = promptHistoryIndex {
            promptHistoryIndex = max(0, index - 1)
        } else {
            draftBeforeHistory = inputPrompt
            promptHistoryIndex = promptHistory.count - 1
        }
        return promptHistoryIndex.map { promptHistory[$0] }
    }

    private func nextPrompt() -> String? {
        guard let index = promptHistoryIndex else { return nil }
        if index < promptHistory.count - 1 {
            let nextIndex = index + 1
            promptHistoryIndex = nextIndex
            return promptHistory[nextIndex]
        }
        promptHistoryIndex = nil
        return draftBeforeHistory
    }

    private func rememberPrompt(_ prompt: String) {
        promptHistory.removeAll { $0 == prompt }
        promptHistory.append(prompt)
        promptHistory = Array(promptHistory.suffix(50))
        if let data = try? JSONEncoder().encode(promptHistory), let encoded = String(data: data, encoding: .utf8) {
            storedPromptHistory = encoded
        }
    }

    private func loadPromptHistory() {
        guard promptHistory.isEmpty, let data = storedPromptHistory.data(using: .utf8),
            let decoded = try? JSONDecoder().decode([String].self, from: data)
        else { return }
        promptHistory = Array(decoded.suffix(50))
    }
}

struct SidebarTabButton: View {
    let tab: YomiMainTab
    let isSelected: Bool
    let hasUnread: Bool
    let title: String
    let action: () -> Void
    @State private var isHovered: Bool = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: tab.icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(isSelected ? EnterpriseTheme.accent : .secondary)
                    .frame(width: 18)

                Text(title)
                    .font(.system(size: 12.5, weight: isSelected ? .semibold : .regular))
                    .foregroundColor(isSelected ? .primary : .secondary)

                Spacer()

                if hasUnread {
                    Circle()
                        .fill(EnterpriseTheme.accent)
                        .frame(width: 6, height: 6)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 38)
            .frame(maxWidth: .infinity, alignment: .leading)
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
    }
}
