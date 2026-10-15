import AVFoundation
import Cocoa
import PhotosUI
import Speech
import SwiftUI
import UniformTypeIdentifiers

extension Notification.Name {
    static let yomiWillSwitchChat = Notification.Name("dev.rikai.yomi.willSwitchChat")
}

struct ConversationLoadingSkeleton: View {
    let i18n: I18n

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(i18n.t("loading_messages"))
                    .font(.system(size: EnterpriseTheme.Typography.status, weight: .semibold))
                    .foregroundColor(.secondary)
            }
            skeleton(width: 250, height: 46, lineWidth: 148, opacity: 0.75)
            skeleton(width: 190, height: 42, lineWidth: 112, opacity: 0.55)
            Spacer()
        }
        .padding(EnterpriseTheme.contentPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(EnterpriseTheme.canvas)
    }

    private func skeleton(width: CGFloat, height: CGFloat, lineWidth: CGFloat, opacity: Double) -> some View {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(EnterpriseTheme.raisedSurface.opacity(opacity))
            .frame(width: width, height: height)
            .overlay(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(Color.secondary.opacity(0.12))
                    .frame(width: lineWidth, height: 10)
                    .padding(.horizontal, 16)
            }
    }
}

enum ComposerAttachmentStore {
    static func stageJPEG(_ data: Data) throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("yomi-image-\(UUID().uuidString).jpg")
        try data.write(to: url, options: .atomic)
        return url
    }

    static func removeIfTemporary(_ url: URL) {
        guard url.path.hasPrefix(NSTemporaryDirectory()) else { return }
        try? FileManager.default.removeItem(at: url)
    }
}

// MARK: - Voice dictation

final class CameraCaptureController: NSObject, ObservableObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
    @Published var capturedData: Data?
    @Published var isReady = false
    @Published var errorMessage: String?
    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private var configured = false

    func start() {
        guard !configured else {
            if !session.isRunning { DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() } }
            return
        }
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard granted else {
                    self.errorMessage = "相機未獲授權，請在系統設定中允許 Yomi 使用相機。"
                    return
                }
                self.configure()
            }
        }
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            errorMessage = "找不到可用的相機。"
            return
        }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            session.beginConfiguration()
            if session.canAddInput(input) { session.addInput(input) }
            if session.canAddOutput(output) { session.addOutput(output) }
            session.commitConfiguration()
            configured = true
            isReady = true
            DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
        } catch {
            errorMessage = "無法啟動相機。"
        }
    }

    func capture() {
        guard isReady else { return }
        output.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
    }

    func stop() {
        if session.isRunning { DispatchQueue.global(qos: .userInitiated).async { self.session.stopRunning() } }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        guard error == nil, let data = photo.fileDataRepresentation() else { return }
        DispatchQueue.main.async { self.capturedData = data }
    }

    deinit { stop() }
}

struct CameraPreviewView: NSViewRepresentable {
    @ObservedObject var controller: CameraCaptureController

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        let preview = AVCaptureVideoPreviewLayer(session: controller.session)
        preview.videoGravity = .resizeAspectFill
        view.layer?.addSublayer(preview)
        context.coordinator.preview = preview
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.preview?.frame = nsView.bounds
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var preview: AVCaptureVideoPreviewLayer? }
}

struct CameraCapturePopover: View {
    @ObservedObject var controller: CameraCaptureController
    let onSend: (Data) -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            if let data = controller.capturedData, let image = NSImage(data: data) {
                Image(nsImage: image).resizable().aspectRatio(contentMode: .fit).frame(width: 320, height: 220)
                HStack {
                    Button("重拍") { controller.capturedData = nil }
                    Button("送出圖片") { onSend(data) }.keyboardShortcut(.defaultAction)
                }
            } else {
                CameraPreviewView(controller: controller).frame(width: 320, height: 220)
                if let error = controller.errorMessage {
                    Text(error).font(.system(size: 13)).foregroundColor(EnterpriseTheme.accent)
                }
                HStack {
                    Button("取消") {
                        controller.stop()
                        onClose()
                    }
                    Button("拍攝") { controller.capture() }.disabled(!controller.isReady).keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(12)
        .onAppear { controller.start() }
        .onDisappear { controller.stop() }
    }
}

enum VoiceInputStatus: Equatable {
    case idle
    case requestingPermission
    case recording
    case denied(String)
    case failed(String)

    var isRecording: Bool {
        if case .recording = self { return true }
        return false
    }
}

/// On-demand speech-to-text only. The controller owns the audio tap and tears
/// it down on every stop/error so Yomi never records in the background.
final class VoiceInputController: NSObject, ObservableObject, @unchecked Sendable {
    @Published private(set) var status: VoiceInputStatus = .idle
    @Published private(set) var transcript: String = ""

    var onTranscript: ((String) -> Void)?
    private var recognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var audioEngine: AVAudioEngine?
    private var baseText = ""

    func toggle(currentText: String) {
        status.isRecording ? stop() : start(currentText: currentText)
    }

    func start(currentText: String) {
        guard !status.isRecording else { return }
        baseText = currentText.trimmingCharacters(in: .whitespacesAndNewlines)
        transcript = currentText
        status = .requestingPermission

        SFSpeechRecognizer.requestAuthorization { [weak self] speechStatus in
            guard let self else { return }
            guard speechStatus == .authorized else {
                DispatchQueue.main.async {
                    // Permission denial is an expected user choice. Keep the
                    // composer quiet and allow a later tap to re-check it.
                    self.status = .idle
                }
                return
            }
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async {
                    guard granted else {
                        self.status = .idle
                        return
                    }
                    self.beginRecording()
                }
            }
        }
    }

    func stop() {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        audioEngine = nil
        if status.isRecording || status == .requestingPermission {
            status = .idle
        }
    }

    private func beginRecording() {
        let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "zh-TW"))
        guard let recognizer, recognizer.isAvailable else {
            status = .failed("語音辨識目前無法使用，請稍後再試。")
            return
        }
        self.recognizer = recognizer

        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        let inputNode = engine.inputNode
        inputNode.removeTap(onBus: 0)
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        guard recordingFormat.sampleRate > 0 else {
            status = .failed("找不到可用的麥克風輸入。")
            return
        }
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak request] buffer, _ in
            request?.append(buffer)
        }
        audioEngine = engine
        recognitionRequest = request
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let spoken = result.bestTranscription.formattedString
                let combined = self.baseText.isEmpty ? spoken : "\(self.baseText) \(spoken)"
                DispatchQueue.main.async {
                    self.transcript = combined
                    self.onTranscript?(combined)
                }
            }
            if error != nil {
                DispatchQueue.main.async {
                    if self.status.isRecording { self.status = .failed("語音辨識中斷，請再試一次。") }
                    self.stop()
                }
            }
        }
        do {
            try engine.start()
            status = .recording
        } catch {
            status = .failed("無法啟動麥克風，請確認系統輸入裝置。")
            stop()
        }
    }

    deinit { stop() }
}

// MARK: - Conversation Detail View (Messages + Quick AI Hub)

struct ComposerAttachment: Identifiable, Equatable {
    let id: UUID
    let url: URL
    let isImage: Bool

    init(url: URL, isImage: Bool) {
        self.id = UUID()
        self.url = url
        self.isImage = isImage
    }

    var fileName: String { url.lastPathComponent }
}

/// A separate task surface keeps LINE's send action unambiguous. Its draft
/// belongs to Yomi and can be closed without changing the LINE reply draft.
struct YomiCommandSurface: View {
    @Binding var prompt: String
    let contextTitle: String
    let onSubmit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("問 Yomi")
                .font(.system(size: 15, weight: .semibold))
            HStack(spacing: 6) {
                Image(systemName: "bubble.left.fill")
                    .foregroundColor(EnterpriseTheme.accent)
                Text("目前對話：\(contextTitle)")
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(EnterpriseTheme.controlFill)
            .clipShape(Capsule())
            TextEditor(text: $prompt)
                .font(.system(size: 14))
                .frame(width: 300, height: 90)
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(EnterpriseTheme.hairline))
                .accessibilityLabel("交代 Yomi")
            HStack {
                Text("Yomi 會先說明要做什麼；需要改檔案或建立 issue 時會先詢問你。")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button("交給 Yomi", action: onSubmit)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(12)
        .frame(width: 340)
    }
}

struct YomiConversationView: View {
    @ObservedObject var state: AppState
    let contextTitle: String

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                Image(systemName: "sparkles").foregroundColor(EnterpriseTheme.accent)
                Text("正在和 Yomi 對話")
                    .font(.system(size: 14, weight: .semibold))
                Text("背景：\(contextTitle)")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
                Spacer()
            }
            .padding(.horizontal, 18)
            .frame(height: 42)
            .background(EnterpriseTheme.accent.opacity(0.07))

            ScrollViewReader { proxy in
                MaterialScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if state.chatMessages.isEmpty {
                            VStack(alignment: .leading, spacing: 7) {
                                Text("你可以直接交代 Yomi")
                                    .font(.system(size: 16, weight: .semibold))
                                Text("例如：整理這個對話的待辦、核對 repo，或準備一則回覆草稿。")
                                    .font(.system(size: 13))
                                    .foregroundColor(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(18)
                        } else {
                            ForEach(state.chatMessages) { message in
                                HStack {
                                    if message.isUser { Spacer(minLength: 48) }
                                    Text(message.text)
                                        .font(.system(size: 14))
                                        .textSelection(.enabled)
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 9)
                                        .background(message.isUser ? EnterpriseTheme.accent : EnterpriseTheme.raisedSurface)
                                        .foregroundColor(message.isUser ? .white : .primary)
                                        .clipShape(RoundedRectangle(cornerRadius: 11))
                                    if !message.isUser { Spacer(minLength: 48) }
                                }
                                .id(message.id)
                            }
                        }
                        if state.isAiThinking {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text("Yomi 正在處理…").font(.system(size: 13)).foregroundColor(.secondary)
                            }
                        }
                    }
                    .padding(18)
                }
                .onChange(of: state.chatMessages.count) { _, _ in
                    if let id = state.chatMessages.last?.id { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
        }
        .background(EnterpriseTheme.canvas)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
