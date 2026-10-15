import Cocoa
import SwiftUI

private struct FlexCarouselHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct LineFlexImagemapView: View {
    let document: LineFlexMessageDocument
    let onAction: (LineFlexMessageAction) -> Void
    @StateObject private var imageLoader = ImageLoader()

    private var displayWidth: CGFloat {
        guard let width = document.width, let height = document.height,
            width > 0, height > 0
        else { return 320 }
        return min(320, 360 * CGFloat(width / height))
    }
    private var displayHeight: CGFloat {
        guard let width = document.width, let height = document.height, width > 0 else {
            return 240
        }
        return displayWidth * CGFloat(height / width)
    }

    var body: some View {
        ZStack {
            if let image = imageLoader.image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: displayWidth, height: displayHeight)
                    .clipped()
            } else if imageLoader.failed {
                Button {
                    if let imageUrl = document.imageUrl { imageLoader.load(urlStr: imageUrl) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 20, weight: .semibold))
                        .frame(width: displayWidth, height: displayHeight)
                        .background(EnterpriseTheme.surface)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(I18n.shared.t("image_retry"))
            } else {
                ProgressView().frame(width: displayWidth, height: displayHeight)
            }
            GeometryReader { geometry in
                Rectangle()
                    .fill(Color.black.opacity(0.001))
                    .contentShape(Rectangle())
                    .gesture(
                        SpatialTapGesture().onEnded { value in
                            guard let width = document.width, let height = document.height,
                                geometry.size.width > 0, geometry.size.height > 0
                            else { return }
                            let x = value.location.x * width / geometry.size.width
                            let y = value.location.y * height / geometry.size.height
                            guard
                                let region = document.regions.first(where: {
                                    x >= $0.x && x < $0.x + $0.width
                                        && y >= $0.y && y < $0.y + $0.height
                                })
                            else { return }
                            onAction(region.action)
                        }
                    )
            }
        }
        .frame(width: displayWidth, height: displayHeight)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .task(id: document.imageUrl) {
            if let imageUrl = document.imageUrl { imageLoader.load(urlStr: imageUrl) }
        }
    }
}

private struct LineFlexNodeView: View {
    let node: LineFlexMessageNode
    let onAction: (LineFlexMessageAction) -> Void
    var availableWidth: CGFloat = 320
    var isInCarousel: Bool = false
    @State private var carouselHeight: CGFloat = 0
    @State private var carouselPosition: Int? = 0

    private var resolvedWidth: CGFloat? {
        if let points = node.resolved.widthPoints { return CGFloat(points) }
        if let fraction = node.resolved.widthFraction { return availableWidth * CGFloat(fraction) }
        return nil
    }
    private var resolvedMaxWidth: CGFloat? {
        if let points = node.resolved.maxWidthPoints { return CGFloat(points) }
        if let fraction = node.resolved.maxWidthFraction { return availableWidth * CGFloat(fraction) }
        return nil
    }
    private var resolvedHeight: CGFloat? {
        node.resolved.heightPoints.map { CGFloat($0) }
    }
    private var resolvedMaxHeight: CGFloat? {
        node.resolved.maxHeightPoints.map { CGFloat($0) }
    }

    private var fontSize: CGFloat { CGFloat(node.resolved.fontSize) }

    private var contentPadding: EdgeInsets {
        return EdgeInsets(
            top: CGFloat(node.resolved.paddingTop),
            leading: CGFloat(node.resolved.paddingStart),
            bottom: CGFloat(node.resolved.paddingBottom),
            trailing: CGFloat(node.resolved.paddingEnd))
    }

    private var buttonHeight: CGFloat { CGFloat(node.resolved.buttonHeight) }

    private func color(_ value: String?) -> Color? {
        guard let value, value.hasPrefix("#") else { return nil }
        let hex = String(value.dropFirst())
        guard hex.count == 6 || hex.count == 8, let raw = UInt64(hex, radix: 16) else { return nil }
        let red = Double((raw >> (hex.count == 8 ? 24 : 16)) & 0xff) / 255
        let green = Double((raw >> (hex.count == 8 ? 16 : 8)) & 0xff) / 255
        let blue = Double((raw >> (hex.count == 8 ? 8 : 0)) & 0xff) / 255
        let alpha = hex.count == 8 ? Double(raw & 0xff) / 255 : 1
        return Color(red: red, green: green, blue: blue, opacity: alpha)
    }

    private var boxAlignment: HorizontalAlignment {
        switch node.alignItems {
        case "center": return .center
        case "flex-end": return .trailing
        default: return .leading
        }
    }

    private var boxVerticalAlignment: VerticalAlignment {
        node.resolved.axis == "baseline" ? .firstTextBaseline : .top
    }

    private var nodeCornerRadius: CGFloat { CGFloat(node.resolved.cornerRadius) }
    private var nodeBorderWidth: CGFloat { CGFloat(node.resolved.borderWidth) }
    private var textLineLimit: Int? { node.resolved.lineLimit }
    private var relativeChildren: [LineFlexMessageNode] {
        node.children.filter { $0.resolved.position != "absolute" }
    }
    private var absoluteChildren: [LineFlexMessageNode] {
        node.children.filter { $0.resolved.position == "absolute" }
    }

    private func absoluteAlignment(_ child: LineFlexMessageNode) -> Alignment {
        Alignment(
            horizontal: child.resolved.offsetEnd != nil ? .trailing : .leading,
            vertical: child.resolved.offsetBottom != nil ? .bottom : .top)
    }

    private var gradientPoints: (UnitPoint, UnitPoint) {
        let radians = ((node.background?.angle ?? 0) - 90) * .pi / 180
        let dx = cos(radians) / 2
        let dy = sin(radians) / 2
        return (
            UnitPoint(x: 0.5 - dx, y: 0.5 - dy),
            UnitPoint(x: 0.5 + dx, y: 0.5 + dy)
        )
    }

    @ViewBuilder
    private var nodeBackground: some View {
        if let gradient = node.background {
            let stops: [Gradient.Stop] = [
                .init(color: color(gradient.startColor) ?? .clear, location: 0),
                gradient.centerColor.map {
                    .init(
                        color: color($0) ?? .clear,
                        location: gradient.centerPosition ?? 0.5)
                },
                .init(color: color(gradient.endColor) ?? .clear, location: 1),
            ].compactMap { $0 }
            LinearGradient(
                stops: stops,
                startPoint: gradientPoints.0,
                endPoint: gradientPoints.1)
        } else {
            color(node.backgroundColor) ?? Color.clear
        }
    }

    private var imageAspectRatio: CGFloat? {
        CGFloat(node.resolved.aspectRatio)
    }

    @ViewBuilder
    var body: some View {
        switch node.type {
        case "text", "span":
            if node.children.isEmpty {
                Text(node.text ?? "")
                    .font(.system(size: fontSize, weight: node.resolved.fontWeight == 700 ? .bold : .regular))
                    .foregroundColor(color(node.color) ?? .primary)
                    .strikethrough(node.decoration == "line-through")
                    .underline(node.decoration == "underline")
                    .lineLimit(textLineLimit)
                    .fixedSize(horizontal: false, vertical: node.wrap == true)
                    .frame(maxWidth: .infinity, alignment: node.align == "center" ? .center : .leading)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    ForEach(Array(node.children.enumerated()), id: \.offset) { _, span in
                        LineFlexNodeView(
                            node: span,
                            onAction: onAction,
                            availableWidth: availableWidth,
                            isInCarousel: isInCarousel)
                    }
                }
            }
        case "image", "video", "icon":
            if let url = node.url {
                RemoteMediaImageView(
                    url: url,
                    label: I18n.shared.t("flex_media_loading"),
                    maxWidth: node.type == "icon" ? min(fontSize, 40) : availableWidth,
                    maxHeight: 360,
                    declaredAspectRatio: imageAspectRatio ?? 1,
                    aspectMode: node.resolved.contentMode == "cover" ? .fill : .fit,
                    isZoomable: !isInCarousel
                )
                .onTapGesture {
                    if let action = node.action { onAction(action) }
                }
            }
        case "button":
            if let action = node.action {
                Button(
                    action.label.isEmpty
                        ? (node.text ?? I18n.shared.t("flex_action_open")) : action.label
                ) {
                    onAction(action)
                }
                .buttonStyle(.plain)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(
                    node.resolved.buttonStyle == "primary" ? .white : color(node.color) ?? EnterpriseTheme.accent
                )
                .frame(maxWidth: .infinity)
                .frame(height: buttonHeight)
                .background(
                    node.resolved.buttonStyle == "primary"
                        ? color(node.color) ?? EnterpriseTheme.accent
                        : node.resolved.buttonStyle == "secondary"
                            ? EnterpriseTheme.raisedSurface : Color.clear
                )
                .clipShape(RoundedRectangle(cornerRadius: 7))
            }
        case "separator":
            Divider()
        case "spacer":
            Color.clear.frame(height: 8)
        case "carousel":
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 10) {
                    ForEach(Array(relativeChildren.enumerated()), id: \.offset) { index, child in
                        LineFlexNodeView(
                            node: child,
                            onAction: onAction,
                            availableWidth: 286,
                            isInCarousel: true
                        )
                        .frame(width: 286, alignment: .topLeading)
                        .background {
                            GeometryReader { geometry in
                                Color.clear.preference(
                                    key: FlexCarouselHeightKey.self,
                                    value: geometry.size.height)
                            }
                        }
                        .frame(height: carouselHeight > 0 ? carouselHeight : nil, alignment: .top)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .contentShape(RoundedRectangle(cornerRadius: 12))
                        .id(index)
                    }
                }
                .scrollTargetLayout()
                .padding(.trailing, 24)
            }
            .frame(width: 320, alignment: .leading)
            .clipped()
            .scrollTargetBehavior(.viewAligned(limitBehavior: .always))
            .scrollPosition(id: $carouselPosition)
            .simultaneousGesture(
                DragGesture(minimumDistance: 8).onEnded { value in
                    guard abs(value.translation.width) > abs(value.translation.height),
                        abs(value.translation.width) > 28
                    else { return }
                    let current = carouselPosition ?? 0
                    let delta = value.translation.width < 0 ? 1 : -1
                    withAnimation(.easeOut(duration: 0.2)) {
                        carouselPosition = min(
                            max(0, current + delta),
                            max(0, relativeChildren.count - 1))
                    }
                }
            )
            .onPreferenceChange(FlexCarouselHeightKey.self) { carouselHeight = $0 }
        default:
            if node.resolved.axis == "horizontal" || node.resolved.axis == "baseline" {
                HStack(alignment: boxVerticalAlignment, spacing: CGFloat(node.resolved.spacing)) {
                    ForEach(Array(relativeChildren.enumerated()), id: \.offset) { _, child in
                        LineFlexNodeView(
                            node: child,
                            onAction: onAction,
                            availableWidth: availableWidth,
                            isInCarousel: isInCarousel
                        )
                        .padding(.top, CGFloat(child.resolved.marginBefore))
                        .frame(maxWidth: child.resolved.flexGrow > 0 ? .infinity : nil)
                        .layoutPriority(child.resolved.flexGrow)
                        .offset(
                            x: CGFloat((child.resolved.offsetStart ?? 0) - (child.resolved.offsetEnd ?? 0)),
                            y: CGFloat((child.resolved.offsetTop ?? 0) - (child.resolved.offsetBottom ?? 0))
                        )
                        .overlay(alignment: .top) {
                            if child.separator {
                                Rectangle()
                                    .fill(color(child.separatorColor) ?? EnterpriseTheme.hairline)
                                    .frame(height: 1)
                            }
                        }
                    }
                }
                .padding(contentPadding)
                .frame(width: resolvedWidth, height: resolvedHeight)
                .frame(maxWidth: resolvedMaxWidth, maxHeight: resolvedMaxHeight)
                .background { nodeBackground }
                .clipShape(RoundedRectangle(cornerRadius: nodeCornerRadius))
                .overlay {
                    RoundedRectangle(cornerRadius: nodeCornerRadius)
                        .stroke(color(node.borderColor) ?? Color.clear, lineWidth: nodeBorderWidth)
                }
                .overlay {
                    ForEach(Array(absoluteChildren.enumerated()), id: \.offset) { _, child in
                        LineFlexNodeView(
                            node: child,
                            onAction: onAction,
                            availableWidth: availableWidth,
                            isInCarousel: isInCarousel
                        )
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: absoluteAlignment(child))
                        .padding(.top, CGFloat(child.resolved.offsetTop ?? 0))
                        .padding(.bottom, CGFloat(child.resolved.offsetBottom ?? 0))
                        .padding(.leading, CGFloat(child.resolved.offsetStart ?? 0))
                        .padding(.trailing, CGFloat(child.resolved.offsetEnd ?? 0))
                    }
                }
            } else {
                VStack(alignment: boxAlignment, spacing: CGFloat(node.resolved.spacing)) {
                    ForEach(Array(relativeChildren.enumerated()), id: \.offset) { _, child in
                        LineFlexNodeView(
                            node: child,
                            onAction: onAction,
                            availableWidth: availableWidth,
                            isInCarousel: isInCarousel
                        )
                        .padding(.top, CGFloat(child.resolved.marginBefore))
                        .frame(maxHeight: child.resolved.flexGrow > 0 ? .infinity : nil)
                        .layoutPriority(child.resolved.flexGrow)
                        .offset(
                            x: CGFloat((child.resolved.offsetStart ?? 0) - (child.resolved.offsetEnd ?? 0)),
                            y: CGFloat((child.resolved.offsetTop ?? 0) - (child.resolved.offsetBottom ?? 0))
                        )
                        .overlay(alignment: .top) {
                            if child.separator {
                                Rectangle()
                                    .fill(color(child.separatorColor) ?? EnterpriseTheme.hairline)
                                    .frame(height: 1)
                            }
                        }
                    }
                }
                .padding(contentPadding)
                .frame(width: resolvedWidth, height: resolvedHeight)
                .frame(maxWidth: resolvedMaxWidth, maxHeight: resolvedMaxHeight)
                .background { nodeBackground }
                .clipShape(RoundedRectangle(cornerRadius: nodeCornerRadius))
                .overlay {
                    RoundedRectangle(cornerRadius: nodeCornerRadius)
                        .stroke(color(node.borderColor) ?? Color.clear, lineWidth: nodeBorderWidth)
                }
                .overlay {
                    ForEach(Array(absoluteChildren.enumerated()), id: \.offset) { _, child in
                        LineFlexNodeView(
                            node: child,
                            onAction: onAction,
                            availableWidth: availableWidth,
                            isInCarousel: isInCarousel
                        )
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: absoluteAlignment(child))
                        .padding(.top, CGFloat(child.resolved.offsetTop ?? 0))
                        .padding(.bottom, CGFloat(child.resolved.offsetBottom ?? 0))
                        .padding(.leading, CGFloat(child.resolved.offsetStart ?? 0))
                        .padding(.trailing, CGFloat(child.resolved.offsetEnd ?? 0))
                    }
                }
            }
        }
    }
}

struct RichMediaContentView: View {
    @ObservedObject var state: AppState
    let msg: LineChatMessage
    var onMessageAction: (String) -> Void = { _ in }

    private func perform(_ action: LineFlexMessageAction) {
        switch action.type {
        case "uri":
            guard let value = action.uri, let url = URL(string: value),
                ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                NSWorkspace.shared.open(url)
            else {
                state.replyFeedbackIsError = true
                state.replyFeedback = state.i18n.t("rich_menu_action_unsupported")
                return
            }
        case "message":
            if let text = action.text { onMessageAction(text) }
        default:
            state.replyFeedbackIsError = true
            state.replyFeedback = state.i18n.t("rich_menu_action_unsupported")
        }
    }

    @ViewBuilder
    private var richPreview: some View {
        if let url = msg.mediaUrl, !url.isEmpty {
            RemoteMediaImageView(
                url: url,
                label: state.i18n.t("rich_card_loading"),
                maxWidth: 320,
                maxHeight: 240
            )
            .overlay(alignment: .bottomTrailing) {
                if msg.actionUrl != nil {
                    Image(systemName: "arrow.up.right.square.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(7)
                        .background(.black.opacity(0.48), in: Circle())
                        .padding(8)
                }
            }
        } else {
            StaticMediaAttachmentCard(
                mediaType: "rich",
                fileName: state.i18n.t("rich_card_label")
            )
        }
    }

    var body: some View {
        if let document = msg.flexDocument {
            if document.kind == "imagemap", document.width != nil, document.height != nil,
                document.imageUrl != nil
            {
                LineFlexImagemapView(document: document, onAction: perform)
            } else if let root = document.root {
                if root.type == "carousel" {
                    LineFlexNodeView(node: root, onAction: perform)
                        .frame(width: 320, alignment: .leading)
                        .accessibilityIdentifier(
                            "flex-layout-v\(document.layoutVersion ?? 0)-\(document.layoutFingerprint ?? "missing")")
                } else {
                    LineFlexNodeView(node: root, onAction: perform)
                        .frame(maxWidth: 320, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .accessibilityIdentifier(
                            "flex-layout-v\(document.layoutVersion ?? 0)-\(document.layoutFingerprint ?? "missing")")
                }
            } else {
                richCard
            }
        } else {
            if let actionUrl = msg.actionUrl, let url = URL(string: actionUrl),
                url.scheme == "http" || url.scheme == "https"
            {
                Link(destination: url) { richCard }
                    .buttonStyle(.plain)
                    .help(state.i18n.t("rich_card_open_help"))
            } else {
                richCard
            }
        }
    }

    private var richCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            richPreview
            if msg.mediaUrl == nil || msg.mediaUrl?.isEmpty == true,
                !msg.text.isEmpty, msg.text != "[豐富訊息]", msg.text != "[互動卡片]"
            {
                Text(msg.text)
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                    .lineLimit(3)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(EnterpriseTheme.surface)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
