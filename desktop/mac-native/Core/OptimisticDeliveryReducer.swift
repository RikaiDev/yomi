import Foundation

struct OptimisticDeliveryResolution: Equatable {
    let messageID: String
    let pending: Bool
    let failed: Bool
}

enum OptimisticDeliveryReducer {
    static func begin(localID: String) -> OptimisticDeliveryResolution {
        OptimisticDeliveryResolution(messageID: localID, pending: true, failed: false)
    }

    static func settle(
        localID: String,
        succeeded: Bool,
        serverMessageID: String?
    ) -> OptimisticDeliveryResolution {
        let confirmedID = serverMessageID?.trimmingCharacters(in: .whitespacesAndNewlines)
        return OptimisticDeliveryResolution(
            messageID: succeeded && !(confirmedID?.isEmpty ?? true) ? (confirmedID ?? localID) : localID,
            pending: false,
            failed: !succeeded)
    }
}
