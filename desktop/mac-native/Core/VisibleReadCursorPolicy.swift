import Foundation

enum VisibleReadCursorPolicy {
    static func latestPresentedMessageID(
        chatID: String,
        selectedChatID: String?,
        visibleChatID: String?,
        presentedMessageIDs: [String]
    ) -> String? {
        guard !chatID.isEmpty,
            selectedChatID == chatID,
            visibleChatID == chatID,
            let latest = presentedMessageIDs.last,
            !latest.isEmpty,
            !latest.hasPrefix("local-")
        else { return nil }
        return latest
    }
}
