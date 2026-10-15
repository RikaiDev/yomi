use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LoginUiState {
    Starting,
    Pin { pin: String },
    WaitingApproval { pin: String },
    Success,
    Error { message: String },
}

#[derive(Debug, Clone)]
pub enum DesktopEvent {
    Login(LoginUiState),
    RefreshAccount,
    /// Result of a short-lived command executed by the shared TypeScript core.
    /// Keeping this as a user event means the Windows UI never touches LINE
    /// protocol code; it only renders the same JSON contract as the macOS app.
    Bridge {
        id: String,
        ok: bool,
        output: String,
        error: Option<String>,
    },
}
