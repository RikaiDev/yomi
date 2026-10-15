import Cocoa
import SwiftUI

struct MediaAttachmentCard: View {
    @ObservedObject var state: AppState
    let chatId: String
    let msg: LineChatMessage
    var mediaTypeOverride: String? = nil
    var fileNameOverride: String? = nil

    private var effectiveMediaType: String {
        mediaTypeOverride ?? msg.mediaType ?? "file"
    }

    private var effectiveFileName: String? {
        fileNameOverride ?? msg.fileName
    }

    private var title: String {
        if let effectiveFileName, !effectiveFileName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return effectiveFileName
        }
        switch effectiveMediaType {
        case "video": return "影片附件"
        case "audio": return "語音附件"
        case "file": return "檔案附件"
        default: return "媒體附件"
        }
    }

    private var icon: String {
        let ext = (effectiveFileName as NSString?)?.pathExtension.lowercased() ?? ""
        switch ext {
        case "zip", "rar", "7z", "tar", "gz", "bz2":
            return "archivebox.fill"
        case "ppt", "pptx", "key":
            return "doc.text.image.fill"
        case "pdf":
            return "doc.richtext.fill"
        case "xls", "xlsx", "numbers", "csv":
            return "tablecells.badge.ellipsis"
        case "doc", "docx", "pages", "txt", "md":
            return "doc.text.fill"
        default:
            switch effectiveMediaType {
            case "video": return "video.fill"
            case "audio": return "waveform"
            case "file": return "doc.fill"
            default: return "paperclip"
            }
        }
    }

    private var isDownloading: Bool {
        state.mediaDownloadingMessageIds.contains(msg.id)
    }

    private var downloadedFileURL: URL? {
        state.mediaDownloadedFileURLs[msg.id]
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(EnterpriseTheme.accent)
                .frame(width: 38, height: 38)
                .background(EnterpriseTheme.accent.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.primary)
                    .lineLimit(2)

                if let downloadedFileURL, FileManager.default.fileExists(atPath: downloadedFileURL.path) {
                    Text(state.i18n.t("downloaded_to_downloads"))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(EnterpriseTheme.accent)
                } else {
                    Text(
                        effectiveMediaType == "video"
                            ? "影片"
                            : effectiveMediaType == "audio" ? "語音訊息" : "附件"
                    )
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
                }
            }

            Spacer(minLength: 8)

            if isDownloading {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 28, height: 28)
            } else if let downloadedFileURL, FileManager.default.fileExists(atPath: downloadedFileURL.path) {
                HStack(spacing: 6) {
                    Button {
                        NSWorkspace.shared.open(downloadedFileURL)
                    } label: {
                        Text(state.i18n.t("open_file"))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(EnterpriseTheme.accent)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(EnterpriseTheme.accent.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)

                    Button {
                        NSWorkspace.shared.activateFileViewerSelecting([downloadedFileURL])
                    } label: {
                        Image(systemName: "magnifyingglass.circle.fill")
                            .font(.system(size: 16))
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help(state.i18n.t("show_in_finder"))
                }
            } else {
                Button {
                    state.downloadAndSaveMediaFile(
                        chatId: chatId,
                        messageId: msg.id,
                        suggestedFileName: effectiveFileName
                    )
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.down.circle.fill")
                        Text(state.i18n.t("download_attachment"))
                    }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(EnterpriseTheme.accent)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(EnterpriseTheme.accent.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minWidth: 220, maxWidth: 340, alignment: .leading)
        .background(EnterpriseTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .contentShape(RoundedRectangle(cornerRadius: 10))
        .onTapGesture {
            if let downloadedFileURL, FileManager.default.fileExists(atPath: downloadedFileURL.path) {
                NSWorkspace.shared.open(downloadedFileURL)
            } else if !isDownloading {
                state.downloadAndSaveMediaFile(
                    chatId: chatId,
                    messageId: msg.id,
                    suggestedFileName: effectiveFileName
                )
            }
        }
        .contextMenu {
            Button {
                state.downloadAndSaveMediaFile(
                    chatId: chatId,
                    messageId: msg.id,
                    suggestedFileName: effectiveFileName,
                    promptSavePanel: false
                )
            } label: {
                Label(state.i18n.t("download_attachment"), systemImage: "arrow.down.circle")
            }

            Button {
                state.downloadAndSaveMediaFile(
                    chatId: chatId,
                    messageId: msg.id,
                    suggestedFileName: effectiveFileName,
                    promptSavePanel: true
                )
            } label: {
                Label(state.i18n.t("save_as"), systemImage: "square.and.arrow.down")
            }

            if let downloadedFileURL, FileManager.default.fileExists(atPath: downloadedFileURL.path) {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([downloadedFileURL])
                } label: {
                    Label(state.i18n.t("show_in_finder"), systemImage: "folder")
                }
            }

            if let name = effectiveFileName, !name.isEmpty {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(name, forType: .string)
                } label: {
                    Label(state.i18n.t("copy_filename"), systemImage: "doc.on.doc")
                }
            }
        }
    }
}

struct StaticMediaAttachmentCard: View {
    let mediaType: String
    let fileName: String?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.fill")
                .font(.system(size: 20, weight: .semibold))
                .foregroundColor(EnterpriseTheme.accent)
                .frame(width: 34, height: 34)
                .background(EnterpriseTheme.accent.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 7))
            VStack(alignment: .leading, spacing: 3) {
                Text(fileName ?? "媒體附件")
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(2)
                Text(
                    mediaType == "video" ? "影片" : mediaType == "audio" ? "語音訊息" : "附件"
                )
                .font(.system(size: 12))
                .foregroundColor(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minWidth: 190, maxWidth: 300, alignment: .leading)
        .background(EnterpriseTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
