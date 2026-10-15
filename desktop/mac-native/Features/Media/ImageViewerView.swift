import Cocoa
import SwiftUI
@preconcurrency import Vision

struct RemoteMediaImageView: View {
    let url: String
    let label: String
    var maxWidth: CGFloat = 320
    var maxHeight: CGFloat = 360
    var declaredAspectRatio: CGFloat? = nil
    var aspectMode: ContentMode = .fit
    var isZoomable: Bool = true
    @StateObject private var loader = ImageLoader()

    var body: some View {
        Group {
            if let image = loader.image {
                ZoomableMessageImage(
                    image: image,
                    maxWidth: maxWidth,
                    maxHeight: maxHeight,
                    declaredAspectRatio: declaredAspectRatio,
                    aspectMode: aspectMode,
                    isInteractive: isZoomable)
            } else {
                VStack(spacing: 7) {
                    Image(systemName: "photo")
                        .font(.system(size: 24))
                    Text(label)
                        .font(.system(size: 13, weight: .medium))
                }
                .foregroundColor(.secondary)
                .frame(width: 170, height: 110)
                .background(EnterpriseTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
        .task(id: url) { loader.load(urlStr: url) }
    }
}

struct ImageViewerView: View {
    let image: NSImage
    var automaticallyRecognizeText: Bool = false
    @Environment(\.dismiss) private var dismiss
    @State private var recognizedText: String = ""
    @State private var isRecognizing: Bool = false
    @State private var hasRecognized: Bool = false
    @State private var showCopiedAlert: Bool = false
    @State private var copyFeedbackText: String = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                // Copy Image Button
                Button(action: copyImage) {
                    HStack(spacing: 5) {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 12))
                        Text(I18n.shared.t("copy_image"))
                            .font(.system(size: 12, weight: .medium))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(EnterpriseTheme.raisedSurface)
                    .cornerRadius(6)
                }
                .buttonStyle(PlainButtonStyle())
                .help(I18n.shared.t("copy_image_tooltip"))

                // OCR Recognize Text Button
                Button(action: recognizeTextFromImage) {
                    HStack(spacing: 5) {
                        if isRecognizing {
                            ProgressView().controlSize(.small).scaleEffect(0.7)
                        } else {
                            Image(systemName: "text.viewfinder")
                                .font(.system(size: 12))
                        }
                        Text(hasRecognized ? I18n.shared.t("ocr_recognize_retry") : I18n.shared.t("ocr_recognize"))
                            .font(.system(size: 12, weight: .medium))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(EnterpriseTheme.raisedSurface)
                    .cornerRadius(6)
                }
                .buttonStyle(PlainButtonStyle())
                .disabled(isRecognizing)
                .help(I18n.shared.t("ocr_recognize_tooltip"))

                if !recognizedText.isEmpty {
                    Button(action: copyRecognizedText) {
                        HStack(spacing: 5) {
                            Image(systemName: "text.badge.checkmark")
                                .font(.system(size: 12))
                            Text(I18n.shared.t("copy_recognized_text"))
                                .font(.system(size: 12, weight: .semibold))
                        }
                        .foregroundColor(EnterpriseTheme.accent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(EnterpriseTheme.accent.opacity(0.12))
                        .cornerRadius(6)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .help(I18n.shared.t("copy_text_tooltip"))
                }

                if showCopiedAlert {
                    Text(copyFeedbackText)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.green)
                        .transition(.opacity)
                }

                Spacer()

                Button(I18n.shared.t("close")) { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(12)
            .background(EnterpriseTheme.canvas)

            Divider().opacity(0.3)

            HSplitView {
                GeometryReader { viewport in
                    Image(nsImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: viewport.size.width, height: viewport.size.height)
                        .padding(16)
                }
                .frame(minWidth: 400)

                if hasRecognized {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(I18n.shared.t("ocr_results"))
                                .font(.system(size: 13, weight: .bold))
                                .foregroundColor(.primary)
                            Spacer()
                            Button(I18n.shared.t("ocr_select_all")) {
                                copyRecognizedText()
                            }
                            .font(.system(size: 11))
                            .buttonStyle(.link)
                        }

                        if recognizedText.isEmpty {
                            Text(I18n.shared.t("ocr_no_text"))
                                .font(.system(size: 12))
                                .foregroundColor(.secondary)
                        } else {
                            ScrollView {
                                Text(recognizedText)
                                    .font(.system(size: 12, design: .monospaced))
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(8)
                                    .background(Color.white.opacity(0.04))
                                    .cornerRadius(6)
                            }
                        }
                    }
                    .padding(12)
                    .frame(minWidth: 240, maxWidth: 360)
                    .background(EnterpriseTheme.surface)
                }
            }
        }
        .frame(minWidth: hasRecognized ? 760 : 640, minHeight: 520)
        .onAppear {
            if automaticallyRecognizeText, !hasRecognized, !isRecognizing {
                recognizeTextFromImage()
            }
        }
    }

    private func copyImage() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([image])
        withAnimation {
            copyFeedbackText = I18n.shared.t("copy_image_success")
            showCopiedAlert = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            withAnimation { showCopiedAlert = false }
        }
    }

    private func copyRecognizedText() {
        guard !recognizedText.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(recognizedText, forType: .string)
        withAnimation {
            copyFeedbackText = I18n.shared.t("copy_text_success")
            showCopiedAlert = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            withAnimation { showCopiedAlert = false }
        }
    }

    private func recognizeTextFromImage() {
        guard let tiffData = image.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiffData),
            let cgImage = bitmap.cgImage
        else {
            return
        }

        isRecognizing = true
        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNRecognizeTextRequest { req, _ in
                let observations = req.results as? [VNRecognizedTextObservation] ?? []
                let strings = observations.compactMap { $0.topCandidates(1).first?.string }
                let result = strings.joined(separator: "\n")
                DispatchQueue.main.async {
                    self.isRecognizing = false
                    self.hasRecognized = true
                    self.recognizedText = result
                }
            }
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hant", "zh-Hans", "en-US", "ja"]
            request.usesLanguageCorrection = true

            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            try? handler.perform([request])
        }
    }
}

struct ZoomableMessageImage: View {
    let image: NSImage
    var maxWidth: CGFloat = 320
    var maxHeight: CGFloat = 360
    var declaredAspectRatio: CGFloat? = nil
    var aspectMode: ContentMode = .fit
    var isInteractive: Bool = true
    var onOpen: () -> Void = {}
    @State private var isPresented = false
    @State private var recognizeOnOpen = false

    private var displaySize: CGSize {
        if let ratio = declaredAspectRatio, ratio.isFinite, ratio > 0 {
            let width = min(maxWidth, maxHeight * ratio)
            return CGSize(width: floor(width), height: floor(width / ratio))
        }
        let bestRepresentation = image.representations.max {
            ($0.pixelsWide * $0.pixelsHigh) < ($1.pixelsWide * $1.pixelsHigh)
        }
        let width = max(1, CGFloat(bestRepresentation?.pixelsWide ?? Int(image.size.width)))
        let height = max(1, CGFloat(bestRepresentation?.pixelsHigh ?? Int(image.size.height)))
        let scale = min(1, min(maxWidth / width, maxHeight / height))
        return CGSize(width: floor(width * scale), height: floor(height * scale))
    }

    @ViewBuilder
    var body: some View {
        Group {
            if isInteractive {
                Button {
                    recognizeOnOpen = false
                    onOpen()
                    isPresented = true
                } label: {
                    renderedImage
                }
                .buttonStyle(.plain)
                .help(I18n.shared.t("image_open"))
                .accessibilityLabel(I18n.shared.t("image_open_accessibility"))
            } else {
                renderedImage
            }
        }
        .contextMenu {
            Button {
                recognizeOnOpen = true
                onOpen()
                isPresented = true
            } label: {
                Label(I18n.shared.t("ocr_recognize"), systemImage: "text.viewfinder")
            }
        }
        .sheet(isPresented: $isPresented) {
            ImageViewerView(
                image: image,
                automaticallyRecognizeText: recognizeOnOpen)
        }
        .onChange(of: isPresented) { _, presented in
            if !presented { recognizeOnOpen = false }
        }
    }

    private var renderedImage: some View {
        Image(nsImage: image)
            .resizable()
            .aspectRatio(contentMode: aspectMode)
            .frame(width: displaySize.width, height: displaySize.height)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
