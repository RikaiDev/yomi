import Cocoa
import SwiftUI

// MARK: - Login Flow View Model & Engine

enum LoginStep: Equatable {
    case inputPhone
    case requestingPin
    case enterPin(pin: String, countdown: Int)
    case waitingApproval(pin: String)
    case success(mid: String)
    case failure(error: String)
}

struct RegionOption: Identifiable, Hashable {
    let id: String
    let code: String
    let prefix: String
    let labelKey: String
    let shortName: String
}

@MainActor
class LoginViewModel: ObservableObject {
    @Published var step: LoginStep = .inputPhone
    @Published var selectedRegion: String = "TW"
    @Published var phoneNumber: String = ""
    @Published var errorMessage: String = ""

    let regions: [RegionOption] = [
        RegionOption(id: "TW", code: "TW", prefix: "+886", labelKey: "login_region_tw", shortName: "TW +886"),
        RegionOption(id: "JP", code: "JP", prefix: "+81", labelKey: "login_region_jp", shortName: "JP +81"),
        RegionOption(id: "TH", code: "TH", prefix: "+66", labelKey: "login_region_th", shortName: "TH +66"),
        RegionOption(id: "ID", code: "ID", prefix: "+62", labelKey: "login_region_id", shortName: "ID +62"),
        RegionOption(id: "US", code: "US", prefix: "+1", labelKey: "login_region_us", shortName: "US +1"),
    ]

    private var loginProcess: Process?
    private var countdownTimer: Timer?
    private var remainingPinSeconds = 0
    var onLoginSuccess: (() -> Void)?

    func startLogin() {
        var rawPhone = phoneNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawPhone.isEmpty else {
            self.errorMessage = I18n.shared.t("login_phone_required")
            self.step = .failure(error: self.errorMessage)
            return
        }

        if selectedRegion == "TW" && rawPhone.hasPrefix("09") {
            rawPhone = "+886" + rawPhone.dropFirst(1)
        } else if !rawPhone.hasPrefix("+") {
            if let regionObj = regions.first(where: { $0.code == selectedRegion }) {
                rawPhone = regionObj.prefix + rawPhone
            }
        }

        withAnimation(.easeInOut(duration: 0.25)) {
            step = .requestingPin
            errorMessage = ""
        }

        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        guard let nodePath = YomiPathResolver.findNodePath() else {
            self.step = .failure(error: I18n.shared.t("login_runtime_missing"))
            return
        }

        guard let paths = YomiPathResolver.findRunMjs() else {
            self.step = .failure(error: I18n.shared.t("login_runtime_missing"))
            return
        }

        let projectDir = paths.projectDir
        let runMjs = paths.runMjs

        let process = Process()
        process.launchPath = nodePath
        process.currentDirectoryPath = projectDir
        process.arguments = [runMjs, "login", "--phone", rawPhone, "--region", selectedRegion]

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        // Match the native desktop bridge: one 0600 user-owned credential
        // file, not a `security` subprocess that requests Keychain access for
        // each fresh login process.
        env["YOMI_NO_KEYCHAIN"] = "1"
        process.environment = env

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        let outHandle = pipe.fileHandleForReading
        outHandle.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let output = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor [weak self] in self?.handleOutput(output) }
        }

        self.loginProcess = process
        do {
            try process.run()
        } catch {
            withAnimation {
                self.step = .failure(error: I18n.shared.t("login_start_failed"))
            }
        }
    }

    private func handleOutput(_ text: String) {
        let lines = text.components(separatedBy: .newlines)
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }

            if trimmed.contains("PIN:") {
                let parts = trimmed.components(separatedBy: "PIN:")
                if parts.count > 1 {
                    let pin = parts[1].trimmingCharacters(in: .whitespaces)
                    startPinCountdown(pin: pin)
                }
            } else if trimmed.contains("Waiting for you to approve") {
                if case .enterPin(let pin, _) = self.step {
                    withAnimation {
                        self.step = .waitingApproval(pin: pin)
                    }
                }
            } else if trimmed.contains("Login successful") {
                stopTimer()
                var mid = "Active"
                if let midPart = trimmed.components(separatedBy: "mid=").dropFirst().first {
                    mid = midPart.components(separatedBy: " ").first ?? "Active"
                }
                withAnimation(.spring()) {
                    self.step = .success(mid: mid)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    self.onLoginSuccess?()
                }
            } else if trimmed.contains("Login failed:") {
                stopTimer()
                let err = trimmed.replacingOccurrences(of: "[Yomi] Login failed:", with: "").trimmingCharacters(in: .whitespaces)
                withAnimation {
                    self.step = .failure(error: err.isEmpty ? I18n.shared.t("login_failed_generic") : err)
                }
            }
        }
    }

    private func startPinCountdown(pin: String) {
        stopTimer()
        remainingPinSeconds = 180
        withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
            self.step = .enterPin(pin: pin, countdown: remainingPinSeconds)
        }

        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.tickPinCountdown() }
        }
    }

    private func tickPinCountdown() {
        remainingPinSeconds -= 1
        if remainingPinSeconds <= 0 {
            stopTimer()
            withAnimation {
                step = .failure(error: I18n.shared.t("login_pin_expired"))
            }
        } else if case .enterPin(let pin, _) = step {
            step = .enterPin(pin: pin, countdown: remainingPinSeconds)
        }
    }

    func cancel() {
        stopTimer()
        loginProcess?.terminate()
        loginProcess = nil
        step = .inputPhone
    }

    private func stopTimer() {
        countdownTimer?.invalidate()
        countdownTimer = nil
    }

    deinit {
        countdownTimer?.invalidate()
        loginProcess?.terminate()
    }
}

// MARK: - Enterprise-Craft Login Window UI

struct YomiLoginPageView: View {
    @ObservedObject var viewModel: LoginViewModel
    @ObservedObject private var i18n = I18n.shared

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    YomiGuardiansMark(mode: .yomi, size: 30)
                    Text(i18n.t("brand_yomi"))
                        .font(.system(size: 17, weight: .bold))
                        .foregroundColor(EnterpriseTheme.text)
                }

                Spacer()

                VStack(alignment: .leading, spacing: 14) {
                    Text(i18n.t("login_workspace_eyebrow"))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(EnterpriseTheme.accent)

                    Text(i18n.t("login_workspace_title"))
                        .font(.system(size: 27, weight: .bold))
                        .foregroundColor(EnterpriseTheme.text)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(i18n.t("login_workspace_detail"))
                        .font(.system(size: 14))
                        .foregroundColor(EnterpriseTheme.secondaryText)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                HStack(alignment: .top, spacing: 9) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(EnterpriseTheme.accent)
                        .padding(.top, 2)
                    Text(i18n.t("login_workspace_security"))
                        .font(.system(size: 12))
                        .foregroundColor(EnterpriseTheme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(28)
            .frame(width: 318, alignment: .leading)
            .background(EnterpriseTheme.surface)

            Rectangle().fill(EnterpriseTheme.hairline).frame(width: 1)

            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(i18n.t("login_eyebrow"))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(EnterpriseTheme.accent)
                    Spacer()
                    Menu {
                        ForEach(AppLanguage.allCases) { language in
                            Button {
                                i18n.currentLanguage = language
                            } label: {
                                HStack {
                                    Text(language.displayName)
                                    if i18n.currentLanguage == language {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(i18n.currentLanguage.displayName)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 8, weight: .bold))
                        }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(EnterpriseTheme.secondaryText)
                        .padding(.horizontal, 8)
                        .frame(height: 28)
                        .background(EnterpriseTheme.raisedSurface)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(EnterpriseTheme.hairline))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)

                }
                .padding(.top, 28)

                LoginSheetView(viewModel: viewModel)
                    .frame(maxWidth: 470, maxHeight: .infinity)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 48)
            .background(EnterpriseTheme.canvas)
        }
        .background(EnterpriseTheme.canvas)
        .frame(minWidth: 840, minHeight: 560)
    }
}

struct LoginSheetView: View {
    @ObservedObject var viewModel: LoginViewModel
    @ObservedObject private var i18n = I18n.shared

    var body: some View {
        Group {
            switch viewModel.step {
            case .inputPhone:
                EnterprisePhoneInputView(viewModel: viewModel, i18n: i18n)
                    .transition(.asymmetric(insertion: .opacity.combined(with: .scale(scale: 0.98)), removal: .opacity))
            case .requestingPin:
                EnterpriseRequestingView(i18n: i18n)
                    .transition(.opacity)
            case .enterPin(let pin, let countdown):
                EnterprisePinDisplayView(pin: pin, countdown: countdown, waitingApproval: false, i18n: i18n)
                    .transition(.asymmetric(insertion: .opacity.combined(with: .move(edge: .trailing)), removal: .opacity))
            case .waitingApproval(let pin):
                EnterprisePinDisplayView(pin: pin, countdown: 0, waitingApproval: true, i18n: i18n)
                    .transition(.opacity)
            case .success(let mid):
                EnterpriseSuccessView(mid: mid, i18n: i18n)
                    .transition(.asymmetric(insertion: .scale.combined(with: .opacity), removal: .opacity))
            case .failure(let error):
                EnterpriseFailureView(error: error, i18n: i18n) {
                    withAnimation { viewModel.step = .inputPhone }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }
}

// MARK: - Enterprise Subviews

struct EnterpriseBrandHero: View {
    var body: some View {
        ZStack {
            Circle().fill(EnterpriseTheme.accent.opacity(0.10)).frame(width: 68, height: 68)
            YomiGuardiansMark(mode: .line, size: 48)
        }
    }
}

struct EnterprisePhoneInputView: View {
    @ObservedObject var viewModel: LoginViewModel
    let i18n: I18n
    @FocusState private var isPhoneFocused: Bool

    var body: some View {
        VStack(spacing: 18) {
            EnterpriseBrandHero()

            VStack(spacing: 7) {
                Text(i18n.t("login_title"))
                    .font(.system(size: 22, weight: .bold))
                    .foregroundColor(EnterpriseTheme.text)

                Text(i18n.t("login_subtitle"))
                    .font(.system(size: 13))
                    .foregroundColor(EnterpriseTheme.secondaryText)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                    .frame(maxWidth: 330)
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 0) {
                    Menu {
                        ForEach(viewModel.regions) { reg in
                            Button(action: {
                                viewModel.selectedRegion = reg.code
                            }) {
                                Text(i18n.t(reg.labelKey))
                            }
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Text(viewModel.regions.first(where: { $0.code == viewModel.selectedRegion })?.shortName ?? "TW +886")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(.primary)
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(.secondary)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(EnterpriseTheme.surface.opacity(0.55))
                        .cornerRadius(6)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .padding(.leading, 6)

                    Rectangle()
                        .fill(EnterpriseTheme.hairline)
                        .frame(width: 1, height: 20)
                        .padding(.horizontal, 6)

                    TextField(i18n.t("login_phone_placeholder"), text: $viewModel.phoneNumber)
                        .textFieldStyle(PlainTextFieldStyle())
                        .font(.system(size: 14.5, weight: .medium, design: .monospaced))
                        .focused($isPhoneFocused)
                        .padding(.vertical, 9)
                        .padding(.trailing, 10)
                        .onSubmit {
                            viewModel.startLogin()
                        }
                }
                .background(EnterpriseTheme.controlFill)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(
                            isPhoneFocused ? EnterpriseTheme.accent : EnterpriseTheme.lineStrong,
                            lineWidth: isPhoneFocused ? 1.5 : 1
                        )
                )

                HStack(spacing: 5) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 10.5))
                        .foregroundColor(EnterpriseTheme.accent)
                    Text(i18n.t("login_security_note"))
                        .font(.system(size: 10.5))
                        .foregroundColor(EnterpriseTheme.secondaryText)
                }
                .padding(.leading, 2)
            }
            .padding(.top, 2)

            Button(action: {
                viewModel.startLogin()
            }) {
                HStack(spacing: 7) {
                    Text(i18n.t("login_request_pin"))
                        .font(.system(size: 13.5, weight: .semibold))
                    Image(systemName: "arrow.right")
                        .font(.system(size: 12, weight: .bold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(EnterpriseTheme.selected)
                .foregroundColor(EnterpriseTheme.selectedText)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
            .buttonStyle(PlainButtonStyle())
            .padding(.top, 2)
        }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                isPhoneFocused = true
            }
        }
    }
}

struct EnterpriseRequestingView: View {
    let i18n: I18n

    var body: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle()
                    .stroke(Color.white.opacity(0.1), lineWidth: 3)
                    .frame(width: 52, height: 52)
                ProgressView()
                    .scaleEffect(1.1)
            }

            VStack(spacing: 5) {
                Text(i18n.t("login_connecting_title"))
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.primary)
                Text(i18n.t("login_connecting_detail"))
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxHeight: .infinity)
    }
}

struct EnterprisePinDisplayView: View {
    let pin: String
    let countdown: Int
    let waitingApproval: Bool
    let i18n: I18n

    var body: some View {
        VStack(spacing: 18) {
            VStack(spacing: 4) {
                Text(i18n.t(waitingApproval ? "login_approve_title" : "login_pin_title"))
                    .font(.system(size: 17, weight: .bold))
                    .foregroundColor(.primary)

                Text(i18n.t(waitingApproval ? "login_approve_detail" : "login_pin_detail"))
                    .font(.system(size: 12.5))
                    .foregroundColor(.secondary)
            }

            HStack(spacing: 11) {
                ForEach(Array(pin), id: \.self) { char in
                    Text(String(char))
                        .font(.system(size: 32, weight: .bold, design: .monospaced))
                        .foregroundColor(EnterpriseTheme.accent)
                        .frame(width: 52, height: 64)
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(EnterpriseTheme.accent.opacity(0.1))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .stroke(
                                            LinearGradient(
                                                gradient: Gradient(colors: [
                                                    EnterpriseTheme.accent.opacity(0.6),
                                                    EnterpriseTheme.accent.opacity(0.2),
                                                ]),
                                                startPoint: .topLeading,
                                                endPoint: .bottomTrailing
                                            ),
                                            lineWidth: 1.5
                                        )
                                )
                                .shadow(color: EnterpriseTheme.accent.opacity(0.2), radius: 6, x: 0, y: 3)
                        )
                }
            }
            .padding(.vertical, 2)

            VStack(alignment: .leading, spacing: 7) {
                EnterpriseStepRow(step: "1", text: i18n.t("login_step_phone"))
                EnterpriseStepRow(step: "2", text: i18n.t("login_step_pin"))
                EnterpriseStepRow(step: "3", text: i18n.t("login_step_approve"))
            }
            .padding(.horizontal, 8)

            HStack(spacing: 8) {
                if waitingApproval {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 7, height: 7)
                    Text(i18n.t("login_approval_progress"))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.green)
                } else {
                    Image(systemName: "timer")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                    Text(String(format: i18n.t("login_expires"), countdown))
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundColor(.secondary)
                }
            }
            .padding(.top, 2)
        }
    }
}

struct EnterpriseStepRow: View {
    let step: String
    let text: String

    var body: some View {
        HStack(spacing: 10) {
            Text(step)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .foregroundColor(.white)
                .frame(width: 18, height: 18)
                .background(Circle().fill(Color.secondary.opacity(0.6)))

            Text(text)
                .font(.system(size: 12.5))
                .foregroundColor(.primary.opacity(0.85))

            Spacer()
        }
    }
}

struct EnterpriseSuccessView: View {
    let mid: String
    let i18n: I18n

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(Color.green.opacity(0.16))
                    .frame(width: 60, height: 60)
                Image(systemName: "checkmark.shield.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundColor(.green)
            }

            VStack(spacing: 5) {
                Text(i18n.t("login_success_title"))
                    .font(.system(size: 17, weight: .bold))
                    .foregroundColor(.primary)

                Text("MID: \(mid)")
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundColor(.secondary)
            }

            Text(i18n.t("login_success_detail"))
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxHeight: .infinity)
    }
}

struct EnterpriseFailureView: View {
    let error: String
    let i18n: I18n
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(EnterpriseTheme.accent.opacity(0.14))
                    .frame(width: 54, height: 54)
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundColor(EnterpriseTheme.accent)
            }

            VStack(spacing: 4) {
                Text(i18n.t("login_failure_title"))
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(.primary)
                Text(error)
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 12)
            }

            Button(action: onRetry) {
                Text(i18n.t("login_try_again"))
                    .font(.system(size: 13, weight: .semibold))
                    .padding(.horizontal, 20)
                    .padding(.vertical, 7)
                    .background(EnterpriseTheme.accent)
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(PlainButtonStyle())
        }
        .frame(maxHeight: .infinity)
    }
}
