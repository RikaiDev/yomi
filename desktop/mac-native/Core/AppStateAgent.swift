import Cocoa
import Dispatch
import SwiftUI

extension AppState {

    func syncNow() {
        isSyncing = true
        refreshState()
        refreshInbox(.manual)
        if let sel = selectedChatId {
            loadChatMessages(chatId: sel)
        }
    }

    func perform1ClickMcpIntegration(completion: @escaping (Bool, String) -> Void) {
        isIntegrating = true
        let callback = IntegrationCallbackBox(completion)

        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        guard let nodePath = YomiPathResolver.findNodePath() else {
            self.isIntegrating = false
            completion(false, "Node.js not found.")
            return
        }

        guard let paths = YomiPathResolver.findRunMjs() else {
            self.isIntegrating = false
            completion(false, "Yomi run.mjs script not found.")
            return
        }

        let projectDir = paths.projectDir
        let runMjs = paths.runMjs

        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.launchPath = nodePath
            process.currentDirectoryPath = projectDir
            process.arguments = [runMjs, "setup-mcp"]

            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
            process.environment = env

            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe

            do {
                try process.run()
                process.waitUntilExit()

                DispatchQueue.main.async {
                    self.isIntegrating = false
                    if process.terminationStatus == 0 {
                        self.sendNotification(
                            title: "Claude & Codex Agent Ready",
                            body: "Yomi LINE MCP & Copilot Skill automatically configured!"
                        )
                        callback.call(true, "Successfully configured Claude Cowork & Codex with Yomi Skill.")
                    } else {
                        callback.call(false, "Integration finished with code: \(process.terminationStatus)")
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.isIntegrating = false
                    callback.call(false, error.localizedDescription)
                }
            }
        }
    }

    func copyMcpConfigSnippet() {
        let snippet = """
            {
              "mcpServers": {
                "yomi": {
                  "command": "npx",
                  "args": ["-y", "@rikaidev/yomi"]
                }
              }
            }
            """
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(snippet, forType: .string)
        sendNotification(title: "Yomi MCP Config", body: "JSON configuration snippet copied to clipboard.")
    }

    func sendAiQuery(prompt: String) {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        chatMessages.append(ChatMessageItem(isUser: true, text: trimmed, toolCall: nil))

        let provider = aiConfig.selectedProvider
        if provider == .yomiZeroConfig {
            isAiThinking = true
            executeLocalZeroConfig(prompt: trimmed, toolAction: "Yomi Zero Config")
        } else {
            startCodingToolAgent(prompt: trimmed, provider: provider)
        }
    }

    func startCodingToolAgent(prompt: String, provider: AiProviderType) {
        guard !isAiThinking else { return }
        guard let paths = YomiPathResolver.findRunMjs() else {
            codexStatus = "找不到 Yomi repo cwd，未啟動 coding tool"
            chatMessages.append(ChatMessageItem(isUser: false, text: codexStatus, toolCall: nil))
            return
        }
        let requestedBackend = CodingToolBackendFactory.make(for: provider)
        guard let requestedBackend else {
            codexStatus = "找不到可用的 coding tool；請先安裝並登入。"
            chatMessages.append(ChatMessageItem(isUser: false, text: codexStatus, toolCall: nil))
            return
        }
        if agentBackend?.toolID != requestedBackend.toolID {
            agentBackend?.stop()
            agentBackend = requestedBackend
        }
        guard let backend = agentBackend else { return }
        let toolName = backend.displayName
        isAiThinking = true
        codexApprovalRequest = nil
        codexElicitationRequest = nil
        codexStatus = "正在啟動 \(toolName)…"
        backend.start(prompt: prompt, cwd: paths.projectDir, nodePath: YomiPathResolver.findNodePath(), runMjs: paths.runMjs) {
            [weak self] event in
            Task { @MainActor [weak self] in
                guard let self else { return }
                switch event {
                case .status(let value): self.codexStatus = value
                case .delta(let delta):
                    self.codexStatus = "\(toolName) 串流中"
                    if let index = self.chatMessages.lastIndex(where: { !$0.isUser }) {
                        self.chatMessages[index].text += delta
                    } else {
                        self.chatMessages.append(ChatMessageItem(isUser: false, text: delta, toolCall: toolName))
                    }
                case .approval(let request):
                    self.codexApprovalRequest = request
                    self.codexStatus = "等待使用者核准"
                case .elicitation(let request):
                    self.codexElicitationRequest = request
                    self.codexStatus = "Yomi 需要你的確認"
                case .completed:
                    self.isAiThinking = false
                    self.codexElicitationRequest = nil
                    self.codexStatus = "\(toolName) 已完成"
                case .failure(let error):
                    self.isAiThinking = false
                    self.codexElicitationRequest = nil
                    self.codexStatus = "\(toolName) 失敗"
                    self.chatMessages.append(ChatMessageItem(isUser: false, text: error, toolCall: toolName))
                }
            }
        }
    }

    func cancelCodexAgent() {
        agentBackend?.cancel()
        isAiThinking = false
        codexElicitationRequest = nil
        codexStatus = "已取消"
    }

    func respondToCodexApproval(decision: String) {
        agentBackend?.respondToApproval(decision: decision)
        codexApprovalRequest = nil
        codexStatus = decision == "decline" ? "你已拒絕這項操作，Yomi 正在調整" : "已核准，Yomi 繼續處理"
    }

    func clearPermanentReadOnlyApprovals() {
        AgentApprovalPolicyStore.removeAll()
        replyFeedbackIsError = false
        replyFeedback = i18n.t("agent_readonly_approvals_cleared")
        objectWillChange.send()
    }

    func respondToCodexElicitation(action: String, content: [String: Any] = [:]) {
        guard let request = codexElicitationRequest else { return }
        agentBackend?.respondToElicitation(requestID: request.requestID, action: action, content: content)
        codexElicitationRequest = nil
        codexStatus = action == "accept" ? "Yomi 已收到，繼續處理" : "你已拒絕這項要求，Yomi 正在調整"
    }

    func findCliBinary(named: String) -> String? {
        let home = NSHomeDirectory()
        let paths = [
            "\(home)/.local/bin/\(named)",
            "\(home)/.opencode/bin/\(named)",
            "/opt/homebrew/bin/\(named)",
            "/usr/local/bin/\(named)",
            "/usr/bin/\(named)",
        ]
        for p in paths {
            if FileManager.default.isExecutableFile(atPath: p) {
                return p
            }
        }
        return nil
    }

    private func fetchLineChatContext() -> String {
        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            return ""
        }
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        let process = Process()
        process.launchPath = nodePath
        process.currentDirectoryPath = paths.projectDir
        process.arguments = [paths.runMjs, "summary"]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        process.environment = env
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let raw = String(data: data, encoding: .utf8) ?? ""
            let lines = raw.components(separatedBy: "\n")
            let contentLines = lines.filter { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                return !trimmed.starts(with: "[LINE]") && !trimmed.starts(with: "[AUTH]") && !trimmed.starts(with: "[E2EE]")
                    && !trimmed.starts(with: "[DEBUG]")
            }
            return contentLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return ""
        }
    }

    private func callLocalCliAi(provider: AiProviderType, prompt: String, toolAction: String) {
        DispatchQueue.global(qos: .userInitiated).async {
            let lineContext = self.fetchLineChatContext()
            let contextSection = lineContext.isEmpty ? "" : "\n\n【使用者即時 LINE 對話解密紀錄與狀態】:\n\(lineContext)"
            let userPrompt =
                "你是 Yomi，專為 macOS 設計的 LINE E2EE 智慧助理。目前使用者為 \(self.displayName.isEmpty ? "LINE User" : self.displayName) (MID: \(self.mid))。\(contextSection)\n\n使用者指令/提問: \(prompt)\n\n請根據上述 LINE 訊息與狀況，提供精準、直接且專業的繁體中文分析與建議："

            var candidates: [(name: String, args: [String])] = []

            if provider == .autoDetect {
                if self.findCliBinary(named: "agy") != nil {
                    candidates.append(("agy", ["-p", userPrompt]))
                }
                if self.findCliBinary(named: "claude") != nil {
                    candidates.append(("claude", ["-p", userPrompt]))
                }
                if self.findCliBinary(named: "codex") != nil {
                    candidates.append(("codex", ["exec", userPrompt]))
                }
                if self.findCliBinary(named: "opencode") != nil {
                    candidates.append(("opencode", ["run", userPrompt]))
                }
                if self.findCliBinary(named: "ollama") != nil {
                    candidates.append(("ollama", ["run", "llama3.2", userPrompt]))
                }
            } else {
                switch provider {
                case .antigravityCli:
                    candidates.append(("agy", ["-p", userPrompt]))
                case .claudeCli:
                    candidates.append(("claude", ["-p", userPrompt]))
                case .codexCli:
                    candidates.append(("codex", ["exec", userPrompt]))
                case .opencodeCli:
                    candidates.append(("opencode", ["run", userPrompt]))
                case .ollamaLocal:
                    candidates.append(("ollama", ["run", "llama3.2", userPrompt]))
                default:
                    break
                }
            }

            for candidate in candidates {
                if let binPath = self.findCliBinary(named: candidate.name) {
                    let proc = Process()
                    proc.executableURL = URL(fileURLWithPath: binPath)
                    proc.arguments = candidate.args

                    var env = ProcessInfo.processInfo.environment
                    let home = NSHomeDirectory()
                    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(home)/.local/bin:\(home)/.opencode/bin:" + (env["PATH"] ?? "")
                    proc.environment = env

                    let pipe = Pipe()
                    proc.standardOutput = pipe
                    proc.standardError = pipe
                    proc.standardInput = FileHandle.nullDevice

                    do {
                        try proc.run()
                        let data = pipe.fileHandleForReading.readDataToEndOfFile()
                        proc.waitUntilExit()

                        var output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                        output = output.replacingOccurrences(of: #"\x1B\[[0-9;]*[a-zA-Z]"#, with: "", options: .regularExpression)

                        if proc.terminationStatus == 0 && !output.isEmpty && !output.contains("Failed to authenticate")
                            && !output.contains("OAuth session expired")
                        {
                            let finalOutput = output
                            DispatchQueue.main.async {
                                self.isAiThinking = false
                                self.chatMessages.append(ChatMessageItem(isUser: false, text: finalOutput, toolCall: toolAction))
                            }
                            return
                        }
                    } catch {
                        continue
                    }
                }
            }

            DispatchQueue.main.async {
                self.isAiThinking = false
                if !lineContext.isEmpty {
                    self.chatMessages.append(ChatMessageItem(isUser: false, text: "【本地 LINE 即時紀錄】\n" + lineContext, toolCall: toolAction))
                } else {
                    self.chatMessages.append(
                        ChatMessageItem(
                            isUser: false, text: "本機 AI CLI（如 agy / claude / codex）未就緒或 Session 已過期，請確認終端機登入狀態。", toolCall: toolAction))
                }
            }
        }
    }

    private func executeLocalZeroConfig(prompt: String, toolAction: String) {
        if !self.isConnected {
            self.chatMessages.append(
                ChatMessageItem(
                    isUser: false,
                    text: "尚未連線至 LINE 帳號。請先於選單列點擊「Connect LINE Account」登入。",
                    toolCall: toolAction
                )
            )
            self.isAiThinking = false
            return
        }

        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        guard let nodePath = YomiPathResolver.findNodePath() else {
            self.chatMessages.append(
                ChatMessageItem(
                    isUser: false,
                    text: "無法找到本地 Node.js 執行環境，請確認 Node.js 已安裝。",
                    toolCall: toolAction
                )
            )
            self.isAiThinking = false
            return
        }

        guard let paths = YomiPathResolver.findRunMjs() else {
            self.chatMessages.append(
                ChatMessageItem(
                    isUser: false,
                    text: "無法找到 Yomi 執行腳本 run.mjs",
                    toolCall: toolAction
                )
            )
            self.isAiThinking = false
            return
        }

        let projectDir = paths.projectDir
        let runMjs = paths.runMjs

        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.launchPath = nodePath
            process.currentDirectoryPath = projectDir
            process.arguments = [runMjs, "summary"]

            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
            process.environment = env

            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe

            do {
                try process.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()

                let raw = String(data: data, encoding: .utf8) ?? ""
                // Filter out runtime diagnostic logs, keep formatted summary
                let lines = raw.components(separatedBy: "\n")
                let contentLines = lines.filter { line in
                    let trimmed = line.trimmingCharacters(in: .whitespaces)
                    return !trimmed.starts(with: "[LINE]") && !trimmed.starts(with: "[AUTH]") && !trimmed.starts(with: "[E2EE]")
                        && !trimmed.starts(with: "[DEBUG]")
                }
                let cleanOutput = contentLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)

                DispatchQueue.main.async {
                    self.isAiThinking = false
                    if !cleanOutput.isEmpty {
                        self.chatMessages.append(ChatMessageItem(isUser: false, text: cleanOutput, toolCall: toolAction))
                    } else {
                        self.chatMessages.append(ChatMessageItem(isUser: false, text: "未檢索到近期對話訊息或頻道目前為空。", toolCall: toolAction))
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.isAiThinking = false
                    self.chatMessages.append(
                        ChatMessageItem(isUser: false, text: "執行本地檢索時發生錯誤：\(error.localizedDescription)", toolCall: toolAction))
                }
            }
        }
    }

    func sendNotification(title: String, body: String) {
        guard notificationsEnabled else { return }
        let cleanTitle = title.replacingOccurrences(of: "\"", with: "\\\"")
        let cleanBody = body.replacingOccurrences(of: "\"", with: "\\\"")
        let script = "display notification \"\(cleanBody)\" with title \"\(cleanTitle)\" sound name \"default\""
        let process = Process()
        process.launchPath = "/usr/bin/osascript"
        process.arguments = ["-e", script]
        try? process.run()
    }

    @MainActor
    func signOut() {
        let alert = NSAlert()
        alert.messageText = "Sign Out of Yomi?"
        alert.informativeText = "This will disconnect your LINE account from Yomi."
        alert.addButton(withTitle: "Sign Out")
        alert.addButton(withTitle: "Cancel")
        alert.alertStyle = .warning

        if alert.runModal() == .alertFirstButtonReturn {
            CredentialManager.clearCredentials()
            refreshState()
            sendNotification(title: "Yomi", body: "Signed out successfully.")
        }
    }

    func copyMidToClipboard() {
        guard !mid.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(mid, forType: .string)
        sendNotification(title: "Yomi", body: "MID copied to clipboard: \(mid)")
    }

    func openDocs() {
        if let url = URL(string: "https://rikaidev.github.io/yomi/zh-tw/line-mcp/") {
            NSWorkspace.shared.open(url)
        }
    }

    func openWorkspace() {
        if let url = URL(string: "https://rikaidev.github.io/yomi/") {
            NSWorkspace.shared.open(url)
        }
    }
}
