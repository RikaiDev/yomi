import Cocoa
import Foundation
import Security
import SwiftUI

enum YomiAttentionLearningStore {
    private static let biasKey = "yomi_attention_learned_bias_v1"

    private static func values() -> [String: Int] {
        UserDefaults.standard.dictionary(forKey: biasKey) as? [String: Int] ?? [:]
    }

    static func bias(for id: String) -> Int { values()[id] ?? 0 }
    static func recordPassiveReview(_ id: String) { adjust(id, delta: -4) }
    static func recordReply(_ id: String) { adjust(id, delta: 6) }

    private static func adjust(_ id: String, delta: Int) {
        var next = values()
        next[id] = min(18, max(-18, (next[id] ?? 0) + delta))
        UserDefaults.standard.set(next, forKey: biasKey)
    }
}

/// Stable, non-reversible cache key.  Cache filenames must never contain a
/// media URL, chat id, or other user data.  Four independent FNV lanes keep
/// collisions negligible without adding a crypto framework to the app target.
func yomiStableCacheKey(_ value: String) -> String {
    var lanes: [UInt64] = [
        14_695_981_039_346_656_037,
        1_099_511_628_211 ^ 0x9E37_79B1_85EB_CA87,
        1_099_511_628_211 ^ 0xC2B2_AE3D_27D4_EB4F,
        1_099_511_628_211 ^ 0x1656_67B1_9E37_79F9,
    ]
    for byte in value.utf8 {
        for index in lanes.indices {
            lanes[index] ^= UInt64(byte)
            lanes[index] &*= 1_099_511_628_211 &+ UInt64(index * 2 + 1)
        }
    }
    return lanes.map { String(format: "%016llx", $0) }.joined()
}

// MARK: - Credentials Model

struct LineCredentialsPayload: Codable {
    var lineAuthToken: String?
    var lineCertificate: String?
    var lineRefreshToken: String?
    var lineMid: String?
    var linePhone: String?
    var lineRegion: String?
    var displayName: String?
    var picturePath: String?
    var pictureUrl: String?
    var statusMessage: String?

    enum CodingKeys: String, CodingKey {
        case lineAuthToken = "line_auth_token"
        case lineCertificate = "line_certificate"
        case lineRefreshToken = "line_refresh_token"
        case lineMid = "line_mid"
        case linePhone = "line_phone"
        case lineRegion = "line_region"
        case displayName, picturePath, pictureUrl, statusMessage
    }
}

class CredentialManager {
    static func getCredentialFilePath() -> URL? {
        if let home = ProcessInfo.processInfo.environment["HOME"] {
            return URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/yomi/line-credentials.json")
        }
        return nil
    }

    static func loadCredentials() -> LineCredentialsPayload? {
        // 1. Direct secure user-isolated file read (0 SecurityAgent prompts, sub-millisecond fast)
        if let path = getCredentialFilePath(),
            let data = try? Data(contentsOf: path),
            let decoded = try? JSONDecoder().decode(LineCredentialsPayload.self, from: data),
            let token = decoded.lineAuthToken, !token.isEmpty
        {
            return decoded
        }

        // 2. Fallback to ~/.yomi
        if let home = ProcessInfo.processInfo.environment["HOME"] {
            let fallback = URL(fileURLWithPath: home).appendingPathComponent(".yomi/credentials.json")
            if let data = try? Data(contentsOf: fallback),
                let decoded = try? JSONDecoder().decode(LineCredentialsPayload.self, from: data),
                let token = decoded.lineAuthToken, !token.isEmpty
            {
                return decoded
            }
        }

        return nil
    }

    static func clearCredentials() {
        if let path = getCredentialFilePath() {
            try? FileManager.default.removeItem(at: path)
        }
        if let home = ProcessInfo.processInfo.environment["HOME"] {
            let fallback = URL(fileURLWithPath: home).appendingPathComponent(".yomi/credentials.json")
            try? FileManager.default.removeItem(at: fallback)
        }

        // Clear Keychain asynchronously in background without blocking UI
        DispatchQueue.global(qos: .background).async {
            let services = ["dev.rikai.yomi.credentials", "com.yomi.credentials"]
            for service in services {
                let query: [String: Any] = [
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: service,
                    kSecAttrAccount as String: "line",
                ]
                SecItemDelete(query as CFDictionary)
            }
        }
    }
}

// MARK: - AI Provider & Agent Model

enum AgentHealthStatus: String, Codable {
    case ready = "ready"  // Ready and authenticated
    case authExpired = "authExpired"  // Signed out or session expired
    case notInstalled = "notInstalled"  // Not installed
    case checking = "checking"  // Probing availability

    var displayText: String {
        switch self {
        case .ready: return "● 已授權就緒"
        case .authExpired: return "⚠️ 未登入/已過期"
        case .notInstalled: return "○ 未安裝"
        case .checking: return "⏳ 檢測中..."
        }
    }

    var color: Color {
        switch self {
        case .ready: return .green
        case .authExpired: return EnterpriseTheme.accent
        case .notInstalled: return .secondary.opacity(0.6)
        case .checking: return EnterpriseTheme.accent
        }
    }
}

enum AiProviderType: String, CaseIterable, Identifiable, Codable, Sendable {
    case autoDetect = "Auto-Detect Local Agent (Recommended)"
    case claudeCli = "Claude Code CLI (claude -p)"
    case codexCli = "OpenAI Codex CLI (codex exec)"
    case antigravityCli = "Google Antigravity (agy)"
    case opencodeCli = "OpenCode CLI (opencode run)"
    case ollamaLocal = "Ollama Local (localhost:11434)"
    case yomiZeroConfig = "Yomi Zero-Config Native"

    var id: String { self.rawValue }

    var displayName: String {
        switch self {
        case .autoDetect: return "智能自適應路由 (Auto-Smart)"
        case .claudeCli: return "Claude Code CLI (claude)"
        case .codexCli: return "OpenAI Codex CLI (codex)"
        case .antigravityCli: return "Google Antigravity (agy)"
        case .opencodeCli: return "OpenCode CLI (opencode)"
        case .ollamaLocal: return "Ollama 本地端 (Private)"
        case .yomiZeroConfig: return "Yomi 原生極速 (Zero-Config)"
        }
    }

    var iconName: String {
        switch self {
        case .autoDetect: return "sparkles"
        case .claudeCli: return "terminal.fill"
        case .codexCli: return "command"
        case .antigravityCli: return "atom"
        case .opencodeCli: return "chevron.left.forwardslash.chevron.right"
        case .ollamaLocal: return "desktopcomputer"
        case .yomiZeroConfig: return "bolt.fill"
        }
    }

    var cliBinaryName: String? {
        switch self {
        case .autoDetect: return nil
        case .claudeCli: return "claude"
        case .codexCli: return "codex"
        case .antigravityCli: return "agy"
        case .opencodeCli: return "opencode"
        case .ollamaLocal: return "ollama"
        case .yomiZeroConfig: return nil
        }
    }

    var subtitle: String {
        switch self {
        case .autoDetect: return "動態檢測各 Agent 當月訂閱/授權狀態，自動切換至已就緒工具"
        case .claudeCli: return "透過 Anthropic 官方 Claude CLI 進行智能總結與指令"
        case .codexCli: return "透過 OpenAI Codex CLI 執行本機程式碼與 LINE 查詢"
        case .antigravityCli: return "透過 Google DeepMind Antigravity CLI 進行深度思考"
        case .opencodeCli: return "透過 OpenCode 終端工具執行對話"
        case .ollamaLocal: return "完全離線隱私，連接本機 Ollama 服務 (11434)"
        case .yomiZeroConfig: return "內建極速端到端解密摘要，免裝任何額外依賴"
        }
    }
}

struct AiConfig: Codable {
    var selectedProvider: AiProviderType = .autoDetect
    var ollamaEndpoint: String = "http://localhost:11434"
    var filterMutedNotifications: Bool = true
}

class AiConfigManager {
    static func getConfigFilePath() -> URL? {
        if let home = ProcessInfo.processInfo.environment["HOME"] {
            return URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/yomi/ai-config.json")
        }
        return nil
    }

    static func loadConfig() -> AiConfig {
        if let path = getConfigFilePath(),
            let data = try? Data(contentsOf: path),
            let decoded = try? JSONDecoder().decode(AiConfig.self, from: data)
        {
            return decoded
        }
        return AiConfig()
    }

    static func saveConfig(_ config: AiConfig) {
        if let path = getConfigFilePath() {
            let dir = path.deletingLastPathComponent()
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            if let data = try? JSONEncoder().encode(config) {
                try? data.write(to: path)
            }
        }
    }
}

// MARK: - Yomi Runtime Path Resolver

class YomiPathResolver {
    static func findNodePath() -> String? {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? ""
        var nodeCandidates: [String] = []
        if let resources = Bundle.main.resourceURL {
            nodeCandidates.append(resources.appendingPathComponent("runtime/node").path)
        }
        nodeCandidates += [
            "\(home)/.local/bin/bun",
            "\(home)/.local/bin/node",
            "/opt/homebrew/bin/bun",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/bun",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        return nodeCandidates.first(where: { FileManager.default.fileExists(atPath: $0) })
    }

    static func findRunMjs() -> (projectDir: String, runMjs: String)? {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? ""
        let fileManager = FileManager.default

        var candidateDirs: [String] = []

        // A distributed desktop build carries its own production-only core.
        // Prefer it over every development fallback so the app never depends
        // on the repository or a global npm installation on an end-user Mac.
        if let resources = Bundle.main.resourceURL {
            candidateDirs.append(resources.appendingPathComponent("YomiCore").path)
        }

        // Development fallbacks follow the bundled runtime candidate.
        let bundleUrl = URL(fileURLWithPath: Bundle.main.bundlePath)
        candidateDirs.append(bundleUrl.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path)
        candidateDirs.append(bundleUrl.deletingLastPathComponent().deletingLastPathComponent().path)
        candidateDirs.append(bundleUrl.deletingLastPathComponent().path)

        // 2. From Executable Path
        if let exePath = Bundle.main.executablePath {
            let exeUrl = URL(fileURLWithPath: exePath)
            candidateDirs.append(
                exeUrl.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path)
        }

        // 3. From Working Directory
        let cwd = fileManager.currentDirectoryPath
        candidateDirs.append(cwd)
        candidateDirs.append(URL(fileURLWithPath: cwd).deletingLastPathComponent().path)

        // 4. Known Workspace Directory
        candidateDirs.append("\(home)/Workspace/RikaiDev/yomi")

        for dir in candidateDirs {
            let runMjs = URL(fileURLWithPath: dir).appendingPathComponent("run.mjs").path
            if fileManager.fileExists(atPath: runMjs) {
                return (projectDir: dir, runMjs: runMjs)
            }
        }

        return nil
    }
}
