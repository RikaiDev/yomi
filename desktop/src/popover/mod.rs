use crate::agent::CodingToolBackend;
use crate::auth::keychain::KeychainStore;
use crate::auth::login::{run_login, LoginRequest};
use crate::events::DesktopEvent;
use crate::notification::NotificationService;
use crate::platform::open_url;
use crate::sync::SyncService;
use serde_json::{json, Value};
use std::io::Write;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event_loop::{EventLoopProxy, EventLoopWindowTarget};
use tao::window::{Window, WindowBuilder};
use tokio::io::AsyncWriteExt;
use tokio::process::Child;
use tokio::process::Command;
use tokio::runtime::Handle;
use tracing::info;
use wry::{WebView, WebViewBuilder};

pub const POPOVER_HTML: &str = concat!(
    include_str!("view.html"),
    "<style>",
    include_str!("view.css"),
    "</style><script>",
    include_str!("view.js"),
    "</script></body></html>"
);

pub struct PopoverPanel {
    pub window: Window,
    pub webview: WebView,
    pub coding_backend: Arc<CodingToolBackend>,
    #[allow(dead_code)]
    pub sync_service: Arc<SyncService>,
    runtime_handle: Handle,
    event_proxy: EventLoopProxy<DesktopEvent>,
    #[allow(dead_code)]
    login_task: Arc<std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl PopoverPanel {
    pub fn new(
        window_target: &EventLoopWindowTarget<DesktopEvent>,
        sync_service: Arc<SyncService>,
        coding_backend: Arc<CodingToolBackend>,
        runtime_handle: Handle,
        event_proxy: EventLoopProxy<DesktopEvent>,
    ) -> Self {
        // Windows uses the same full workspace as macOS.  The tray remains a
        // quick entry point, but it must not reduce the product to a status
        // popover: inbox, conversation, composer, rich menu and settings all
        // live in this one WebView surface.
        let width = 1280.0;
        let height = 820.0;

        let window = WindowBuilder::new()
            .with_title("Yomi")
            .with_inner_size(LogicalSize::new(width, height))
            // Windows is a normal workspace window, not a tray popover. This
            // also gives WebView2 a native resize frame and avoids the stale
            // 360px positioning assumptions of the former shell.
            .with_decorations(true)
            .with_transparent(false)
            .with_always_on_top(false)
            .with_resizable(true)
            .with_visible(false)
            .build(window_target)
            .expect("Failed to build popover window");

        let sync_clone = sync_service.clone();
        let coding_backend_for_ipc = coding_backend.clone();
        let runtime_handle_for_ipc = runtime_handle.clone();
        let event_proxy_for_ipc = event_proxy.clone();
        let login_task = Arc::new(std::sync::Mutex::new(None));
        let login_task_for_ipc = login_task.clone();

        let webview = WebViewBuilder::new()
            .with_html(POPOVER_HTML)
            .with_transparent(false)
            .with_ipc_handler(move |msg| {
                let action = msg.body();
                info!("Popover action triggered: {}", action_name(action));
                if let Some(payload) = action.strip_prefix("bridge:") {
                    match serde_json::from_str::<BridgeRequest>(payload) {
                        Ok(request) if request.is_allowed() => spawn_bridge(
                            request,
                            runtime_handle_for_ipc.clone(),
                            event_proxy_for_ipc.clone(),
                        ),
                        Ok(request) => {
                            let _ = event_proxy_for_ipc.send_event(DesktopEvent::Bridge {
                                id: request.id,
                                ok: false,
                                output: String::new(),
                                error: Some("Unsupported desktop bridge operation".to_string()),
                            });
                        }
                        Err(error) => {
                            let _ = event_proxy_for_ipc.send_event(DesktopEvent::Bridge {
                                id: "bridge".to_string(),
                                ok: false,
                                output: String::new(),
                                error: Some(format!("Invalid bridge request: {error}")),
                            });
                        }
                    }
                    return;
                }
                if let Some(payload) = action.strip_prefix("upload:") {
                    let upload = serde_json::from_str::<UploadRequest>(payload)
                        .map_err(|error| error.to_string())
                        .and_then(store_upload);
                    match upload {
                        Ok(path) => {
                            let _ = event_proxy_for_ipc.send_event(DesktopEvent::Bridge {
                                id: path.0,
                                ok: true,
                                output: serde_json::json!({ "filePath": path.1, "kind": path.2 }).to_string(),
                                error: None,
                            });
                        }
                        Err(error) => {
                            let _ = event_proxy_for_ipc.send_event(DesktopEvent::Bridge {
                                id: "upload".to_string(),
                                ok: false,
                                output: String::new(),
                                error: Some(error),
                            });
                        }
                    }
                    return;
                }
                match action.as_str() {
                    "sync" => {
                        sync_clone.trigger_manual_sync();
                    }
                    "test_notify" => {
                        sync_clone.send_test_notification();
                    }
                    "open_doc" => {
                        let _ = open_url("https://rikaidev.github.io/yomi/zh-tw/line-mcp/");
                    }
                    "open_workspace" => {
                        let _ = open_url("https://rikaidev.github.io/yomi/");
                    }
                    "settings" => {
                        info!("Open Settings dialog");
                        let _ = event_proxy_for_ipc.send_event(DesktopEvent::Bridge {
                            id: "settings".to_string(),
                            ok: true,
                            output: "{}".to_string(),
                            error: None,
                        });
                    }
                    action if action.starts_with("open_url:") => {
                        let url = &action["open_url:".len()..];
                        if url.starts_with("https://") || url.starts_with("http://") {
                            let _ = open_url(url);
                        }
                    }
                    action if action.starts_with("coding_tool_run:") => {
                        let payload = &action["coding_tool_run:".len()..];
                        if let Ok(request) = serde_json::from_str::<CodingToolRequest>(payload) {
                            let backend = coding_backend_for_ipc.clone();
                            let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
                            runtime_handle_for_ipc.spawn(async move {
                                match backend
                                    .run(Some(request.provider.as_str()), &request.prompt, &cwd)
                                    .await
                                {
                                    Ok(output) => NotificationService::show(
                                        "Yomi coding tool completed",
                                        &truncate_notification(&output),
                                    ),
                                    Err(error) => NotificationService::show(
                                        "Yomi coding tool failed",
                                        &truncate_notification(&error),
                                    ),
                                }
                            });
                        }
                    }
                    action if action.starts_with("login_start:") => {
                        let payload = &action["login_start:".len()..];
                        if let Ok(request) = serde_json::from_str::<LoginRequest>(payload) {
                            let proxy = event_proxy_for_ipc.clone();
                            let task = runtime_handle_for_ipc.spawn(run_login(request, proxy));
                            if let Ok(mut slot) = login_task_for_ipc.lock() {
                                if let Some(previous) = slot.replace(task) { previous.abort(); }
                            }
                        } else {
                            let _ = event_proxy_for_ipc.send_event(DesktopEvent::Login(
                                crate::events::LoginUiState::Error {
                                    message: "The login form was invalid. Check the phone number and try again.".to_string(),
                                },
                            ));
                        }
                    }
                    "login_cancel" => {
                        if let Ok(mut slot) = login_task_for_ipc.lock() {
                            if let Some(task) = slot.take() { task.abort(); }
                        }
                    }
                    "quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                }
            })
            .build(&window)
            .expect("Failed to initialize webview for popover");

        let panel = Self {
            window,
            webview,
            sync_service,
            coding_backend,
            runtime_handle,
            event_proxy,
            login_task,
        };

        panel.refresh_data();
        panel
    }

    pub fn handle_event(&self, event: DesktopEvent) {
        match event {
            DesktopEvent::Login(state) => {
                if let Ok(json) = serde_json::to_string(&state) {
                    let script = format!(
                        "if (window.updateLoginState) {{ window.updateLoginState({json}); }}"
                    );
                    let _ = self.webview.evaluate_script(&script);
                }
            }
            DesktopEvent::RefreshAccount => self.refresh_data(),
            DesktopEvent::Bridge {
                id,
                ok,
                output,
                error,
            } => {
                let id = serde_json::to_string(&id).unwrap_or_else(|_| "\"bridge\"".to_string());
                let output = serde_json::to_string(&output).unwrap_or_else(|_| "\"\"".to_string());
                let error = serde_json::to_string(&error).unwrap_or_else(|_| "null".to_string());
                let script = format!(
                    "if (window.receiveBridgeResult) window.receiveBridgeResult({id}, {ok}, {output}, {error});"
                );
                let _ = self.webview.evaluate_script(&script);
            }
        }
    }

    /// Toggle popover panel visibility.
    pub fn toggle(&self) {
        let is_vis = self.window.is_visible();
        if is_vis {
            self.window.set_visible(false);
        } else {
            self.refresh_data();

            // Centre the workspace on the active monitor.
            if let Some(monitor) = self.window.current_monitor() {
                let screen_size = monitor.size();
                let scale = monitor.scale_factor();
                let screen_width = screen_size.width as f64 / scale;
                let screen_height = screen_size.height as f64 / scale;
                let target_x = ((screen_width - 1280.0) / 2.0).max(20.0);
                let target_y = ((screen_height - 820.0) / 2.0).max(20.0);
                self.window
                    .set_outer_position(LogicalPosition::new(target_x, target_y));
            } else {
                self.window
                    .set_outer_position(LogicalPosition::new(120.0, 80.0));
            }

            self.window.set_visible(true);
            self.window.set_focus();
        }
    }

    /// Hide the popover.
    pub fn hide(&self) {
        if self.window.is_visible() {
            self.window.set_visible(false);
        }
    }

    /// Update account data and connection state in the panel.
    pub fn refresh_data(&self) {
        let (connected, mid, display_name, avatar_text) = match KeychainStore::load() {
            Ok(creds) if creds.is_valid() => {
                let mid_str = creds.mid_display();
                let avatar = if mid_str.len() >= 3 {
                    mid_str[1..3].to_uppercase()
                } else {
                    "YM".to_string()
                };
                (
                    true,
                    mid_str.clone(),
                    format!("LINE User ({})", &mid_str[..mid_str.len().min(8)]),
                    avatar,
                )
            }
            _ => (
                false,
                "".to_string(),
                "Not Logged In".to_string(),
                "YM".to_string(),
            ),
        };

        let state_json = json!({
            "connected": connected,
            "mid": mid,
            "displayName": display_name,
            "avatarText": avatar_text
        })
        .as_object_mut()
        .map(|state| {
            state.extend(
                self.coding_backend
                    .registry()
                    .status_json()
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            );
            Value::Object(state.clone())
        })
        .unwrap_or_else(|| json!({}));

        let script = format!(
            "window.login = function(event) {{ event.preventDefault(); var phone = document.getElementById('phone'); var region = document.getElementById('region'); var button = document.getElementById('login-button'); if (!phone || !region || !window.ipc) return; button.disabled = true; window.ipc.postMessage('login_start:' + JSON.stringify({{phone: phone.value.trim(), region: region.value}})); }}; if (window.updateState) {{ window.updateState({}); }}",
            state_json
        );
        let _ = self.webview.evaluate_script(&script);
        if connected {
            self.request_bridge("chats", "chats", vec!["all".to_string()], None);
        }
    }

    pub fn request_bridge(
        &self,
        id: &str,
        command: &str,
        args: Vec<String>,
        stdin: Option<String>,
    ) {
        let request = BridgeRequest {
            id: id.to_string(),
            command: command.to_string(),
            args,
            stdin,
            mentions: Vec::new(),
        };
        if request.is_allowed() {
            spawn_bridge(
                request,
                self.runtime_handle.clone(),
                self.event_proxy.clone(),
            );
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct BridgeRequest {
    id: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    stdin: Option<String>,
    #[serde(default)]
    mentions: Vec<serde_json::Value>,
}

impl BridgeRequest {
    fn is_allowed(&self) -> bool {
        const COMMANDS: &[&str] = &[
            "chats",
            "messages",
            "send-message",
            "send-image",
            "send-file",
            "send-audio",
            "media-preview",
            "rich-menu",
            "list-stickers",
            "sticker-previews",
            "send-sticker",
            "mark-read",
            "set-chat-muted",
            "attention-classify",
            "ambient-observe",
            "summary",
            "setup-mcp",
        ];
        COMMANDS.contains(&self.command.as_str())
            && self.id.len() <= 128
            && self.args.iter().all(|value| !value.contains('\0'))
    }
}

#[derive(Debug, serde::Deserialize)]
struct UploadRequest {
    id: String,
    name: String,
    data: String,
    #[serde(default)]
    kind: String,
}

fn store_upload(request: UploadRequest) -> Result<(String, String, String), String> {
    use base64::Engine;
    if request.id.len() > 128 || request.name.len() > 240 {
        return Err("Attachment metadata is too long".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(request.data.as_bytes())
        .map_err(|_| "Attachment data is not valid base64".to_string())?;
    if bytes.is_empty() || bytes.len() > 50 * 1024 * 1024 {
        return Err("Attachment must be between 1 byte and 50 MB".to_string());
    }
    let root = crate::platform::data_dir()
        .ok_or_else(|| "Yomi data directory is unavailable".to_string())?
        .join("desktop-uploads");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let safe_name = std::path::Path::new(&request.name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("attachment");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let path = root.join(format!("{}-{}-{}", stamp, std::process::id(), safe_name));
    let mut file = std::fs::File::create(&path).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    let kind = if request.kind == "image" {
        "image"
    } else {
        "file"
    };
    Ok((
        request.id,
        path.to_string_lossy().to_string(),
        kind.to_string(),
    ))
}

fn spawn_bridge(request: BridgeRequest, runtime: Handle, proxy: EventLoopProxy<DesktopEvent>) {
    runtime.spawn(async move {
        let result = execute_bridge(&request).await;
        let event = match result {
            Ok(output) => DesktopEvent::Bridge {
                id: request.id,
                ok: true,
                output,
                error: None,
            },
            Err(error) => DesktopEvent::Bridge {
                id: request.id,
                ok: false,
                output: String::new(),
                error: Some(error),
            },
        };
        let _ = proxy.send_event(event);
    });
}

async fn execute_bridge(request: &BridgeRequest) -> Result<String, String> {
    let (node, run_mjs, cwd) = crate::platform::yomi_runtime_paths()
        .ok_or_else(|| "The bundled Yomi runtime is missing".to_string())?;
    let mut command = Command::new(node);
    // The WebView stages camera/photo and generic files through the same
    // upload path. Preserve the macOS distinction at the shared-core boundary
    // by routing image extensions to `send-image` before invoking run.mjs.
    let command_name = if request.command == "send-file"
        && request.args.get(1).is_some_and(|path| is_image_path(path))
    {
        "send-image"
    } else {
        request.command.as_str()
    };
    command.arg(run_mjs).arg(command_name).args(&request.args);
    if request.command == "send-message" && !request.mentions.is_empty() {
        let value = serde_json::to_string(&request.mentions).map_err(|error| error.to_string())?;
        command.env("YOMI_MENTIONS_JSON", value);
    }
    command.current_dir(cwd).stdin(if request.stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child: Child = command
        .spawn()
        .map_err(|error| format!("Could not start bridge: {error}"))?;
    if let Some(stdin) = &request.stdin {
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(stdin.as_bytes())
                .await
                .map_err(|error| error.to_string())?;
            pipe.shutdown().await.map_err(|error| error.to_string())?;
        }
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Yomi bridge failed ({})", output.status)
        } else {
            stderr
        });
    }
    Ok(stdout)
}

fn is_image_path(path: &str) -> bool {
    matches!(
        std::path::Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "heic")
    )
}

#[derive(Debug, serde::Deserialize)]
struct CodingToolRequest {
    provider: String,
    prompt: String,
}

fn truncate_notification(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= 180 {
        return trimmed.to_string();
    }
    format!("{}…", trimmed.chars().take(179).collect::<String>())
}

fn action_name(action: &str) -> &str {
    action.split_once(':').map_or(action, |(name, _)| name)
}
