import Cocoa
import SwiftUI

/// A single-page, iPad-style inset-grouped settings surface. Yomi has few
/// preferences, so every value stays visible without category navigation.
struct SettingsDetailView: View {
    @ObservedObject var state: AppState
    @ObservedObject private var updater = DesktopUpdateManager.shared
    var onOpenLogin: () -> Void
    var onBack: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            navigationBar
            ScrollViewReader { proxy in
                MaterialScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        Color.clear.frame(height: 1).id("settings-top")
                        accountSection
                        appearanceSection
                        syncSection
                        aiSection
                        updateSection
                        aboutSection
                        Spacer(minLength: 24)
                    }
                    .frame(maxWidth: 680)
                    .padding(.horizontal, 28)
                    .padding(.top, 22)
                    .frame(maxWidth: .infinity)
                }
                .onAppear { proxy.scrollTo("settings-top", anchor: .top) }
            }
        }
        .background(EnterpriseTheme.canvas)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onExitCommand(perform: onBack)
    }

    private var navigationBar: some View {
        HStack(spacing: 10) {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 34, height: 34)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(state.i18n.t("settings_back_to_conversations"))
            Text(state.i18n.t("settings_title")).font(.system(size: 18, weight: .bold))
            Spacer()
        }
        .padding(.horizontal, 18)
        .frame(height: 58)
        .background(EnterpriseTheme.canvas)
        .overlay(alignment: .bottom) { Divider().opacity(0.28) }
    }

    private var accountSection: some View {
        settingsSection(state.i18n.t("settings_account"), footer: state.i18n.t("settings_account_desc")) {
            HStack(spacing: 12) {
                UserAvatarView(pictureUrl: state.pictureUrl, displayName: state.displayName, mid: state.mid)
                VStack(alignment: .leading, spacing: 3) {
                    Text(state.displayName.isEmpty ? state.i18n.t("not_connected") : state.displayName)
                        .font(.system(size: 15, weight: .semibold))
                    HStack(spacing: 5) {
                        Circle().fill(state.isConnected ? Color.green : Color.secondary).frame(width: 7, height: 7)
                        Text(state.isConnected ? state.i18n.t("settings_connected") : state.i18n.t("settings_not_connected"))
                            .font(.system(size: 13)).foregroundColor(.secondary)
                    }
                }
                Spacer()
                HStack(spacing: 0) {
                    if state.isConnected {
                        Button(state.i18n.t("settings_sign_out")) { state.signOut() }
                            .buttonStyle(.bordered).tint(EnterpriseTheme.accent)
                    } else {
                        Button(state.i18n.t("settings_connect_line")) { onOpenLogin() }
                            .buttonStyle(.borderedProminent)
                    }
                }
                .frame(width: 180, alignment: .trailing)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 70)
        }
    }

    private var appearanceSection: some View {
        settingsSection("\(state.i18n.t("settings_appearance")) · \(state.i18n.t("settings_language"))") {
            settingsRow(state.i18n.t("settings_appearance"), icon: "circle.lefthalf.filled") {
                Picker("", selection: $state.appearance) {
                    ForEach(AppAppearance.allCases) { value in Text(value.label(using: state.i18n)).tag(value) }
                }.labelsHidden().pickerStyle(.menu).frame(width: 150)
            }
            rowDivider
            settingsRow(state.i18n.t("settings_language"), icon: "globe") {
                Picker("", selection: $state.i18n.currentLanguage) {
                    ForEach(AppLanguage.allCases) { value in Text(value.displayName).tag(value) }
                }.labelsHidden().pickerStyle(.menu).frame(width: 150)
            }
        }
    }

    private var syncSection: some View {
        settingsSection(state.i18n.t("settings_sync")) {
            settingsRow(state.i18n.t("settings_sync_frequency"), icon: "arrow.triangle.2.circlepath") {
                Picker("", selection: $state.syncMode) {
                    ForEach(SyncMode.allCases) { value in Text(value.localizedLabel(using: state.i18n)).tag(value) }
                }.labelsHidden().pickerStyle(.menu).frame(width: 150)
            }
            rowDivider
            settingsRow(state.i18n.t("settings_notifications"), icon: "bell") {
                Toggle("", isOn: $state.notificationsEnabled).labelsHidden().toggleStyle(.switch)
            }
            rowDivider
            settingsRow(state.i18n.t("settings_filter_muted"), icon: "bell.slash") {
                Toggle(
                    "",
                    isOn: Binding(
                        get: { state.aiConfig.filterMutedNotifications },
                        set: { value in
                            var config = state.aiConfig
                            config.filterMutedNotifications = value
                            state.updateAiConfig(config)
                        }
                    )
                ).labelsHidden().toggleStyle(.switch)
            }
        }
    }

    private var aiSection: some View {
        settingsSection(state.i18n.t("settings_ai"), footer: state.i18n.t("settings_ai_desc")) {
            settingsRow(state.i18n.t("settings_ai_engine"), icon: "brain") {
                Picker(
                    "",
                    selection: Binding(
                        get: { state.aiConfig.selectedProvider },
                        set: { value in
                            var config = state.aiConfig
                            config.selectedProvider = value
                            state.updateAiConfig(config)
                        }
                    )
                ) {
                    Text(state.i18n.t("settings_ai_auto")).tag(AiProviderType.autoDetect)
                    Text(state.i18n.t("settings_ai_yomi")).tag(AiProviderType.yomiZeroConfig)
                    Text(state.i18n.t("settings_ai_agent")).tag(AiProviderType.claudeCli)
                }.labelsHidden().pickerStyle(.menu).frame(width: 150)
            }
            rowDivider
            settingsRow(state.i18n.t("settings_read_only_approval"), icon: "checkmark.shield") {
                Button(String(format: state.i18n.t("settings_clear_approvals"), AgentApprovalPolicyStore.count)) {
                    state.clearPermanentReadOnlyApprovals()
                }
                .buttonStyle(.bordered)
                .disabled(AgentApprovalPolicyStore.count == 0)
            }
        }
    }

    private var updateSection: some View {
        settingsSection(state.i18n.t("updates_title")) {
            settingsRow(state.i18n.t("updates_automatic"), icon: "arrow.triangle.2.circlepath") {
                Toggle("", isOn: $updater.automaticallyChecksForUpdates)
                    .labelsHidden()
                    .toggleStyle(.switch)
            }
            rowDivider
            settingsRow(updater.statusText, icon: "arrow.down.circle") {
                Button(state.i18n.t(updater.availableVersion == nil ? "updates_check" : "updates_download")) {
                    updater.openAvailableUpdate()
                }
                .buttonStyle(.bordered)
                .disabled(updater.isChecking)
            }
        }
    }

    private var aboutSection: some View {
        settingsSection(state.i18n.t("settings_about")) {
            HStack(spacing: 12) {
                Image(nsImage: NSApp.applicationIconImage ?? NSImage())
                    .resizable().frame(width: 42, height: 42).cornerRadius(10)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Yomi").font(.system(size: 15, weight: .semibold))
                    Text(
                        "\(state.i18n.t("about_version")) "
                            + (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0")
                    )
                    .font(.system(size: 12)).foregroundColor(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 16).frame(minHeight: 66)
            rowDivider
            linkRow(state.i18n.t("about_privacy"), url: "https://rikaidev.github.io/yomi/privacy/")
            rowDivider
            linkRow(state.i18n.t("about_open_source"), url: "https://github.com/rikaidev/yomi")
            rowDivider
            linkRow(state.i18n.t("about_support"), url: "https://github.com/rikaidev/yomi/issues")
        }
    }

    private func settingsSection<Content: View>(_ title: String, footer: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 14, weight: .semibold)).padding(.leading, 4)
            VStack(spacing: 0) { content() }
                .background(EnterpriseTheme.raisedSurface)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(EnterpriseTheme.hairline))
            if let footer {
                Text(footer).font(.system(size: 12)).foregroundColor(.secondary).padding(.horizontal, 4)
            }
        }
    }

    private func settingsRow<Trailing: View>(_ title: String, icon: String, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: 11) {
            Image(systemName: icon).foregroundColor(EnterpriseTheme.accent).frame(width: 24)
            Text(title).font(.system(size: 14, weight: .medium))
            Spacer()
            HStack(spacing: 0) { trailing() }
                .frame(width: 180, alignment: .trailing)
        }
        .padding(.horizontal, 16)
        .frame(height: 54)
    }

    private var rowDivider: some View {
        Divider().padding(.leading, 51).opacity(0.45)
    }

    private func linkRow(_ title: String, url: String) -> some View {
        Link(destination: URL(string: url)!) {
            HStack {
                Text(title).font(.system(size: 14, weight: .medium)).foregroundColor(.primary)
                Spacer()
                Image(systemName: "arrow.up.right").font(.system(size: 11, weight: .semibold)).foregroundColor(.secondary)
            }
            .padding(.horizontal, 16).frame(height: 50)
        }
    }
}
