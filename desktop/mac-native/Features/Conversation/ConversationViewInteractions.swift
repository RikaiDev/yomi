import Cocoa

extension ConversationDetailView {
    func mentionMember(_ mid: String, _ name: String) {
        guard chat.isGroup else { return }
        isYomiMode = false
        let mention = "@\(name) "
        if !composerInput.contains(mention) {
            composerInput += mention
            mentionTargets.append(LineMentionTarget(mid: mid, name: name))
        }
        composerFocused = true
    }

    func handleRichMenuAction(_ area: BuddyRichMenuArea) {
        if area.type == "web", let value = area.uri, let url = URL(string: value),
            ["http", "https"].contains(url.scheme?.lowercased() ?? "")
        {
            NSWorkspace.shared.open(url)
        } else if area.type == "sendMessage", let text = area.text {
            richMenuExpanded = false
            composerInput = text
            composerFocused = true
        } else if area.type == "postback", area.uri?.contains("/richmenuswitch") == true {
            state.replyFeedbackIsError = false
            state.replyFeedback = state.i18n.t("rich_menu_switch_mobile_only")
        } else {
            state.replyFeedbackIsError = true
            state.replyFeedback = state.i18n.t("rich_menu_action_unsupported")
        }
    }

    func handleRichMessageAction(_ text: String) {
        richMenuExpanded = false
        isYomiMode = false
        composerInput = text
        composerFocused = true
    }

    func previousComposerHistory() -> String? {
        let values = ComposerHistoryStore.load(chatId: chat.id, yomi: isYomiMode)
        guard !values.isEmpty else { return nil }
        if isYomiMode {
            if yomiHistoryIndex == nil { yomiHistoryDraft = yomiPromptDraft }
            let next = max(0, (yomiHistoryIndex ?? values.count) - 1)
            yomiHistoryIndex = next
            return values[next]
        }
        if lineHistoryIndex == nil { lineHistoryDraft = composerInput }
        let next = max(0, (lineHistoryIndex ?? values.count) - 1)
        lineHistoryIndex = next
        return values[next]
    }

    func nextComposerHistory() -> String? {
        let values = ComposerHistoryStore.load(chatId: chat.id, yomi: isYomiMode)
        if isYomiMode, let index = yomiHistoryIndex {
            guard index + 1 < values.count else {
                yomiHistoryIndex = nil
                return yomiHistoryDraft
            }
            yomiHistoryIndex = index + 1
            return values[index + 1]
        }
        if !isYomiMode, let index = lineHistoryIndex {
            guard index + 1 < values.count else {
                lineHistoryIndex = nil
                return lineHistoryDraft
            }
            lineHistoryIndex = index + 1
            return values[index + 1]
        }
        return nil
    }
}
