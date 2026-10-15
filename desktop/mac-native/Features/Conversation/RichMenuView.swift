import SwiftUI

private struct WidthDrivenRichMenuLayout: Layout {
    let aspectRatio: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let width = max(0, proposal.width ?? subviews.first?.sizeThatFits(.unspecified).width ?? 0)
        return CGSize(width: width, height: aspectRatio > 0 ? width / aspectRatio : 0)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        for subview in subviews {
            subview.place(
                at: bounds.origin,
                anchor: .topLeading,
                proposal: ProposedViewSize(bounds.size)
            )
        }
    }
}

struct BuddyRichMenuView: View {
    let menu: BuddyRichMenu
    let onAction: (BuddyRichMenuArea) -> Void
    @Binding var expanded: Bool
    @StateObject private var imageLoader = ImageLoader()
    @ObservedObject private var i18n = I18n.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            if expanded {
                if let image = imageLoader.image {
                    WidthDrivenRichMenuLayout(
                        aspectRatio: CGFloat(menu.width / menu.height)
                    ) {
                        ZStack {
                            Image(nsImage: image)
                                .resizable()
                                .scaledToFill()
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .clipped()
                            GeometryReader { geometry in
                                Rectangle()
                                    .fill(Color.black.opacity(0.001))
                                    .contentShape(Rectangle())
                                    .gesture(
                                        SpatialTapGesture().onEnded { value in
                                            guard geometry.size.width > 0,
                                                geometry.size.height > 0
                                            else { return }
                                            let menuX =
                                                value.location.x * menu.width
                                                / geometry.size.width
                                            let menuY =
                                                value.location.y * menu.height
                                                / geometry.size.height
                                            guard
                                                let area = menu.areas.first(where: {
                                                    menuX >= $0.x && menuX < $0.x + $0.width
                                                        && menuY >= $0.y
                                                        && menuY < $0.y + $0.height
                                                })
                                            else { return }
                                            onAction(area)
                                        }
                                    )
                                    .accessibilityLabel(menu.label)
                                    .accessibilityHint(i18n.t("rich_menu_switch_hint"))
                            }
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .clipped()
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                } else {
                    WidthDrivenRichMenuLayout(
                        aspectRatio: CGFloat(menu.width / menu.height)
                    ) {
                        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .frame(maxWidth: .infinity)
                }

                Divider().opacity(0.35)
                HStack(spacing: 8) {
                    Text(menu.label)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                    Spacer()
                    Button {
                        withAnimation(MaterialMotion.emphasized(reduceMotion: reduceMotion)) {
                            expanded = false
                        }
                    } label: {
                        Image(systemName: "keyboard")
                            .font(.system(size: 16, weight: .semibold))
                            .frame(width: 36, height: 36)
                    }
                    .buttonStyle(.plain)
                    .help(i18n.t("rich_menu_back_to_input"))
                    .accessibilityLabel(i18n.t("rich_menu_back_to_input"))
                }
                .padding(.horizontal, 10)
                .frame(height: 44)
            }
        }
        .background(EnterpriseTheme.raisedSurface)
        .overlay(alignment: .top) { Divider().opacity(0.3) }
        .onAppear { imageLoader.load(urlStr: menu.imageUrl) }
    }
}
