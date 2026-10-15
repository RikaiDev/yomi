import Foundation

extension ConversationDetailView {
    func optimisticOutgoingMessage(
        localID: String,
        text: String,
        contentType: Int = 0,
        mediaType: String? = nil,
        mediaUrl: String? = nil,
        fileName: String? = nil
    ) -> LineChatMessage {
        let resolution = OptimisticDeliveryReducer.begin(localID: localID)
        return outgoingMessage(
            id: resolution.messageID,
            text: text,
            pending: resolution.pending,
            failed: resolution.failed,
            contentType: contentType,
            mediaType: mediaType,
            mediaUrl: mediaUrl,
            fileName: fileName)
    }

    func settledOutgoingMessage(
        localID: String,
        serverMessageID: String?,
        succeeded: Bool,
        text: String,
        contentType: Int = 0,
        mediaType: String? = nil,
        mediaUrl: String? = nil,
        fileName: String? = nil
    ) -> LineChatMessage {
        let resolution = OptimisticDeliveryReducer.settle(
            localID: localID, succeeded: succeeded, serverMessageID: serverMessageID)
        return outgoingMessage(
            id: resolution.messageID,
            text: text,
            pending: resolution.pending,
            failed: resolution.failed,
            contentType: contentType,
            mediaType: mediaType,
            mediaUrl: mediaUrl,
            fileName: fileName)
    }

    func outgoingMessage(
        id: String,
        text: String,
        pending: Bool,
        failed: Bool,
        contentType: Int = 0,
        mediaType: String? = nil,
        mediaUrl: String? = nil,
        fileName: String? = nil
    ) -> LineChatMessage {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return LineChatMessage(
            id: id,
            fromMid: state.mid,
            fromName: state.displayName,
            fromPictureUrl: state.pictureUrl,
            isSelf: true,
            text: text,
            timeString: formatter.string(from: Date()),
            timestamp: Date().timeIntervalSince1970 * 1000,
            contentType: contentType,
            mediaType: mediaType,
            mediaUrl: mediaUrl,
            fileName: fileName,
            isDeliveryFailed: failed,
            isDeliveryPending: pending)
    }
}
