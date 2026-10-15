import Cocoa
import SwiftUI

// MARK: - Split-Pane Attention-First Chats Detail View

struct ChatsDetailView: View {
    @ObservedObject var state: AppState
    @Environment(\.colorScheme) private var effectiveColorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let showSettings: Bool
    var onCloseSettings: () -> Void
    var onOpenLogin: () -> Void
    var onAskAboutChat: (String) -> Void
    var onOpenCopilot: () -> Void
    var onOpenIntegrations: () -> Void
    var onOpenSettings: () -> Void
    @State private var conversationSearch = ""
    @State private var searchMatchIndex = 0

    var attentionChats: [LineChatItem] {
        let unresolvedChatIDs = Set(
            state.ambientObservationSnapshot?.candidates
                .filter { $0.responseState != "received" }
                .map(\.chatId) ?? [])
        return state.chats.filter { item in
            !YomiAttentionPolicyStore.isMuted(item.id)
                && (item.needsAttention || unresolvedChatIDs.contains(item.id))
        }
    }

    private var normalizedSearchQuery: String {
        conversationSearch.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var searchMatches: [LineChatItem] {
        guard !normalizedSearchQuery.isEmpty else { return [] }
        return state.chats.filter { item in
            searchTextMatches(value: item.title, query: normalizedSearchQuery)
                || searchTextMatches(
                    value: localizedDesktopMessagePreview(
                        sanitizeDesktopMessagePreview(item.lastMessage), using: state.i18n),
                    query: normalizedSearchQuery)
        }
    }

    var displayedChats: [LineChatItem] {
        if !normalizedSearchQuery.isEmpty {
            return searchMatches
        }
        if state.showAttentionOnly {
            return attentionChats
        }
        let priorityIds = Set(attentionChats.map(\.id))
        return attentionChats + state.chats.filter { !priorityIds.contains($0.id) }
    }

    var selectedChat: LineChatItem? {
        if let id = state.selectedChatId {
            return state.chats.first(where: { $0.id == id })
        }
        return nil
    }

    private var syncTooltip: String {
        if state.isSyncing { return state.i18n.t("syncing_status") }
        if state.syncError != nil { return state.i18n.t("sync_failed") }
        if !state.lastSyncTimeString.isEmpty { return "\(state.i18n.t("synced_at")) \(state.lastSyncTimeString)" }
        return state.i18n.t("refresh")
    }

    var body: some View {
        HStack(spacing: 0) {
            if let work = state.activeWorkContext {
                WorkModeView(state: state, work: work)
            } else {
                // Left Column: Chat List (Attention First)
                VStack(spacing: 0) {
                    // Header & Filter Toggle
                    VStack(spacing: 8) {
                        // Attention vs All Filter Pills
                        HStack(spacing: 6) {
                            Button(action: {
                                withAnimation(MaterialMotion.standard(reduceMotion: reduceMotion)) {
                                    if state.showAttentionOnly && state.selectedChatId != nil {
                                        state.selectedChatId = nil
                                    } else {
                                        state.showAttentionOnly = true
                                        state.selectedChatId = nil
                                    }
                                }
                            }) {
                                HStack(spacing: 4) {
                                    Image(systemName: "bolt.fill")
                                        .font(.system(size: 12))
                                    Text(state.i18n.t("attention_only"))
                                        .font(.system(size: 13, weight: state.showAttentionOnly ? .bold : .medium))
                                        .lineLimit(1)
                                    if !attentionChats.isEmpty {
                                        Text("\(attentionChats.count)")
                                            .font(.system(size: 11, weight: .bold))
                                            .foregroundColor(
                                                state.showAttentionOnly ? EnterpriseTheme.selectedText : EnterpriseTheme.accent
                                            )
                                            .padding(.horizontal, 5)
                                            .padding(.vertical, 1)
                                            .background(
                                                state.showAttentionOnly ? EnterpriseTheme.accent : EnterpriseTheme.accent.opacity(0.18)
                                            )
                                            .clipShape(Capsule())
                                    }
                                }
                                .frame(maxWidth: .infinity)
                                .frame(height: 40)
                                .background(state.showAttentionOnly ? EnterpriseTheme.selected : EnterpriseTheme.raisedSurface)
                                .foregroundColor(state.showAttentionOnly ? EnterpriseTheme.selectedText : EnterpriseTheme.secondaryText)
                                .cornerRadius(7)
                            }
                            .buttonStyle(PlainButtonStyle())

                            Button(action: {
                                withAnimation(MaterialMotion.standard(reduceMotion: reduceMotion)) {
                                    if !state.showAttentionOnly && state.selectedChatId != nil {
                                        state.selectedChatId = nil
                                    } else {
                                        state.showAttentionOnly = false
                                    }
                                }
                            }) {
                                HStack(spacing: 4) {
                                    Image(systemName: "bubble.left.and.bubble.right")
                                        .font(.system(size: 12))
                                    Text(state.i18n.t("all_chats"))
                                        .font(.system(size: 13, weight: !state.showAttentionOnly ? .bold : .medium))
                                        .lineLimit(1)
                                }
                                .frame(maxWidth: .infinity)
                                .frame(height: 40)
                                .background(!state.showAttentionOnly ? EnterpriseTheme.selected : EnterpriseTheme.raisedSurface)
                                .foregroundColor(!state.showAttentionOnly ? EnterpriseTheme.selectedText : EnterpriseTheme.secondaryText)
                                .cornerRadius(7)
                            }
                            .buttonStyle(PlainButtonStyle())
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .padding(.bottom, 10)

                    HStack(spacing: 7) {
                        Image(systemName: "magnifyingglass")
                            .foregroundColor(.secondary)
                        TextField(state.i18n.t("search_conversations"), text: $conversationSearch)
                            .textFieldStyle(.plain)
                            .font(.system(size: 14))
                            .onSubmit { moveSearchMatch(1) }
                            .accessibilityLabel(state.i18n.t("search_conversations"))
                        if !conversationSearch.isEmpty {
                            Button {
                                conversationSearch = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundColor(.secondary)
                            }
                            .buttonStyle(.plain)
                            .help(state.i18n.t("clear_search"))
                            .accessibilityLabel(state.i18n.t("clear_search"))
                        }
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 34)
                    .background(EnterpriseTheme.raisedSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)

                    if !conversationSearch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        HStack(spacing: 6) {
                            Text(
                                searchMatches.isEmpty
                                    ? state.i18n.t("no_search_results")
                                    : "\(min(searchMatchIndex + 1, searchMatches.count))/\(searchMatches.count)"
                            )
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(.secondary)
                            .accessibilityLabel(
                                Text(
                                    searchMatches.isEmpty
                                        ? state.i18n.t("no_search_results")
                                        : "搜尋結果第 \(min(searchMatchIndex + 1, searchMatches.count)) 項，共 \(searchMatches.count) 項")
                            )
                            Spacer()
                            Button(action: { moveSearchMatch(-1) }) {
                                Image(systemName: "chevron.up")
                            }
                            .buttonStyle(.plain)
                            .disabled(searchMatches.isEmpty || searchMatchIndex == 0)
                            .accessibilityLabel(state.i18n.t("previous_search_result"))
                            Button(action: { moveSearchMatch(1) }) {
                                Image(systemName: "chevron.down")
                            }
                            .buttonStyle(.plain)
                            .disabled(searchMatches.isEmpty || searchMatchIndex >= searchMatches.count - 1)
                            .accessibilityLabel(state.i18n.t("next_search_result"))
                        }
                        .padding(.horizontal, 14)
                        .padding(.bottom, 6)
                    }

                    Divider().opacity(0.3)

                    if state.showAttentionOnly && normalizedSearchQuery.isEmpty {
                        Button {
                            withAnimation(MaterialMotion.standard(reduceMotion: reduceMotion)) {
                                state.selectedChatId = nil
                            }
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "rectangle.grid.1x2.fill")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundColor(
                                        state.selectedChatId == nil
                                            ? EnterpriseTheme.selectedText : EnterpriseTheme.accent
                                    )
                                    .frame(width: 32, height: 32)
                                    .background(
                                        state.selectedChatId == nil
                                            ? EnterpriseTheme.accent : EnterpriseTheme.accent.opacity(0.12)
                                    )
                                    .clipShape(RoundedRectangle(cornerRadius: 7))

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(state.i18n.t("briefing_today"))
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundColor(
                                            state.selectedChatId == nil
                                                ? EnterpriseTheme.selectedText : EnterpriseTheme.text)
                                    Text(
                                        String(
                                            format: state.i18n.t("briefing_attention_count"),
                                            attentionChats.count)
                                    )
                                    .font(.system(size: 11))
                                    .foregroundColor(
                                        state.selectedChatId == nil
                                            ? EnterpriseTheme.selectedSecondaryText
                                            : EnterpriseTheme.secondaryText)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundColor(
                                        state.selectedChatId == nil
                                            ? EnterpriseTheme.selectedSecondaryText : .secondary)
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 52)
                            .background(
                                state.selectedChatId == nil
                                    ? EnterpriseTheme.selected : EnterpriseTheme.raisedSurface
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 6)
                        .accessibilityLabel(Text(state.i18n.t("briefing_today")))
                        .accessibilityValue(
                            Text(
                                String(
                                    format: state.i18n.t("briefing_attention_count"),
                                    attentionChats.count)))

                        Divider().opacity(0.3)
                    }

                    // List Items or Empty Attention State
                    if let loadError = state.chatLoadError, state.chats.isEmpty {
                        VStack(spacing: 12) {
                            Spacer()
                            Image(systemName: "exclamationmark.triangle")
                                .font(.system(size: EnterpriseTheme.Typography.stateIcon, weight: .semibold))
                                .foregroundColor(EnterpriseTheme.accent)
                            Text(state.i18n.t("chat_load_failed"))
                                .font(.system(size: EnterpriseTheme.Typography.status, weight: .semibold))
                                .foregroundColor(.primary)
                            Text(loadError)
                                .font(.system(size: EnterpriseTheme.Typography.description))
                                .foregroundColor(.secondary)
                                .multilineTextAlignment(.center)
                                .lineLimit(3)
                            Button(action: {
                                if state.isConnected {
                                    state.refreshInbox(.retry)
                                } else {
                                    onOpenLogin()
                                }
                            }) {
                                HStack(spacing: 5) {
                                    Image(systemName: state.isConnected ? "arrow.clockwise" : "arrow.right.to.line.compact")
                                    Text(state.i18n.t(state.isConnected ? "retry" : "connect_line"))
                                }
                                .font(.system(size: EnterpriseTheme.Typography.action, weight: .semibold))
                                .foregroundColor(.white)
                                .padding(.horizontal, 13)
                                .frame(minHeight: EnterpriseTheme.Typography.actionHitHeight)
                                .padding(.vertical, 4)
                                .background(EnterpriseTheme.accent)
                                .cornerRadius(7)
                            }
                            .buttonStyle(PlainButtonStyle())
                            Spacer()
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity)
                    } else if !state.hasLoadedChatsOnce || (state.isLoadingChats && state.chats.isEmpty) {
                        // Keep loading content as one top-anchored group. Do not use
                        // vertical Spacers here: at the minimum window height they
                        // push the status below the visible list area.
                        VStack(spacing: 18) {
                            VStack(spacing: 10) {
                                ForEach(0..<3, id: \.self) { index in
                                    HStack(spacing: 10) {
                                        Circle()
                                            .fill(EnterpriseTheme.secondaryText.opacity(0.16))
                                            .frame(width: 42, height: 42)
                                        VStack(alignment: .leading, spacing: 7) {
                                            RoundedRectangle(cornerRadius: 4)
                                                .fill(EnterpriseTheme.secondaryText.opacity(0.16))
                                                .frame(width: index == 1 ? 132 : 172, height: 12)
                                            RoundedRectangle(cornerRadius: 4)
                                                .fill(EnterpriseTheme.secondaryText.opacity(0.11))
                                                .frame(width: index == 2 ? 96 : 146, height: 9)
                                        }
                                        Spacer(minLength: 0)
                                    }
                                    .frame(height: 54)
                                }
                            }
                            .accessibilityHidden(true)

                            VStack(spacing: 10) {
                                ProgressView()
                                    .controlSize(.small)
                                Text(state.isConnected ? state.i18n.t("loading_chats") : state.i18n.t("not_connected"))
                                    .font(.system(size: EnterpriseTheme.Typography.status, weight: .semibold))
                                    .foregroundColor(EnterpriseTheme.secondaryText)
                                    .multilineTextAlignment(.center)
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel(Text(state.isConnected ? state.i18n.t("loading_chats") : state.i18n.t("not_connected")))
                        }
                        .padding(.horizontal, 12)
                        .padding(.top, 28)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    } else if state.showAttentionOnly && attentionChats.isEmpty && conversationSearch.isEmpty {
                        VStack(spacing: 12) {
                            Spacer()
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: EnterpriseTheme.Typography.stateIcon))
                                .foregroundColor(.green.opacity(0.85))

                            VStack(spacing: 4) {
                                Text(state.i18n.t("all_caught_up"))
                                    .font(.system(size: EnterpriseTheme.Typography.status, weight: .semibold))
                                    .foregroundColor(.primary)
                                Text(state.i18n.t("all_caught_up_sub"))
                                    .font(.system(size: EnterpriseTheme.Typography.description))
                                    .foregroundColor(.secondary)
                            }

                            Button(action: {
                                withAnimation(MaterialMotion.standard(reduceMotion: reduceMotion)) {
                                    state.showAttentionOnly = false
                                }
                            }) {
                                Text(state.i18n.t("show_all_chats"))
                                    .font(.system(size: EnterpriseTheme.Typography.action, weight: .semibold))
                                    .foregroundColor(EnterpriseTheme.accent)
                                    .padding(.horizontal, 12)
                                    .frame(minHeight: EnterpriseTheme.Typography.actionHitHeight)
                                    .padding(.vertical, 4)
                                    .background(EnterpriseTheme.accent.opacity(0.12))
                                    .cornerRadius(6)
                            }
                            .buttonStyle(PlainButtonStyle())

                            Spacer()
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity)
                    } else if displayedChats.isEmpty {
                        VStack(spacing: 10) {
                            Spacer()
                            Image(systemName: "tray")
                                .font(.system(size: EnterpriseTheme.Typography.stateIcon))
                                .foregroundColor(.secondary.opacity(0.5))
                            Text(conversationSearch.isEmpty ? state.i18n.t("no_messages") : state.i18n.t("no_search_results"))
                                .font(.system(size: EnterpriseTheme.Typography.status, weight: .semibold))
                                .foregroundColor(.secondary)
                            Spacer()
                        }
                        .frame(maxWidth: .infinity)
                    } else {
                        MaterialScrollView {
                            LazyVStack(spacing: 3) {
                                ForEach(displayedChats) { item in
                                    ChatRowView(
                                        state: state,
                                        item: item,
                                        isSelected: state.selectedChatId == item.id,
                                        searchQuery: conversationSearch.trimmingCharacters(in: .whitespacesAndNewlines),
                                        onSelect: {
                                            openChat(item.id, markRead: true)
                                        }
                                    )
                                }
                            }
                            .animation(MaterialMotion.standard(reduceMotion: reduceMotion), value: displayedChats.map(\.id))
                            // Indicators are hidden, so rows use the same content
                            // width in every filter state without a fake gutter.
                            .padding(.leading, 6)
                            .padding(.trailing, 6)
                            .padding(.vertical, 6)
                        }
                    }

                    Divider().opacity(0.3)
                    Button(action: onOpenSettings) {
                        HStack(spacing: 10) {
                            UserAvatarView(pictureUrl: state.pictureUrl, displayName: state.displayName, mid: state.mid)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(state.displayName.isEmpty ? "LINE User" : state.displayName)
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundColor(.primary)
                                    .lineLimit(1)
                                Text(state.hasLoadedChatsOnce ? "\(state.chats.count) 個對話" : "正在載入對話…")
                                    .font(.system(size: 11))
                                    .foregroundColor(.secondary)
                            }
                            Spacer()
                            if !showSettings {
                                Circle()
                                    .fill(state.isConnected ? Color.green : Color.secondary)
                                    .frame(width: 7, height: 7)
                            }
                            Image(systemName: showSettings ? "xmark" : "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(showSettings ? EnterpriseTheme.accent : .secondary)
                        }
                        .padding(.horizontal, 12)
                        .frame(height: 54)
                        .background(showSettings ? EnterpriseTheme.accent.opacity(0.07) : .clear)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(",", modifiers: .command)
                    .help(state.i18n.t("tab_settings"))
                }
                // The window content extends into the transparent titlebar. Keep
                // only the sidebar controls clear of macOS traffic lights; the
                // main canvas stays visually continuous with the titlebar.
                .padding(.top, 36)
                .frame(width: EnterpriseTheme.conversationListWidth)
                .background(EnterpriseTheme.surface)

                Divider().opacity(0.3)

                // Right Column: Conversation Detail & Messages
                ZStack(alignment: .bottomTrailing) {
                    if showSettings {
                        SettingsDetailView(state: state, onOpenLogin: onOpenLogin, onBack: onCloseSettings)
                    } else if state.workPreview != nil {
                        WorkPreviewView(state: state)
                    } else if let chat = selectedChat {
                        ConversationDetailView(
                            state: state,
                            chat: chat,
                            onAskAboutChat: onAskAboutChat,
                            onOpenYomi: onOpenCopilot
                        )
                        .id(chat.id)
                    } else {
                        BriefingView(
                            state: state,
                            attentionChats: attentionChats,
                            onSelect: { item in
                                openChat(item.id, markRead: true)
                            },
                            onOpenYomi: onOpenCopilot
                        )
                    }

                    if !showSettings {
                        YomiGuardiansWatermark()
                            .padding(.trailing, 34)
                            .padding(.bottom, 76)
                    }
                }
                // Keep the detail header below the transparent titlebar's toolbar
                // controls. The sidebar applies the same inset independently for
                // its traffic-light safe zone.
                .padding(.top, 36)
            }
        }
        .onAppear {
            if state.chats.isEmpty && state.isConnected {
                state.refreshInbox(.startup)
            } else if let sel = state.selectedChatId, state.currentChatMessages.isEmpty {
                state.loadChatMessages(chatId: sel)
            }
        }
        .onChange(of: conversationSearch) { _, _ in
            searchMatchIndex = 0
        }
    }

    private func moveSearchMatch(_ delta: Int) {
        guard !searchMatches.isEmpty else { return }
        let next = min(max(searchMatchIndex + delta, 0), searchMatches.count - 1)
        searchMatchIndex = next
        let item = searchMatches[next]
        // Search navigation changes the open detail pane, but does not mark
        // neighbouring results read. Only the row's explicit click does that.
        openChat(item.id, markRead: false)
    }

    private func openChat(_ id: String, markRead: Bool) {
        if state.selectedChatId != id {
            NotificationCenter.default.post(name: .yomiWillSwitchChat, object: nil)
        }
        state.loadChatMessages(chatId: id, markReadOnSuccess: markRead)
    }

    private func inboxToolbarButton(icon: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(.secondary)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(PlainButtonStyle())
        .help(help)
    }
}

/// Global attention overview shown on launch and whenever no conversation is
/// selected. It keeps the user's first action at the inbox level instead of
/// silently opening whichever row happens to sort first.
private struct BriefingView: View {
    @ObservedObject var state: AppState
    let attentionChats: [LineChatItem]
    let onSelect: (LineChatItem) -> Void
    let onOpenYomi: () -> Void

    private var now: [LineChatItem] { attentionChats.filter { $0.attentionEvaluation.tier == .now } }
    private var today: [LineChatItem] { attentionChats.filter { $0.attentionEvaluation.tier == .today } }
    private var know: [LineChatItem] { attentionChats.filter { $0.attentionEvaluation.tier == .know } }

    var body: some View {
        VStack(spacing: 0) {
            briefingHeader
            Rectangle().fill(EnterpriseTheme.hairline).frame(height: 1)

            MaterialScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if state.ambientObservationSnapshot?.candidates.contains(where: {
                        $0.responseState != "received"
                    }) == true {
                        AmbientObservationsSection(state: state) { chatId in
                            if let item = state.chats.first(where: { $0.id == chatId }) {
                                onSelect(item)
                            }
                        }
                    }

                    if !state.workItems.isEmpty {
                        WorkItemsSection(state: state) { chatId in
                            if let item = state.chats.first(where: { $0.id == chatId }) {
                                onSelect(item)
                            }
                        }
                    }

                    if !state.hasLoadedChatsOnce {
                        HStack(spacing: 10) {
                            ProgressView().controlSize(.small)
                            Text("正在準備今天的重點…")
                                .font(.system(size: 14, weight: .medium))
                        }
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(EnterpriseTheme.raisedSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    } else if attentionChats.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Image(systemName: "checkmark.circle.fill").foregroundColor(.green).font(.system(size: 28))
                            Text("目前沒有需要處理的訊息").font(.system(size: 16, weight: .semibold))
                            Text("可切換左側「所有對話」查看已過濾或僅供參考的內容。")
                                .font(.system(size: 13)).foregroundColor(.secondary)
                        }
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(EnterpriseTheme.raisedSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("需要你的注意").font(.system(size: 17, weight: .semibold))
                            ForEach(attentionChats.prefix(8)) { item in
                                Button(action: { onSelect(item) }) {
                                    HStack(spacing: 10) {
                                        CachedAvatarView(
                                            pictureUrl: item.pictureUrl, title: item.title, size: 34, isMuted: item.effectiveMuted)
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack(spacing: 6) {
                                                Text(item.title).font(.system(size: 14, weight: .semibold))
                                                Text(item.attentionEvaluation.tier.label)
                                                    .font(.system(size: 11, weight: .medium))
                                                    .foregroundColor(tierColor(item.attentionEvaluation.tier))
                                            }
                                            Text(item.localizedAttentionReason(using: state.i18n))
                                                .font(.system(size: 12)).foregroundColor(.secondary).lineLimit(1)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right").foregroundColor(.secondary)
                                    }
                                    .padding(.vertical, 8)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(18)
                        .background(EnterpriseTheme.raisedSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    Spacer(minLength: 20)
                }
                .padding(28)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(EnterpriseTheme.canvas)
    }

    private var briefingHeader: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("今日 Briefing")
                        .font(.system(size: 25, weight: .bold))
                    Text("Yomi 先整理需要你處理的訊息；未讀不等於需要注意。")
                        .font(.system(size: 13))
                        .foregroundColor(EnterpriseTheme.secondaryText)
                }
                Spacer()
                Button(action: onOpenYomi) {
                    HStack(spacing: 6) {
                        YomiGuardiansMark(size: 16)
                        Text("交代 Yomi").font(.system(size: 13, weight: .semibold))
                        Text("⌘J").font(.system(size: 10, weight: .medium)).foregroundColor(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 38)
                    .background(EnterpriseTheme.raisedSurface)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(EnterpriseTheme.hairline))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .help("開啟完整 Yomi 工作區")
                .accessibilityLabel("交代 Yomi；開啟完整 Yomi 工作區")
                .keyboardShortcut("j", modifiers: .command)
            }

            if state.hasLoadedChatsOnce {
                HStack(spacing: 8) {
                    briefingMetric("現在處理", value: now.count, color: EnterpriseTheme.attentionNow)
                    briefingMetric("今天處理", value: today.count, color: EnterpriseTheme.attentionToday)
                    briefingMetric("值得知道", value: know.count, color: EnterpriseTheme.attentionKnow)
                }
            }
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 20)
        .background(EnterpriseTheme.canvas)
    }

    private func briefingMetric(_ title: String, value: Int, color: Color) -> some View {
        let displayColor = value == 0 ? EnterpriseTheme.secondaryText.opacity(0.5) : color
        return VStack(alignment: .leading, spacing: 4) {
            Text("\(value)").font(.system(size: 25, weight: .bold)).foregroundColor(displayColor)
            Text(title).font(.system(size: 12, weight: .medium)).foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(EnterpriseTheme.raisedSurface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func tierColor(_ tier: AttentionTier) -> Color {
        switch tier {
        case .pending: return EnterpriseTheme.secondaryText
        case .now: return EnterpriseTheme.attentionNow
        case .today: return EnterpriseTheme.attentionToday
        case .know: return EnterpriseTheme.attentionKnow
        case .filtered: return EnterpriseTheme.secondaryText
        }
    }
}

private struct AmbientObservationsSection: View {
    @ObservedObject var state: AppState
    let onSelectChat: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "waveform.path.ecg.rectangle").foregroundColor(EnterpriseTheme.accent)
                Text(state.i18n.t("ambient_observer_title"))
                    .font(.system(size: 17, weight: .semibold))
                Spacer()
                if state.isAmbientObserverRunning { ProgressView().controlSize(.small) }
            }
            let activeCandidates =
                state.ambientObservationSnapshot?.candidates.filter {
                    $0.responseState != "received"
                } ?? []
            if !activeCandidates.isEmpty {
                ForEach(activeCandidates.prefix(6)) { candidate in
                    Button {
                        state.previewWork(candidate)
                    } label: {
                        HStack(alignment: .center, spacing: 12) {
                            VStack(alignment: .leading, spacing: 6) {
                                HStack(spacing: 8) {
                                    Text(candidate.chatName)
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundColor(.secondary)
                                    Text(state.i18n.t("ambient_observer_response_\(candidate.responseState)"))
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundColor(
                                            candidate.responseState == "waiting"
                                                ? EnterpriseTheme.accent : EnterpriseTheme.attentionKnow
                                        )
                                        .padding(.horizontal, 7)
                                        .frame(height: 24)
                                        .background(
                                            (candidate.responseState == "waiting"
                                                ? EnterpriseTheme.accent : EnterpriseTheme.attentionKnow)
                                                .opacity(0.1)
                                        )
                                        .clipShape(Capsule())
                                }
                                Text(
                                    candidate.title.isEmpty
                                        ? String(
                                            format: state.i18n.t("ambient_observer_media_candidate"),
                                            candidate.evidence.filter { $0.mediaType != nil }.count)
                                        : candidate.title
                                )
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundColor(.primary)
                                .lineLimit(2)
                                if let ocr = candidate.evidence.compactMap(\.ocrText).first,
                                    !ocr.isEmpty
                                {
                                    Text(ocr.replacingOccurrences(of: "\n", with: " "))
                                        .font(.system(size: 13))
                                        .foregroundColor(.secondary)
                                        .lineLimit(1)
                                }
                                HStack(spacing: 8) {
                                    Text(String(format: state.i18n.t("ambient_observer_evidence_count"), candidate.evidence.count))
                                    if !candidate.ownerHints.isEmpty {
                                        Text(
                                            String(
                                                format: state.i18n.t("ambient_observer_owner"), candidate.ownerHints.joined(separator: "、"))
                                        )
                                    }
                                    let ocrCount = candidate.evidence.filter {
                                        $0.ocrText?.isEmpty == false
                                    }.count
                                    if ocrCount > 0 {
                                        Text(
                                            String(
                                                format: state.i18n.t("ambient_observer_ocr_count"),
                                                ocrCount))
                                    }
                                }
                                .font(.system(size: 12))
                                .foregroundColor(.secondary)
                            }
                            Spacer(minLength: 12)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(.secondary)
                        }
                        .padding(.vertical, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(state.i18n.t("tracking_detail_hint"))
                    if candidate.id != activeCandidates.prefix(6).last?.id {
                        Divider().opacity(0.45)
                    }
                }
            }
        }
        .padding(18)
        .background(EnterpriseTheme.raisedSurface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

struct IntegrationsDetailView: View {
    @ObservedObject var state: AppState

    var body: some View {
        IdeIntegrationSheetView(state: state, onClose: {})
            .padding(10)
    }
}
