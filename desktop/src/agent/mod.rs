use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::process::Command;

/// The complete Yomi MCP surface is intentionally enabled for every coding tool.
pub const YOMI_MCP_TOOLS: &[&str] = &[
    "login",
    "login_complete",
    "list_conversations",
    "get_chat_messages",
    "get_message_image",
    "get_message_media",
    "get_unread_digest",
    "get_insight",
    "send_message",
    "send_image",
    "send_file",
    "send_audio",
    "send_video",
    "send_location",
    "send_contact",
    "send_sticker",
    "list_stickers",
    "search_stickers",
    "preview_sticker",
    "mark_read",
    "find_contact",
    "list_contacts",
    "get_group_members",
    "rename_group",
    "invite_member",
    "kick_member",
    "leave_group",
    "create_group",
    "add_friend",
    "block_contact",
    "unblock_contact",
    "accept_invitation",
    "react_message",
    "cancel_reaction",
    "unsend_message",
    "collect_messages",
    "search_messages",
    "exclude_chats",
    "include_chats",
    "list_excluded_chats",
    "get_scope_policy",
];

#[derive(Debug, Clone, Serialize)]
pub struct CodingToolStatus {
    pub id: &'static str,
    pub display_name: &'static str,
    pub executable: &'static str,
    pub detected: bool,
    pub enabled: bool,
    pub supports_mcp_config: bool,
}

#[derive(Debug, Clone, Copy)]
struct ProviderDefinition {
    id: &'static str,
    display_name: &'static str,
    executable: &'static str,
    supports_mcp_config: bool,
}

const PROVIDERS: &[ProviderDefinition] = &[
    ProviderDefinition {
        id: "codex",
        display_name: "OpenAI Codex CLI",
        executable: "codex",
        supports_mcp_config: true,
    },
    ProviderDefinition {
        id: "claude",
        display_name: "Claude Code",
        executable: "claude",
        supports_mcp_config: true,
    },
    ProviderDefinition {
        id: "antigravity",
        display_name: "Google Antigravity",
        executable: "agy",
        supports_mcp_config: false,
    },
    ProviderDefinition {
        id: "opencode",
        display_name: "OpenCode",
        executable: "opencode",
        supports_mcp_config: false,
    },
    ProviderDefinition {
        id: "ollama",
        display_name: "Ollama Local",
        executable: "ollama",
        supports_mcp_config: false,
    },
];

#[derive(Debug, Clone)]
pub struct CodingToolRegistry {
    statuses: Arc<Vec<CodingToolStatus>>,
}

impl CodingToolRegistry {
    pub fn detect() -> Self {
        let statuses = PROVIDERS
            .iter()
            .map(|provider| CodingToolStatus {
                id: provider.id,
                display_name: provider.display_name,
                executable: provider.executable,
                detected: find_executable(provider.executable).is_some(),
                enabled: true,
                supports_mcp_config: provider.supports_mcp_config,
            })
            .collect();
        Self {
            statuses: Arc::new(statuses),
        }
    }

    pub fn auto_detected(&self) -> Option<&CodingToolStatus> {
        self.statuses.iter().find(|status| status.detected)
    }

    pub fn status_json(&self) -> Value {
        json!({
            "codingTools": self.statuses.as_ref(),
            "codingToolAutoDetected": self.auto_detected().map(|provider| provider.id),
            "allYomiMcpToolsEnabled": true,
            "yomiMcpToolCount": YOMI_MCP_TOOLS.len(),
        })
    }

    fn provider(&self, requested: Option<&str>) -> Option<&CodingToolStatus> {
        match requested.filter(|id| *id != "auto") {
            Some(id) => self.statuses.iter().find(|provider| provider.id == id),
            None => self.auto_detected(),
        }
    }
}

#[derive(Clone)]
pub struct CodingToolBackend {
    registry: CodingToolRegistry,
}

impl CodingToolBackend {
    pub fn new(registry: CodingToolRegistry) -> Self {
        Self { registry }
    }

    pub fn registry(&self) -> &CodingToolRegistry {
        &self.registry
    }

    /// Run a detected coding tool without a shell, preserving the full Yomi MCP surface.
    pub async fn run(
        &self,
        requested_provider: Option<&str>,
        prompt: &str,
        cwd: &Path,
    ) -> Result<String, String> {
        let provider = self
            .registry
            .provider(requested_provider)
            .ok_or_else(|| "No installed coding tool was detected".to_string())?;
        let executable = find_executable(provider.executable).ok_or_else(|| {
            format!(
                "{} is not installed or is not on PATH",
                provider.display_name
            )
        })?;
        let mut args = command_arguments(provider.id, prompt);
        let yomi_server = yomi_server_config(cwd);

        if provider.id == "codex" {
            if let Some(server) = yomi_server.as_ref() {
                args.extend([
                    "-c".to_string(),
                    format!("mcp_servers.yomi.command=\"{}\"", server.command),
                    "-c".to_string(),
                    format!("mcp_servers.yomi.args=[\"{}\", \"serve\"]", server.run_mjs),
                ]);
            }
        } else if provider.id == "claude" {
            if let Some(server) = yomi_server.as_ref() {
                args.extend(["--mcp-config".to_string(), server.json.to_string()]);
            }
        }

        let mut command = Command::new(executable);
        command
            .args(args)
            .current_dir(cwd)
            .env("YOMI_MCP_TOOLS", "all")
            .env("YOMI_MCP_TOOL_ALLOWLIST", YOMI_MCP_TOOLS.join(","))
            .env("YOMI_DESKTOP_PROVIDER", provider.id)
            .kill_on_drop(true);
        let output = command
            .output()
            .await
            .map_err(|error| format!("{} failed to start: {}", provider.display_name, error))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if output.status.success() {
            Ok(if stdout.is_empty() { stderr } else { stdout })
        } else {
            Err(if stderr.is_empty() {
                format!("{} exited with {}", provider.display_name, output.status)
            } else {
                stderr
            })
        }
    }
}

#[derive(Debug)]
struct YomiServerConfig {
    command: String,
    run_mjs: String,
    json: Value,
}

fn yomi_server_config(cwd: &Path) -> Option<YomiServerConfig> {
    let executable_root = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let run_mjs = env::var("YOMI_RUN_MJS")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            executable_root
                .as_ref()
                .map(|root| root.join("YomiCore").join("run.mjs"))
                .filter(|candidate| candidate.exists())
        })
        .or_else(|| {
            let candidate = cwd.join("run.mjs");
            candidate.exists().then_some(candidate)
        })?;
    let command = env::var("YOMI_NODE_PATH").unwrap_or_else(|_| {
        executable_root
            .as_ref()
            .map(|root| {
                root.join("runtime").join(if cfg!(target_os = "windows") {
                    "node.exe"
                } else {
                    "node"
                })
            })
            .filter(|candidate| candidate.exists())
            .map(|candidate| candidate.to_string_lossy().to_string())
            .unwrap_or_else(|| "node".to_string())
    });
    let run_mjs_string = run_mjs.to_string_lossy().to_string();
    let json = json!({
        "mcpServers": {
            "yomi": {
                "command": command,
                "args": [run_mjs_string, "serve"],
                "env": { "YOMI_MCP_TOOLS": "all" }
            }
        }
    });
    Some(YomiServerConfig {
        command,
        run_mjs: run_mjs.to_string_lossy().to_string(),
        json,
    })
}

fn command_arguments(provider: &str, prompt: &str) -> Vec<String> {
    let prepared = format!(
        "Use the Yomi MCP server with every available tool enabled by default.\n\nUser task:\n{}",
        prompt
    );
    match provider {
        "codex" => vec!["exec".into(), "--json".into(), prepared],
        "claude" => vec![
            "-p".into(),
            prepared,
            "--output-format".into(),
            "text".into(),
        ],
        "antigravity" => vec!["-p".into(), prepared],
        "opencode" => vec!["run".into(), prepared],
        "ollama" => vec![
            "run".into(),
            env::var("YOMI_OLLAMA_MODEL").unwrap_or_else(|_| "llama3.2".into()),
            prepared,
        ],
        _ => vec![prepared],
    }
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for directory in env::split_paths(&path) {
        let candidate = directory.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
        #[cfg(target_os = "windows")]
        for extension in env::var_os("PATHEXT")
            .as_deref()
            .unwrap_or(std::ffi::OsStr::new(".COM;.EXE;.BAT;.CMD"))
            .to_string_lossy()
            .split(';')
        {
            let candidate = directory.join(format!("{}{}", name, extension));
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::{command_arguments, CodingToolRegistry, YOMI_MCP_TOOLS};

    #[test]
    fn registry_contains_every_windows_provider() {
        let registry = CodingToolRegistry::detect();
        let ids: Vec<_> = registry
            .statuses
            .iter()
            .map(|provider| provider.id)
            .collect();
        assert_eq!(
            ids,
            ["codex", "claude", "antigravity", "opencode", "ollama"]
        );
        assert!(registry.statuses.iter().all(|provider| provider.enabled));
    }

    #[test]
    fn every_provider_keeps_the_complete_yomi_tool_surface() {
        assert_eq!(YOMI_MCP_TOOLS.len(), 41);
        for provider in ["codex", "claude", "antigravity", "opencode", "ollama"] {
            let args = command_arguments(provider, "hello");
            assert!(args.iter().any(|arg| arg.contains("every available tool")));
        }
    }
}
