import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fputs("[visible-read-cursor-test] FAIL: \(message)\n", stderr)
        exit(1)
    }
}

@main
struct VisibleReadCursorTest {
    static func main() {
        expect(
            VisibleReadCursorPolicy.latestPresentedMessageID(
                chatID: "chat", selectedChatID: "chat", visibleChatID: "chat", presentedMessageIDs: ["m1", "m2"])
                == "m2",
            "visible selected conversation must advance to its latest presented message")
        expect(
            VisibleReadCursorPolicy.latestPresentedMessageID(
                chatID: "chat", selectedChatID: "other", visibleChatID: "chat", presentedMessageIDs: ["m2"]) == nil,
            "a stale view must not advance a different selection")
        expect(
            VisibleReadCursorPolicy.latestPresentedMessageID(
                chatID: "chat", selectedChatID: "chat", visibleChatID: nil, presentedMessageIDs: ["m2"]) == nil,
            "background content must not mark read")
        expect(
            VisibleReadCursorPolicy.latestPresentedMessageID(
                chatID: "chat", selectedChatID: "chat", visibleChatID: "chat", presentedMessageIDs: ["local-pending-1"]) == nil,
            "an optimistic local row is not a LINE read cursor")
    }
}
