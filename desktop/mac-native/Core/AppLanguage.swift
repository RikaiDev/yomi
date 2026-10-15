import Foundation

enum AppLanguage: String, CaseIterable, Identifiable, Codable {
    case zhHant = "zh-TW"
    case en = "en"
    case ja = "ja"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .zhHant: return "繁體中文"
        case .en: return "English"
        case .ja: return "日本語"
        }
    }
}
