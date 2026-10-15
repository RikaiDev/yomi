# Windows/macOS desktop parity matrix (honest status)

Windows uses the same `run.mjs` TypeScript bridge as macOS. This matrix is a
scope and verification record, not a claim that a macOS-only API has been
recreated on a macOS host.

| Capability | macOS authority | Windows status | Evidence / remaining verification |
| --- | --- | --- | --- |
| Inbox, search, priority filter, unread count | `Features/Inbox/InboxView.swift`, `Core/AppState.swift` | Implemented in WebView, including pinned Today Briefing and attention-tier overview | `windows-i18n-harness`; real Windows data smoke test required |
| Conversation history and read cursor | `Core/AppState.swift`, `AppStateBridge.swift` | Implemented through `messages`/`mark-read`; generation and selected/rendered guards are enforced in WebView | Rust tests; Windows account smoke test required |
| Direct text replies | `Core/AppState.swift` | Implemented through `send-message` | TypeScript tests; Windows send test required |
| Image/file attachments | `AppState.swift` | Implemented with validated upload staging and `send-image`/`send-file` routing; WebView supports staged multi-file upload and download preview | Rust check; Windows WebView2 file-picker/send test required |
| Camera and voice capture | `ConversationView.swift` | Partial: capture input and WebView `MediaRecorder`; native device permission behavior is runtime-dependent | Windows hardware/permission test required |
| Stickers | `ComposerViews.swift`, `AppState.swift` | Implemented through shared sticker commands; first owned package is shown | Windows account smoke test required |
| Flex/image-map | `FlexMessageView.swift`, `MessageViews.swift` | Implemented in WebView with flex-first rendering, aspect ratio/mode, 286px snapping carousel and imagemap regions; action schemes remain restricted | Flex TypeScript tests; complex payload Windows test required |
| Rich menu | `RichMenuView.swift`, `AppStateRichMenu.swift` | Partial: image/regions/URI/message actions; postback and mobile-only actions show fallback | Windows rich-menu test required; mobile-only actions cannot be emulated on desktop |
| Thread drawer | `ConversationView.swift`, `MessageViews.swift` | Implemented for `threadReplies` returned by core with a lightweight WebView drawer | Windows thread fixture/runtime test required |
| Attention and ambient observation | `InboxView.swift`, `AppStateAmbientObserver.swift` | Shared candidate semantics and enterprise tracking-row hierarchy implemented; Windows still uses a drawer instead of the macOS Briefing section | Ambient TypeScript tests pass; Windows OCR/runtime and full placement parity still required |
| Muting | `AppStateBridge.swift` | Implemented through `set-chat-muted` | Windows account smoke test required |
| Passwordless login | `Features/Login/LoginViews.swift` | Implemented by Rust login process and WebView state with PIN countdown and cancellation | Rust auth tests; Windows LINE approval required |
| Coding providers | `AppStateAgent.swift`, `CodexAppServerBackend.swift` | Existing Rust provider registry exposed through a Windows Yomi panel; approval streaming is an explicit runtime limitation | Windows installed-provider test required |
| Settings, locale, appearance, sync | `SettingsViews.swift`, `I18n.swift` | Partial: locale, appearance, sync and notification settings persist locally; AI/approval and native updater remain limited | Static i18n harness; Windows settings persistence test required |
| Tray, notification, update URL | `AppDelegate.swift`, `Components/AppComponents.swift` | Tray and native notifications implemented; update opens the release page rather than embedding macOS updater behavior | Windows shell/notification/installer test required |

## Verification boundary

macOS can run TypeScript tests, Rust `cargo check/test`, formatting, static
Windows source checks, and `cargo check --target x86_64-pc-windows-msvc` when
that target is installed. It cannot prove WebView2 behavior, MSVC linking,
Windows permissions, tray behavior, LINE approval, camera/microphone access,
or actual message delivery. Those rows remain explicitly runtime-required
until a Windows 10/11 VM or CI runner runs the packaged application.
