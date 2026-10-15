import AVFoundation
import Cocoa
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ConversationDetailView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var state: AppState
    let chat: LineChatItem
    var onAskAboutChat: (String) -> Void
    var onOpenYomi: () -> Void
    @State var composerInput: String = ""
    @StateObject var voiceInput = VoiceInputController()
    @StateObject var camera = CameraCaptureController()
    @State var selectedPhotoItem: PhotosPickerItem?
    @State var stagedAttachments: [ComposerAttachment] = []
    @State var yomiStagedAttachments: [ComposerAttachment] = []
    @State private var isDropTargeted = false
    @State var composerFocused = false
    @State private var composerMeasuredHeight: CGFloat = 44
    @State var isYomiMode = false
    @State var yomiPromptDraft = ""
    @State private var yomiSessionStartIndex = 0
    @State private var yomiThreadExpanded = true
    @State var mentionTargets: [LineMentionTarget] = []
    @State var lineHistoryIndex: Int?
    @State var yomiHistoryIndex: Int?
    @State var lineHistoryDraft = ""
    @State var yomiHistoryDraft = ""
    @State var outgoingMessages: [LineChatMessage] = []
    @State private var selectedThreadMessage: LineChatMessage?
    @State var richMenuExpanded = false
    @State private var shouldAnchorToLatest = true
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                CachedAvatarView(
                    pictureUrl: chat.pictureUrl,
                    title: chat.title,
                    size: 32,
                    isMuted: chat.isMuted
                )

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(chat.title)
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.primary)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        if chat.isGroup {
                            Image(systemName: "person.2.fill")
                                .font(.system(size: 12))
                                .foregroundColor(.secondary)
                        }
                    }

                    HStack(spacing: 5) {
                        Circle()
                            .fill(Color.green)
                            .frame(width: 5, height: 5)
                        Text(state.i18n.t("e2ee_protected"))
                            .font(.system(size: 12))
                            .foregroundColor(.secondary)
                    }
                }

                Spacer()

                HStack(alignment: .bottom, spacing: 6) {
                    Button(action: onOpenYomi) {
                        HStack(spacing: 5) {
                            YomiGuardiansMark(mode: .yomi, size: 18)
                            Text("Yomi").font(.system(size: 12, weight: .semibold))
                        }
                        .padding(.horizontal, 8)
                        .frame(height: 36)
                        .background(EnterpriseTheme.raisedSurface)
                        .cornerRadius(6)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .help("開啟完整 Yomi 對話")
                    .accessibilityLabel("開啟完整 Yomi 對話")
                    Button(action: {
                        if chat.id.hasPrefix("u") {
                            state.setLineMuted(chatId: chat.id, enabled: !chat.isMuted)
                        } else {
                            state.setYomiMuted(
                                chatId: chat.id,
                                enabled: !YomiAttentionPolicyStore.isMuted(chat.id))
                        }
                    }) {
                        let active = chat.id.hasPrefix("u") ? chat.isMuted : YomiAttentionPolicyStore.isMuted(chat.id)
                        Image(
                            systemName: chat.id.hasPrefix("u")
                                ? (active ? "bell.fill" : "bell.slash") : (active ? "bolt.fill" : "bolt.slash.fill")
                        )
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(active ? EnterpriseTheme.accent : .secondary)
                        .frame(width: 36, height: 36)
                        .background(EnterpriseTheme.raisedSurface)
                        .cornerRadius(6)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .help(
                        chat.id.hasPrefix("u")
                            ? state.i18n.t(chat.isMuted ? "line_unmute" : "line_mute")
                            : (YomiAttentionPolicyStore.isMuted(chat.id)
                                ? state.i18n.t("attention_restore") : state.i18n.t("attention_exclude")))
                    Button(action: {
                        state.loadChatMessages(chatId: chat.id)
                    }) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(.secondary)
                            .rotationEffect(.degrees(state.isLoadingMessages ? 360 : 0))
                            .animation(
                                state.isLoadingMessages ? Animation.linear(duration: 0.8).repeatForever(autoreverses: false) : .default,
                                value: state.isLoadingMessages
                            )
                            .frame(width: 36, height: 36)
                            .background(EnterpriseTheme.raisedSurface)
                            .cornerRadius(6)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .help(state.i18n.t("refresh"))
                }
                .fixedSize(horizontal: true, vertical: false)
            }
            .padding(.horizontal, EnterpriseTheme.contentPadding)
            .padding(.vertical, 12)
            .background(EnterpriseTheme.canvas)
            Divider().opacity(0.3)
            if state.isLoadingMessages && state.currentChatMessages.isEmpty {
                ConversationLoadingSkeleton(i18n: state.i18n)
            } else if let loadError = state.messageLoadError, state.currentChatMessages.isEmpty {
                VStack(spacing: 10) {
                    Spacer()
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 30))
                        .foregroundColor(EnterpriseTheme.accent)
                    Text(loadError)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.secondary)
                    Button("重試") {
                        state.loadChatMessages(chatId: chat.id, markReadOnSuccess: true)
                    }
                    .buttonStyle(.borderedProminent)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if state.currentChatMessages.isEmpty && outgoingMessages.isEmpty {
                VStack(spacing: 8) {
                    Spacer()
                    Image(systemName: "message")
                        .font(.system(size: EnterpriseTheme.Typography.stateIcon))
                        .foregroundColor(.secondary.opacity(0.4))
                    Text(state.i18n.t("no_messages"))
                        .font(.system(size: EnterpriseTheme.Typography.status, weight: .semibold))
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.vertical, showsIndicators: false) {
                        LazyVStack(spacing: 10) {
                            ForEach(state.currentChatMessages) { msg in
                                ChatMessageBubbleRow(
                                    state: state,
                                    chatId: chat.id,
                                    msg: msg,
                                    onMention: mentionMember,
                                    onOpenThread: openThread,
                                    onRichMessageAction: handleRichMessageAction
                                )
                                .id(msg.id)
                            }
                            ForEach(outgoingMessages) { msg in
                                ChatMessageBubbleRow(state: state, chatId: chat.id, msg: msg)
                                    .id(msg.id)
                            }
                        }
                        .padding(.horizontal, EnterpriseTheme.contentPadding)
                        .padding(.vertical, EnterpriseTheme.contentPadding)
                    }
                    .defaultScrollAnchor(.bottom)
                    .onAppear {
                        if let lastId = state.currentChatMessages.last?.id {
                            proxy.scrollTo(lastId, anchor: .bottom)
                        }
                        shouldAnchorToLatest = false
                    }
                    .onChange(of: outgoingMessages.count) { _, _ in
                        if let lastId = outgoingMessages.last?.id {
                            withAnimation { proxy.scrollTo(lastId, anchor: .bottom) }
                        }
                    }
                    .onChange(of: state.currentChatMessages.map(\.id)) { _, ids in
                        outgoingMessages.removeAll { ids.contains($0.id) }
                        if shouldAnchorToLatest, let lastID = ids.last {
                            DispatchQueue.main.async {
                                proxy.scrollTo(lastID, anchor: .bottom)
                                shouldAnchorToLatest = false
                            }
                        }
                    }
                    .onChange(of: selectedThreadMessage?.id) { _, messageID in
                        if let messageID {
                            withAnimation(MaterialMotion.quick(reduceMotion: reduceMotion)) {
                                proxy.scrollTo(messageID, anchor: .center)
                            }
                        }
                    }
                }
            }
            Divider().opacity(0.3)
            VStack(spacing: 0) {
                if isYomiMode && (!contextYomiMessages.isEmpty || state.isAiThinking) {
                    DisclosureGroup(isExpanded: $yomiThreadExpanded) {
                        VStack(alignment: .leading, spacing: 7) {
                            ForEach(contextYomiMessages) { message in
                                Text(message.text)
                                    .font(.system(size: 12.5))
                                    .foregroundColor(message.isUser ? EnterpriseTheme.accent : .primary)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if let approval = state.codexApprovalRequest {
                                AgentApprovalView(request: approval) { decision in
                                    state.respondToCodexApproval(decision: decision)
                                }
                            }
                            if let elicitation = state.codexElicitationRequest {
                                AgentElicitationView(request: elicitation) { action, content in
                                    state.respondToCodexElicitation(action: action, content: content)
                                }
                            }
                            if state.isAiThinking && state.codexApprovalRequest == nil
                                && state.codexElicitationRequest == nil
                            {
                                HStack(spacing: 6) {
                                    ProgressView().controlSize(.small)
                                    Text(state.codexStatus).font(.system(size: 12)).foregroundColor(.secondary)
                                }
                            }
                        }
                        .padding(.top, 6)
                    } label: {
                        HStack(spacing: 6) {
                            YomiGuardiansMark(size: 14)
                            Text("Yomi 對話")
                        }
                        .font(.system(size: 12, weight: .semibold))
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(EnterpriseTheme.accent.opacity(0.05))
                }

                if richMenuExpanded, let menu = state.currentBuddyRichMenu {
                    BuddyRichMenuView(
                        menu: menu,
                        onAction: handleRichMenuAction,
                        expanded: $richMenuExpanded
                    )
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                } else {

                    HStack(spacing: 7) {
                        YomiGuardiansMark(mode: isYomiMode ? .yomi : .line, size: 18)
                            .frame(width: 22, height: 22, alignment: .center)
                        Text(isYomiMode ? "問 Yomi" : "回覆 \(chat.title)")
                            .font(.system(size: 12, weight: .semibold))
                        if isYomiMode {
                            Text("這個對話")
                                .font(.system(size: 10, weight: .medium))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(EnterpriseTheme.accent.opacity(0.11))
                                .clipShape(Capsule())
                        }
                        Spacer()
                        Text(isYomiMode ? "AI" : "LINE")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(isYomiMode ? EnterpriseTheme.accent : .secondary)
                    }
                    .padding(.horizontal, 14)
                    .frame(height: richMenuExpanded ? 0 : 30, alignment: .center)
                    .opacity(richMenuExpanded ? 0 : 1)
                    .clipped()
                    .background(isYomiMode ? EnterpriseTheme.accent.opacity(0.055) : EnterpriseTheme.canvas)

                    let activeAttachments = isYomiMode ? yomiStagedAttachments : stagedAttachments
                    VStack(spacing: 0) {
                        if !richMenuExpanded && !activeAttachments.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(activeAttachments) { attachment in
                                        HStack(spacing: 6) {
                                            Image(systemName: attachment.isImage ? "photo.fill" : "doc.fill")
                                                .foregroundColor(EnterpriseTheme.accent)
                                            Text(attachment.fileName)
                                                .lineLimit(1)
                                                .font(.system(size: 12, weight: .medium))
                                            Button {
                                                removeAttachment(attachment.id)
                                            } label: {
                                                Image(systemName: "xmark.circle.fill")
                                            }
                                            .buttonStyle(.plain)
                                            .accessibilityLabel("移除附件 \(attachment.fileName)")
                                        }
                                        .padding(.horizontal, 9)
                                        .frame(height: 30)
                                        .background(EnterpriseTheme.surface)
                                        .clipShape(RoundedRectangle(cornerRadius: 6))
                                    }
                                }
                                .padding(.horizontal, 10)
                            }
                            .frame(height: 40)
                            .overlay(alignment: .bottom) {
                                Rectangle().fill(EnterpriseTheme.hairline).frame(height: 1)
                            }
                        }

                        HStack(alignment: .bottom, spacing: 6) {
                            let activeText = isYomiMode ? yomiPromptDraft : composerInput
                            let hasText = !activeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            let hasAttachments = !activeAttachments.isEmpty
                            ZStack(alignment: .bottomTrailing) {
                                HiddenScrollTextEditor(
                                    text: isYomiMode ? $yomiPromptDraft : $composerInput,
                                    isFocused: $composerFocused,
                                    measuredHeight: $composerMeasuredHeight,
                                    onSubmit: isYomiMode ? submitYomiPrompt : submitComposer,
                                    onHistoryPrevious: previousComposerHistory,
                                    onHistoryNext: nextComposerHistory,
                                    onFileDrop: { urls in
                                        for url in urls { stage(url: url) }
                                    }
                                )
                                .font(.system(size: 15))
                                .frame(height: composerEditorHeight)
                                .frame(maxWidth: .infinity)
                                .padding(.bottom, 38)
                                .padding(.trailing, 0)
                                .contentShape(Rectangle())
                                .accessibilityLabel(isYomiMode ? "問 Yomi" : "回覆 \(chat.title)")
                                .accessibilityHint(isYomiMode ? "內容只會交給 Yomi，不會送到 LINE" : "訊息會送給目前 LINE 對話")

                                VStack(spacing: 0) {
                                    HStack(spacing: 2) {
                                        expandedComposerLeftActions
                                        Spacer(minLength: 0)
                                        Button {
                                            composerFocused = true
                                            DispatchQueue.main.async {
                                                NSApp.orderFrontCharacterPalette(nil)
                                            }
                                        } label: {
                                            Image(systemName: "face.smiling")
                                                .font(.system(size: 16, weight: .medium))
                                                .frame(width: 30, height: 34)
                                        }
                                        .buttonStyle(PlainButtonStyle())
                                        .foregroundColor(EnterpriseTheme.accent)
                                        .help("插入表情符號")
                                        .accessibilityLabel("插入表情符號")

                                        if !isYomiMode {
                                            Button(action: {
                                                state.loadOwnedStickers()
                                                showStickerPicker = true
                                            }) {
                                                Image(systemName: "photo.on.rectangle.angled")
                                                    .font(.system(size: 16, weight: .medium))
                                                    .frame(width: 30, height: 34)
                                            }
                                            .buttonStyle(PlainButtonStyle())
                                            .foregroundColor(EnterpriseTheme.accent)
                                            .help("選擇 LINE 貼圖")
                                            .accessibilityLabel(state.i18n.t("open_sticker_picker"))
                                            .popover(isPresented: $showStickerPicker, arrowEdge: .bottom) {
                                                StickerPickerView(
                                                    state: state,
                                                    chatId: chat.id,
                                                    onSend: sendSticker)
                                            }
                                        }

                                        Button {
                                            voiceInput.toggle(currentText: activeText)
                                        } label: {
                                            Image(systemName: voiceInput.status.isRecording ? "stop.fill" : "mic.fill")
                                                .font(.system(size: 17, weight: .semibold))
                                                .frame(width: 30, height: 34)
                                        }
                                        .buttonStyle(PlainButtonStyle())
                                        .foregroundColor(
                                            voiceInput.status.isRecording ? EnterpriseTheme.accent : EnterpriseTheme.secondaryText
                                        )
                                        .disabled(state.isSendingReply || (isYomiMode && state.isAiThinking))
                                        .help("語音輸入")
                                        .accessibilityLabel("語音輸入")

                                        if hasText || hasAttachments {
                                            Button {
                                                if isYomiMode { submitYomiPrompt() } else { submitComposer() }
                                            } label: {
                                                Image(systemName: "paperplane.fill")
                                                    .font(.system(size: 17, weight: .semibold))
                                                    .frame(width: 30, height: 34)
                                            }
                                            .buttonStyle(PlainButtonStyle())
                                            .foregroundColor(EnterpriseTheme.accent)
                                            .disabled(state.isSendingReply || (isYomiMode && state.isAiThinking))
                                            .help(isYomiMode ? "交給 Yomi" : "送出 LINE 回覆")
                                            .accessibilityLabel(isYomiMode ? "交給 Yomi" : "送出 LINE 回覆")
                                        }
                                        expandedComposerModeButton
                                    }
                                    .padding(.trailing, 6)
                                }
                                .frame(height: 38, alignment: .bottom)
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .frame(minHeight: 44)
                            .animation(MaterialMotion.standard(reduceMotion: reduceMotion), value: composerEditorHeight)

                            if let menu = state.currentBuddyRichMenu {
                                Button(action: { toggleRichMenu() }) {
                                    Image(systemName: richMenuExpanded ? "keyboard" : "rectangle.bottomhalf.inset.filled")
                                        .font(.system(size: 17, weight: .semibold))
                                        .frame(width: 38, height: 44, alignment: .center)
                                }
                                .buttonStyle(PlainButtonStyle())
                                .foregroundColor(EnterpriseTheme.accent)
                                .help(
                                    richMenuExpanded
                                        ? state.i18n.t("rich_menu_back_to_input")
                                        : state.i18n.t("rich_menu_open").replacingOccurrences(of: "%@", with: menu.label)
                                )
                                .accessibilityLabel(
                                    richMenuExpanded
                                        ? state.i18n.t("rich_menu_back_to_input")
                                        : state.i18n.t("rich_menu_open").replacingOccurrences(of: "%@", with: menu.label)
                                )
                                .accessibilityHint(state.i18n.t("rich_menu_switch_hint"))
                            }

                            Button(action: { toggleYomiMode() }) {
                                YomiGuardiansMark(mode: isYomiMode ? .yomi : .line, size: 30)
                                    .frame(width: 44, height: 44, alignment: .center)
                            }
                            .buttonStyle(PlainButtonStyle())
                            .foregroundColor(isYomiMode ? EnterpriseTheme.accent : EnterpriseTheme.secondaryText)
                            .help(isYomiMode ? "回到 LINE 回覆" : "切換為 Yomi")
                            .accessibilityLabel(isYomiMode ? "回到 LINE 回覆" : "切換為 Yomi")
                            .keyboardShortcut("j", modifiers: .command)
                            .frame(width: 0)
                            .opacity(0)
                            .clipped()
                            .allowsHitTesting(false)
                        }
                    }
                    .frame(minHeight: 58, alignment: .bottom)
                    .frame(maxHeight: richMenuExpanded ? 0 : nil)
                    .opacity(richMenuExpanded ? 0 : 1)
                    .clipped()
                    .background(EnterpriseTheme.raisedSurface)
                    .overlay(alignment: .bottom) {
                        if !richMenuExpanded {
                            VStack(spacing: 0) {
                                Divider().opacity(0.35)
                                Color.clear.frame(height: 44)
                            }
                            .transition(.opacity)
                            .allowsHitTesting(false)
                        }
                    }
                    .overlay(
                        RoundedRectangle(cornerRadius: EnterpriseTheme.cornerRadius).stroke(
                            isDropTargeted ? EnterpriseTheme.accent : EnterpriseTheme.hairline,
                            lineWidth: isDropTargeted ? 2 : 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: EnterpriseTheme.cornerRadius))
                    .padding(.horizontal, 10)
                    .padding(.vertical, richMenuExpanded ? 0 : 7)
                    .background(isYomiMode ? EnterpriseTheme.accent.opacity(0.055) : EnterpriseTheme.canvas)
                    .onDrop(of: [UTType.fileURL.identifier, UTType.image.identifier], isTargeted: $isDropTargeted) { providers in
                        return stageDroppedProviders(providers)
                    }
                    .onExitCommand {
                        if richMenuExpanded {
                            toggleRichMenu()
                        } else if isYomiMode {
                            toggleYomiMode()
                        }
                    }
                    .onReceive(voiceInput.$transcript) { value in
                        if isYomiMode {
                            if value != yomiPromptDraft { yomiPromptDraft = value }
                        } else if value != composerInput {
                            composerInput = value
                        }
                    }
                    .onDisappear { voiceInput.stop() }
                    .onChange(of: chat.id) { _, _ in
                        closeThread()
                        voiceInput.stop()
                        camera.stop()
                        composerInput = ""
                        yomiPromptDraft = ""
                        stagedAttachments = []
                        yomiStagedAttachments = []
                        isYomiMode = false
                        lineHistoryIndex = nil
                        yomiHistoryIndex = nil
                        composerMeasuredHeight = 44
                        richMenuExpanded = false
                        shouldAnchorToLatest = true
                        outgoingMessages = []
                    }
                    .onChange(of: selectedPhotoItem) { _, item in handlePhotoSelection(item) }
                    .onChange(of: composerInput) { _, value in
                        guard !isYomiMode else { return }
                        stagePastedFileReference(value)
                    }
                    .onChange(of: yomiPromptDraft) { _, value in
                        guard isYomiMode else { return }
                        stagePastedFileReference(value)
                    }
                }

                if voiceStatusMessage != nil || state.isSendingReply {
                    VStack(spacing: 8) {
                        if case .denied(let message) = voiceInput.status {
                            Text(message)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(EnterpriseTheme.accent)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14)
                        } else if case .failed(let message) = voiceInput.status {
                            Text(message)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(EnterpriseTheme.accent)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14)
                        }

                        if state.isSendingReply {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text("正在送出…").font(.system(size: 13)).foregroundColor(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                        }

                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(EnterpriseTheme.canvas)
                }
            }
        }
        .overlay(alignment: .bottomLeading) {
            if let feedback = state.replyFeedback {
                HStack(spacing: 6) {
                    Image(
                        systemName: state.replyFeedbackIsError
                            ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    Text(feedback)
                        .lineLimit(2)
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(state.replyFeedbackIsError ? EnterpriseTheme.accent : .green)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(.regularMaterial, in: Capsule())
                .overlay(
                    Capsule().stroke(
                        state.replyFeedbackIsError
                            ? EnterpriseTheme.accent.opacity(0.28) : Color.green.opacity(0.28),
                        lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
                .padding(.leading, 18)
                .padding(.bottom, richMenuExpanded ? 18 : composerEditorHeight + 104)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
                .accessibilityLabel(feedback)
                .task(id: feedback) {
                    try? await Task.sleep(for: .seconds(state.replyFeedbackIsError ? 5 : 2.5))
                    if state.replyFeedback == feedback { state.replyFeedback = nil }
                }
            }
        }
        .overlay(alignment: .trailing) {
            if let selectedThreadMessage {
                ThreadInspectorView(state: state, chatId: chat.id, root: selectedThreadMessage) {
                    closeThread()
                }
                .frame(width: 340)
                .overlay(alignment: .leading) { Divider() }
                .shadow(color: .black.opacity(0.14), radius: 14, x: -4)
                .transition(.move(edge: .trailing).combined(with: .opacity))
                .zIndex(20)
            }
        }
        .animation(
            MaterialMotion.quick(reduceMotion: reduceMotion),
            value: selectedThreadMessage?.id
        )
        .onDisappear {
            closeThread()
        }
        .onReceive(NotificationCenter.default.publisher(for: .yomiWillSwitchChat)) { _ in
            closeThread()
        }
        .onAppear {
            state.conversationDidBecomeVisible(chatId: chat.id)
        }
        .onDisappear {
            state.conversationDidStopBeingVisible(chatId: chat.id)
        }
        .onChange(of: state.currentChatMessages.map(\.id)) { _, ids in
            guard
                let messageID = VisibleReadCursorPolicy.latestPresentedMessageID(
                    chatID: chat.id,
                    selectedChatID: state.selectedChatId,
                    visibleChatID: state.visibleConversationId,
                    presentedMessageIDs: ids),
                state.chats.first(where: { $0.id == chat.id })?.unreadCount ?? 0 > 0
            else { return }
            state.markChatRead(chatId: chat.id, messageId: messageID)
        }

    }

    @State var showStickerPicker: Bool = false
    @State var showCameraPopover: Bool = false

    private var expandedComposerLeftActions: some View {
        HStack(spacing: 6) {
            Button(action: chooseFile) {
                Label(state.i18n.t("attachment_label"), systemImage: "paperclip")
                    .font(.system(size: 12, weight: .semibold))
                    .padding(.horizontal, 9)
                    .frame(height: 34)
                    .background(EnterpriseTheme.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            .buttonStyle(.plain)
            .help(state.i18n.t("attachment_pick"))
            .accessibilityLabel(state.i18n.t("attachment_pick"))

            Button(action: { showCameraPopover = true }) {
                Image(systemName: "camera.fill").frame(width: 30, height: 34)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showCameraPopover, arrowEdge: .bottom) {
                CameraCapturePopover(
                    controller: camera,
                    onSend: { stageImageData($0) },
                    onClose: { showCameraPopover = false })
            }

            PhotosPicker(selection: $selectedPhotoItem, matching: .images, photoLibrary: .shared()) {
                Image(systemName: "photo").frame(width: 30, height: 34)
            }
            .buttonStyle(.plain)
        }
        .foregroundColor(EnterpriseTheme.secondaryText)
    }

    private var expandedComposerModeButton: some View {
        Button(action: { toggleYomiMode() }) {
            YomiGuardiansMark(mode: isYomiMode ? .yomi : .line, size: 24)
                .frame(width: 34, height: 34)
        }
        .buttonStyle(.plain)
        .help(isYomiMode ? "回到 LINE 回覆" : "切換為 Yomi")
    }

    private var contextYomiMessages: [ChatMessageItem] {
        guard yomiSessionStartIndex < state.chatMessages.count else { return [] }
        return Array(state.chatMessages.dropFirst(yomiSessionStartIndex))
    }

    private var voiceStatusMessage: String? {
        if case .denied(let message) = voiceInput.status { return message }
        if case .failed(let message) = voiceInput.status { return message }
        return nil
    }

    private var composerEditorHeight: CGFloat {
        min(104, max(44, composerMeasuredHeight))
    }

    private var composerExpanded: Bool { composerEditorHeight > 44.5 }

    private func openThread(_ message: LineChatMessage) {
        selectedThreadMessage = message
    }

    private func closeThread() {
        selectedThreadMessage = nil
    }

    private func toggleYomiMode() {
        if !isYomiMode {
            yomiSessionStartIndex = state.chatMessages.count
            yomiThreadExpanded = true
        }
        withAnimation(MaterialMotion.standard(reduceMotion: reduceMotion)) { isYomiMode.toggle() }
        voiceInput.stop()
        composerFocused = true
    }

    private func toggleRichMenu() {
        guard state.currentBuddyRichMenu != nil else { return }
        voiceInput.stop()
        composerFocused = false
        withAnimation(MaterialMotion.standard(reduceMotion: reduceMotion)) {
            richMenuExpanded.toggle()
        }
    }

    private func submitYomiPrompt() {
        let prompt = yomiPromptDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty || !yomiStagedAttachments.isEmpty, !state.isAiThinking else { return }
        ComposerHistoryStore.append(prompt, chatId: chat.id, yomi: true)
        yomiHistoryIndex = nil
        voiceInput.stop()
        let fileContext =
            yomiStagedAttachments.isEmpty
            ? ""
            : "；使用者附上本機檔案：" + yomiStagedAttachments.map(\.url.path).joined(separator: "、")
        yomiPromptDraft = ""
        yomiStagedAttachments = []
        yomiThreadExpanded = true
        state.sendAiQuery(prompt: "目前對話：\(chat.title)；使用者請 Yomi 處理：\(prompt)\(fileContext)")
    }
}
