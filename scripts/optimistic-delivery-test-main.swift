import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fputs("[optimistic-delivery-test] FAIL: \(message)\n", stderr)
        exit(1)
    }
}

@main
struct OptimisticDeliveryTest {
    static func main() {
        let pending = OptimisticDeliveryReducer.begin(localID: "local-1")
        expect(pending == .init(messageID: "local-1", pending: true, failed: false), "begin must paint immediately")

        let delivered = OptimisticDeliveryReducer.settle(
            localID: "local-1", succeeded: true, serverMessageID: "server-9")
        expect(delivered == .init(messageID: "server-9", pending: false, failed: false), "success must reconcile the server id")

        let failed = OptimisticDeliveryReducer.settle(
            localID: "local-1", succeeded: false, serverMessageID: nil)
        expect(failed == .init(messageID: "local-1", pending: false, failed: true), "failure must retain the local row for retry feedback")
    }
}
