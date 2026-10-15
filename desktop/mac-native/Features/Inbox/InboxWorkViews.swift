import Cocoa
import SwiftUI

// MARK: - Work Mode Surfaces

// Split out of InboxView.swift to stay under the 1000-line source limit.
// These are referenced by ChatsDetailView, so they are internal rather
// than file-private.

struct WorkPreviewView: View {
    @ObservedObject var state: AppState
    @State private var isAdjusting = false

    private var draft: YomiWorkContext? { state.workPreview }

    var body: some View {
        MaterialScrollView {
            if let draft {
                VStack(alignment: .leading, spacing: 22) {
                    HStack(alignment: .top, spacing: 14) {
                        Image(systemName: "briefcase.fill")
                            .font(.system(size: 20))
                            .foregroundColor(EnterpriseTheme.accent)
                            .frame(width: 44, height: 44)
                            .background(EnterpriseTheme.accent.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        VStack(alignment: .leading, spacing: 5) {
                            Text(state.i18n.t("work_preview_detected"))
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundColor(EnterpriseTheme.accent)
                            Text(draft.title)
                                .font(.system(size: 24, weight: .bold))
                        }
                        Spacer()
                    }

                    if isAdjusting {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(state.i18n.t("work_preview_review_title"))
                                .font(.system(size: 16, weight: .semibold))
                            Text(state.i18n.t("work_preview_readonly_note"))
                                .font(.system(size: 12)).foregroundColor(.secondary)
                            previewEditorField(
                                state.i18n.t("work_field_title"), placeholder: state.i18n.t("work_field_title_hint"), value: draft.title
                            ) {
                                state.updateWorkPreview(title: $0)
                            }
                            previewEditorField(
                                state.i18n.t("work_field_initiator"), placeholder: state.i18n.t("work_field_initiator_hint"),
                                value: draft.initiator ?? ""
                            ) {
                                state.updateWorkPreview(initiator: $0)
                            }
                            previewEditorField(
                                state.i18n.t("work_field_owner"), placeholder: state.i18n.t("work_field_owner_hint"),
                                value: draft.owner ?? ""
                            ) {
                                state.updateWorkPreview(owner: $0)
                            }
                            previewEditorField(
                                state.i18n.t("work_field_collaborators"), placeholder: state.i18n.t("work_field_list_hint"),
                                value: draft.collaborators.joined(separator: "、")
                            ) {
                                state.updateWorkPreview(collaborators: splitList($0))
                            }
                            previewEditorField(
                                state.i18n.t("work_field_external"), placeholder: state.i18n.t("work_field_external_hint"),
                                value: draft.externalParties.joined(separator: "、")
                            ) {
                                state.updateWorkPreview(externalParties: splitList($0))
                            }
                            previewEditorField(
                                state.i18n.t("work_field_deliverables"), placeholder: state.i18n.t("work_field_list_hint"),
                                value: draft.deliverables.joined(separator: "、")
                            ) {
                                state.updateWorkPreview(deliverables: splitList($0))
                            }
                            previewEditorField(
                                state.i18n.t("work_field_open_questions"), placeholder: state.i18n.t("work_field_list_hint"),
                                value: draft.openQuestions.joined(separator: "、")
                            ) {
                                state.updateWorkPreview(openQuestions: splitList($0))
                            }
                            LabeledContent("狀態") {
                                Picker(
                                    "狀態",
                                    selection: Binding(
                                        get: { state.workPreview?.status ?? "needs_clarification" },
                                        set: { state.updateWorkPreview(status: $0) })
                                ) {
                                    Text(state.i18n.t("work_status_needs_clarification")).tag("needs_clarification")
                                    Text(state.i18n.t("work_status_in_progress")).tag("in_progress")
                                    Text(state.i18n.t("work_status_waiting_reply")).tag("waiting_reply")
                                }
                                .labelsHidden().frame(maxWidth: 460, alignment: .leading)
                            }
                            previewEditorField(
                                state.i18n.t("work_field_next_step"), placeholder: state.i18n.t("work_field_next_step_hint"),
                                value: draft.nextStep
                            ) {
                                state.updateWorkPreview(nextStep: $0)
                            }
                            previewEditorField(
                                state.i18n.t("work_field_ai_actions"), placeholder: state.i18n.t("work_field_list_hint"),
                                value: draft.aiActions.joined(separator: "、")
                            ) {
                                state.updateWorkPreview(aiActions: splitList($0))
                            }
                        }
                        .padding(16)
                        .background(EnterpriseTheme.raisedSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    workPreviewSummary(draft)

                    VStack(alignment: .leading, spacing: 10) {
                        Text(state.i18n.t("work_materials_ready"))
                            .font(.system(size: 17, weight: .semibold))
                        Text(state.i18n.t("work_materials_ready_note"))
                            .font(.system(size: 13))
                            .foregroundColor(.secondary)
                        ForEach(draft.materials) { material in
                            HStack(spacing: 10) {
                                Image(systemName: material.isAttachment ? "paperclip" : "text.bubble")
                                    .foregroundColor(EnterpriseTheme.accent)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(material.text ?? material.ocrText ?? material.mediaType ?? "LINE 訊息")
                                        .font(.system(size: 13, weight: .medium))
                                        .lineLimit(2)
                                    Text(String(format: state.i18n.t("work_material_message_id"), material.messageId))
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundColor(.secondary)
                                }
                                Spacer()
                            }
                            .padding(12)
                            .background(EnterpriseTheme.raisedSurface)
                            .clipShape(RoundedRectangle(cornerRadius: 9))
                        }
                    }

                    HStack(spacing: 10) {
                        Button(action: { state.confirmWorkPreview() }) {
                            HStack(spacing: 6) {
                                Image(systemName: "plus.circle.fill")
                                    .font(.system(size: 13, weight: .semibold))
                                Text(state.i18n.t("work_create_and_start"))
                                    .font(.system(size: 13, weight: .semibold))
                            }
                            .foregroundColor(EnterpriseTheme.selectedText)
                            .padding(.horizontal, 16)
                            .frame(height: 38)
                            .background(EnterpriseTheme.selected)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .buttonStyle(.plain)

                        Button(action: { isAdjusting.toggle() }) {
                            HStack(spacing: 6) {
                                Image(systemName: isAdjusting ? "checkmark" : "slider.horizontal.3")
                                    .font(.system(size: 13, weight: .medium))
                                Text(isAdjusting ? "完成檢查" : "檢查工作內容")
                                    .font(.system(size: 13, weight: .medium))
                            }
                            .foregroundColor(EnterpriseTheme.text)
                            .padding(.horizontal, 14)
                            .frame(height: 38)
                            .background(EnterpriseTheme.raisedSurface)
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(EnterpriseTheme.hairline))
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .buttonStyle(.plain)

                        Button(action: { state.dismissWorkPreview() }) {
                            Text(state.i18n.t("work_ignore"))
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(EnterpriseTheme.secondaryText)
                                .padding(.horizontal, 14)
                                .frame(height: 38)
                                .background(EnterpriseTheme.raisedSurface)
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(EnterpriseTheme.hairline))
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .buttonStyle(.plain)

                        Spacer()

                        Button(action: {
                            let chatId = draft.sourceChatId
                            state.dismissWorkPreview()
                            state.loadChatMessages(chatId: chatId, markReadOnSuccess: true)
                        }) {
                            HStack(spacing: 6) {
                                Image(systemName: "bubble.left.and.text.bubble.right")
                                    .font(.system(size: 13, weight: .medium))
                                Text(state.i18n.t("work_reply_directly"))
                                    .font(.system(size: 13, weight: .medium))
                            }
                            .foregroundColor(EnterpriseTheme.secondaryText)
                            .padding(.horizontal, 14)
                            .frame(height: 38)
                            .background(EnterpriseTheme.raisedSurface)
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(EnterpriseTheme.hairline))
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(32)
                .frame(maxWidth: 900, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private func workPreviewSummary(_ work: YomiWorkContext) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            workField("來源", "\(work.sourceChatName)，\(work.materials.count) 則訊息")
            workField("發起人", work.initiator ?? "待確認")
            workField("負責人", work.owner ?? "待確認")
            workField("協作人", work.collaborators.isEmpty ? "待確認" : work.collaborators.joined(separator: "、"))
            workField("外部對象", work.externalParties.isEmpty ? "待確認" : work.externalParties.joined(separator: "、"))
            workField("交付物", work.deliverables.joined(separator: "、"))
            workField("待確認", work.openQuestions.joined(separator: "、"))
            workField(state.i18n.t("work_field_status"), previewStatusLabel(work.status))
            workField("下一步", work.nextStep)
            workField("AI 可執行", work.aiActions.joined(separator: "、"))
        }
        .padding(18)
        .background(EnterpriseTheme.raisedSurface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func workField(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 16) {
            Text(label).font(.system(size: 13, weight: .semibold)).foregroundColor(.secondary).frame(width: 72, alignment: .leading)
            Text(value).font(.system(size: 14)).textSelection(.enabled)
        }
    }

    private func previewEditorField(
        _ label: String,
        placeholder: String,
        value: String,
        onChange: @escaping (String) -> Void
    ) -> some View {
        LabeledContent(label) {
            TextField(placeholder, text: Binding(get: { value }, set: onChange))
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 460)
        }
    }

    private func splitList(_ value: String) -> [String] {
        value.components(separatedBy: CharacterSet(charactersIn: "、,，\n"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func previewStatusLabel(_ value: String) -> String {
        switch value {
        case "in_progress": return state.i18n.t("work_status_in_progress")
        case "waiting_reply": return state.i18n.t("work_status_waiting_reply")
        default: return state.i18n.t("work_status_needs_clarification")
        }
    }
}

struct WorkModeView: View {
    @ObservedObject var state: AppState
    let work: YomiWorkContext

    var body: some View {
        VStack(spacing: 0) {
            // Work mode is a task surface, not a stretched conversation
            // header. Keep navigation and state on one quiet utility line,
            // then give the work title its own readable line.
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    Button {
                        state.exitWorkMode()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 11, weight: .bold))
                            Text(state.i18n.t("work_back_to_conversation"))
                                .font(.system(size: 13, weight: .medium))
                        }
                        .foregroundColor(EnterpriseTheme.secondaryText)
                        .frame(height: 28)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    Rectangle()
                        .fill(EnterpriseTheme.hairline)
                        .frame(width: 1, height: 16)

                    Text(state.i18n.t("work_mode_title"))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(EnterpriseTheme.accent)

                    Spacer()

                    statusBadge(work.status)
                }

                Text(work.title)
                    .font(.system(size: 20, weight: .bold))
                    .foregroundColor(EnterpriseTheme.text)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 7) {
                    Text(String(format: state.i18n.t("work_source_chat"), work.sourceChatName))
                    Text("·")  // i18n-harness: allow - typographic separator, identical in every locale
                    Text(String(format: state.i18n.t("work_materials_messages_count"), work.materials.count))
                    if work.attachmentCount > 0 {
                        Text("·")  // i18n-harness: allow - typographic separator, identical in every locale
                        Text(String(format: state.i18n.t("work_attachment_count"), work.attachmentCount))
                    }
                    if !work.openQuestions.isEmpty {
                        Text("·")  // i18n-harness: allow - typographic separator, identical in every locale
                        Text(String(format: state.i18n.t("work_open_questions_pending"), work.openQuestions.count))
                            .foregroundColor(EnterpriseTheme.accent)
                    }
                }
                .font(.system(size: 12))
                .foregroundColor(EnterpriseTheme.secondaryText)
                .lineLimit(1)
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(EnterpriseTheme.canvas)

            Divider().opacity(0.3)

            // Main Dual-Column Content
            MaterialScrollView {
                HStack(alignment: .top, spacing: 24) {
                    // Left Column (Hero & Progress)
                    VStack(alignment: .leading, spacing: 18) {
                        // Hero Next Step Card
                        VStack(alignment: .leading, spacing: 14) {
                            HStack {
                                HStack(spacing: 5) {
                                    Image(systemName: "sparkles")
                                        .font(.system(size: 12, weight: .bold))
                                    Text(state.i18n.t("work_suggested_next_action"))
                                        .font(.system(size: 12, weight: .bold))
                                }
                                .foregroundColor(EnterpriseTheme.accent)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(EnterpriseTheme.accent.opacity(0.12))
                                .clipShape(RoundedRectangle(cornerRadius: 6))

                                Spacer()

                                if state.isAiThinking {
                                    HStack(spacing: 6) {
                                        ProgressView().controlSize(.small)
                                        Text(state.i18n.t("work_action_running"))
                                            .font(.system(size: 11.5, weight: .medium))
                                            .foregroundColor(.secondary)
                                    }
                                }
                            }

                            Text(work.nextStep)
                                .font(.system(size: 17, weight: .bold))
                                .foregroundColor(EnterpriseTheme.text)
                                .fixedSize(horizontal: false, vertical: true)

                            HStack(spacing: 8) {
                                metaChip(icon: "bubble.left.and.text.bubble.right", text: "\(work.materials.count) 則對話紀錄")
                                if work.attachmentCount > 0 {
                                    metaChip(icon: "paperclip", text: "\(work.attachmentCount) 份附件")
                                }
                                if let owner = work.owner, !owner.isEmpty {
                                    metaChip(icon: "person.fill", text: "負責：\(owner)")
                                }
                            }

                            Divider().opacity(0.4)

                            HStack {
                                Text(state.i18n.t("work_context_ready_note"))
                                    .font(.system(size: 12))
                                    .foregroundColor(EnterpriseTheme.secondaryText)
                                Spacer()
                                Button(action: { state.executeActiveWorkNextStep(using: .yomiZeroConfig) }) {
                                    HStack(spacing: 6) {
                                        Image(systemName: "sparkles")
                                            .font(.system(size: 12, weight: .bold))
                                        Text(state.i18n.t("work_run_now"))
                                            .font(.system(size: 12.5, weight: .semibold))
                                    }
                                    .foregroundColor(EnterpriseTheme.selectedText)
                                    .padding(.horizontal, 14)
                                    .frame(height: 32)
                                    .background(EnterpriseTheme.selected)
                                    .clipShape(RoundedRectangle(cornerRadius: 7))
                                }
                                .buttonStyle(.plain)
                                .disabled(state.isAiThinking)
                                .opacity(state.isAiThinking ? 0.6 : 1.0)
                            }
                        }
                        .padding(18)
                        .background(cardBackground)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(EnterpriseTheme.hairline, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .shadow(color: Color.black.opacity(0.03), radius: 5, x: 0, y: 2)

                        // Execution Timeline Card
                        VStack(alignment: .leading, spacing: 14) {
                            HStack {
                                Label(state.i18n.t("work_activity_title"), systemImage: "clock.arrow.circlepath")
                                    .font(.system(size: 14, weight: .bold))
                                    .foregroundColor(EnterpriseTheme.accent)
                                Spacer()
                                Text(String(format: state.i18n.t("work_activity_count"), work.activity.count))
                                    .font(.system(size: 11))
                                    .foregroundColor(EnterpriseTheme.secondaryText)
                            }

                            VStack(alignment: .leading, spacing: 10) {
                                ForEach(Array(work.activity.enumerated()), id: \.element.id) { index, entry in
                                    HStack(alignment: .top, spacing: 12) {
                                        VStack(spacing: 0) {
                                            Circle()
                                                .fill(index == 0 ? EnterpriseTheme.accent : EnterpriseTheme.secondaryText.opacity(0.4))
                                                .frame(width: 8, height: 8)
                                                .padding(.top, 4)
                                            if index < work.activity.count - 1 {
                                                Rectangle()
                                                    .fill(EnterpriseTheme.hairline)
                                                    .frame(width: 1.5)
                                                    .frame(maxHeight: .infinity)
                                            }
                                        }
                                        .frame(width: 10)

                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(entry.summary)
                                                .font(.system(size: 13, weight: index == 0 ? .medium : .regular))
                                                .foregroundColor(EnterpriseTheme.text)
                                                .textSelection(.enabled)
                                            Text(activityDate(entry.occurredAt))
                                                .font(.system(size: 11))
                                                .foregroundColor(EnterpriseTheme.secondaryText)
                                        }
                                        Spacer()
                                    }
                                }

                                if state.isAiThinking || !state.codexStatus.isEmpty {
                                    HStack(spacing: 8) {
                                        if state.isAiThinking { ProgressView().controlSize(.small) }
                                        Text(state.codexStatus.isEmpty ? "Agent 正在分析..." : state.codexStatus)
                                            .font(.system(size: 12, weight: .medium))
                                            .foregroundColor(EnterpriseTheme.accent)
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(EnterpriseTheme.accent.opacity(0.08))
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                                }
                            }
                        }
                        .padding(18)
                        .background(cardBackground)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(EnterpriseTheme.hairline, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .shadow(color: Color.black.opacity(0.03), radius: 5, x: 0, y: 2)
                    }
                    .frame(minWidth: 500, maxWidth: .infinity)
                    .layoutPriority(1)

                    // Right Column (Checklist, Info & Context)
                    VStack(alignment: .leading, spacing: 18) {
                        // Checklist Card
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Label(state.i18n.t("work_open_questions_title"), systemImage: "checklist")
                                    .font(.system(size: 14, weight: .bold))
                                    .foregroundColor(EnterpriseTheme.accent)
                                Spacer()
                                Text(String(format: state.i18n.t("work_open_questions_count"), work.openQuestions.count))
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundColor(EnterpriseTheme.accent)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(EnterpriseTheme.accent.opacity(0.12))
                                    .clipShape(Capsule())
                            }

                            if work.openQuestions.isEmpty {
                                Text(state.i18n.t("work_all_clarified"))
                                    .font(.system(size: 12.5))
                                    .foregroundColor(EnterpriseTheme.secondaryText)
                                    .padding(.vertical, 8)
                            } else {
                                VStack(spacing: 6) {
                                    ForEach(work.openQuestions, id: \.self) { question in
                                        HStack(spacing: 9) {
                                            Image(systemName: "circle")
                                                .font(.system(size: 12))
                                                .foregroundColor(EnterpriseTheme.accent)
                                            Text(question)
                                                .font(.system(size: 13, weight: .medium))
                                                .foregroundColor(EnterpriseTheme.text)
                                            Spacer()
                                        }
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 8)
                                        .background(EnterpriseTheme.surface.opacity(0.6))
                                        .overlay(RoundedRectangle(cornerRadius: 7).stroke(EnterpriseTheme.hairline, lineWidth: 1))
                                        .clipShape(RoundedRectangle(cornerRadius: 7))
                                    }
                                }
                            }
                        }
                        .padding(18)
                        .background(cardBackground)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(EnterpriseTheme.hairline, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .shadow(color: Color.black.opacity(0.03), radius: 5, x: 0, y: 2)

                        // Work Metadata Summary Card
                        VStack(alignment: .leading, spacing: 12) {
                            Label(state.i18n.t("work_summary_title"), systemImage: "doc.text")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(EnterpriseTheme.accent)

                            VStack(alignment: .leading, spacing: 8) {
                                metaRow(label: "發起人", value: work.initiator ?? "待確認")
                                metaRow(label: "負責人", value: work.owner ?? "待確認")
                                if !work.collaborators.isEmpty {
                                    metaRow(label: "協作人", value: work.collaborators.joined(separator: "、"))
                                }
                                if !work.deliverables.isEmpty {
                                    metaRow(label: "交付物", value: work.deliverables.joined(separator: "、"))
                                }
                            }
                        }
                        .padding(18)
                        .background(cardBackground)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(EnterpriseTheme.hairline, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .shadow(color: Color.black.opacity(0.03), radius: 5, x: 0, y: 2)

                        // Materials & Evidence Card
                        if !work.materials.isEmpty {
                            VStack(alignment: .leading, spacing: 12) {
                                HStack {
                                    Label(state.i18n.t("work_source_materials"), systemImage: "paperclip")
                                        .font(.system(size: 14, weight: .bold))
                                        .foregroundColor(EnterpriseTheme.accent)
                                    Spacer()
                                    Text(String(format: state.i18n.t("work_materials_count"), work.materials.count))
                                        .font(.system(size: 11))
                                        .foregroundColor(EnterpriseTheme.secondaryText)
                                }

                                VStack(spacing: 6) {
                                    ForEach(work.materials.prefix(3)) { material in
                                        HStack(spacing: 8) {
                                            Image(systemName: material.isAttachment ? "paperclip" : "text.bubble")
                                                .font(.system(size: 11))
                                                .foregroundColor(EnterpriseTheme.accent)
                                                .frame(width: 14)
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(material.text ?? material.ocrText ?? material.mediaType ?? "LINE 訊息")
                                                    .font(.system(size: 12))
                                                    .foregroundColor(EnterpriseTheme.text)
                                                    .lineLimit(1)
                                                if let sender = material.senderName {
                                                    Text(sender)
                                                        .font(.system(size: 10))
                                                        .foregroundColor(EnterpriseTheme.secondaryText)
                                                }
                                            }
                                            Spacer()
                                        }
                                        .padding(.horizontal, 9)
                                        .padding(.vertical, 6)
                                        .background(EnterpriseTheme.surface.opacity(0.5))
                                        .clipShape(RoundedRectangle(cornerRadius: 6))
                                    }
                                }
                            }
                            .padding(18)
                            .background(cardBackground)
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(EnterpriseTheme.hairline, lineWidth: 1))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .shadow(color: Color.black.opacity(0.03), radius: 5, x: 0, y: 2)
                        }
                    }
                    .frame(minWidth: 260, idealWidth: 330, maxWidth: 350)
                }
                .frame(maxWidth: 1240, alignment: .leading)
                .padding(.horizontal, 28)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity, alignment: .center)
            }

            Divider().opacity(0.3)

            // Bottom Action Dock
            HStack(spacing: 12) {
                Button(action: { state.executeActiveWorkNextStep(using: .yomiZeroConfig) }) {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 13, weight: .semibold))
                        Text(state.i18n.t("work_let_yomi_next"))
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundColor(EnterpriseTheme.selectedText)
                    .padding(.horizontal, 16)
                    .frame(height: 38)
                    .background(EnterpriseTheme.selected)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(state.isAiThinking)
                .opacity(state.isAiThinking ? 0.6 : 1.0)

                Button(action: { state.shareActiveWork() }) {
                    HStack(spacing: 6) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 13, weight: .medium))
                        Text(state.i18n.t("work_share_handoff"))
                            .font(.system(size: 13, weight: .medium))
                    }
                    .foregroundColor(EnterpriseTheme.text)
                    .padding(.horizontal, 14)
                    .frame(height: 38)
                    .background(EnterpriseTheme.raisedSurface)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(EnterpriseTheme.hairline))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)

                Spacer()

                Button(action: { state.completeActiveWork() }) {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark")
                            .font(.system(size: 12, weight: .semibold))
                        Text(state.i18n.t("work_mark_complete"))
                            .font(.system(size: 13, weight: .medium))
                    }
                    .foregroundColor(EnterpriseTheme.secondaryText)
                    .padding(.horizontal, 14)
                    .frame(height: 38)
                    .background(EnterpriseTheme.raisedSurface)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(EnterpriseTheme.hairline))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 24)
            .frame(height: 64)
            .background(EnterpriseTheme.surface)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(EnterpriseTheme.canvas)
    }

    private var cardBackground: some View {
        EnterpriseTheme.controlFill
    }

    private func statusBadge(_ status: String) -> some View {
        Text(statusLabel(status))
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(EnterpriseTheme.accent)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(EnterpriseTheme.accent.opacity(0.12))
            .clipShape(Capsule())
    }

    private func metaChip(icon: String, text: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 10))
            Text(text)
                .font(.system(size: 11, weight: .medium))
        }
        .foregroundColor(EnterpriseTheme.secondaryText)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(EnterpriseTheme.surface.opacity(0.8))
        .clipShape(RoundedRectangle(cornerRadius: 5))
    }

    private func metaRow(label: String, value: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(EnterpriseTheme.secondaryText)
                .frame(width: 50, alignment: .leading)
            Text(value)
                .font(.system(size: 12.5, weight: .regular))
                .foregroundColor(EnterpriseTheme.text)
                .lineLimit(2)
            Spacer()
        }
    }

    private func statusLabel(_ value: String) -> String {
        switch value {
        case "in_progress": return state.i18n.t("work_status_in_progress")
        case "waiting_reply": return state.i18n.t("work_status_waiting_reply")
        case "completed": return "已完成"
        default: return state.i18n.t("work_status_needs_clarification")
        }
    }

    private func activityDate(_ milliseconds: Double) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: Date(timeIntervalSince1970: milliseconds / 1000))
    }
}

struct TrackingDetailView: View {
    let candidate: AmbientObservationCandidate
    let onOpenChat: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "waveform.path.ecg.rectangle")
                    .foregroundColor(EnterpriseTheme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(candidate.chatName)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.secondary)
                    Text(candidate.title)
                        .font(.system(size: 18, weight: .semibold))
                        .lineLimit(2)
                }
                Spacer()
                Text(stateLabel)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(EnterpriseTheme.accent)
                    .padding(.horizontal, 9)
                    .frame(height: 28)
                    .background(EnterpriseTheme.accent.opacity(0.1))
                    .clipShape(Capsule())
                Button(I18n.shared.t("close")) { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(18)

            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(candidate.evidence) { evidence in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(evidence.senderName ?? "LINE")
                                    .font(.system(size: 13, weight: .semibold))
                                Spacer()
                                Text(evidenceDate(evidence.sentAt))
                                    .font(.system(size: 12))
                                    .foregroundColor(.secondary)
                            }
                            if let text = evidence.text, !text.isEmpty {
                                Text(text)
                                    .font(.system(size: 14))
                                    .textSelection(.enabled)
                            }
                            if let ocr = evidence.ocrText, !ocr.isEmpty {
                                VStack(alignment: .leading, spacing: 5) {
                                    Label(I18n.shared.t("tracking_image_text"), systemImage: "text.viewfinder")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundColor(EnterpriseTheme.accent)
                                    Text(ocr)
                                        .font(.system(size: 13, design: .monospaced))
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .padding(12)
                                .background(EnterpriseTheme.canvas)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(EnterpriseTheme.raisedSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }
                .padding(18)
            }

            Divider()
            HStack {
                Text(
                    String(
                        format: I18n.shared.t("ambient_observer_evidence_count"),
                        candidate.evidence.count)
                )
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                Spacer()
                Button(I18n.shared.t("tracking_open_chat"), action: onOpenChat)
                    .buttonStyle(.borderedProminent)
            }
            .padding(16)
        }
        .frame(minWidth: 620, minHeight: 520)
    }

    private var stateLabel: String {
        I18n.shared.t("ambient_observer_response_\(candidate.responseState)")
    }

    private func evidenceDate(_ milliseconds: Double) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: Date(timeIntervalSince1970: milliseconds / 1000))
    }
}

struct WorkItemsSection: View {
    @ObservedObject var state: AppState
    let onSelectChat: (String) -> Void

    var activeItems: [AmbientWorkItem] {
        state.workItems.filter { $0.resolutionState != "resolved" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "checklist").foregroundColor(EnterpriseTheme.accent)
                Text(state.i18n.t("work_items_title"))
                    .font(.system(size: 17, weight: .semibold))
                Spacer()
                Text(state.i18n.t("work_items_count").replacingOccurrences(of: "%d", with: String(activeItems.count)))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.secondary)
            }
            ForEach(activeItems.prefix(8)) { item in
                Button {
                    onSelectChat(item.chatId)
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 6) {
                            Text(item.title)
                                .font(.system(size: 13, weight: .semibold))
                                .lineLimit(2)
                            Spacer()
                            Text(state.i18n.t("work_item_resolution_\(item.resolutionState)"))
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundColor(item.resolutionState == "open" ? EnterpriseTheme.accent : .secondary)
                        }
                        HStack(spacing: 8) {
                            Text(item.chatName).font(.system(size: 11.5, weight: .medium))
                            Text(state.i18n.t("work_item_owner_\(item.ownerState)"))
                            Text(Self.timeString(item.updatedAt))
                        }
                        .font(.system(size: 10.5))
                        .foregroundColor(.secondary)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(EnterpriseTheme.canvas.opacity(0.7))
                    .clipShape(RoundedRectangle(cornerRadius: 9))
                }
                .buttonStyle(.plain)
            }
            if activeItems.isEmpty {
                Text(state.i18n.t("work_items_all_resolved"))
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
            }
        }
        .padding(18)
        .background(EnterpriseTheme.raisedSurface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private static func timeString(_ milliseconds: Double) -> String {
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        return DateFormatter.localizedString(from: date, dateStyle: .short, timeStyle: .short)
    }
}
