#!/bin/bash
# Yomi one-click installer for macOS / Linux
# Checks for Node.js ≥ 22, installs if missing, then launches yomi via npx.

set -e

NODE_MIN_MAJOR=24

# ── helpers ──────────────────────────────────────────────────────────────────

info()  { printf "\033[1;34m%s\033[0m\n" "$*"; }
ok()    { printf "\033[1;32m%s\033[0m\n" "$*"; }
warn()  { printf "\033[1;33m%s\033[0m\n" "$*"; }
die()   { printf "\033[1;31m%s\033[0m\n" "$*" >&2; exit 1; }

# ── check / install node ─────────────────────────────────────────────────────

node_installed() {
  command -v node >/dev/null 2>&1 || return 1
  local v major
  v="$(node -v 2>/dev/null | sed 's/^v//')" || return 1
  major="${v%%.*}"
  [ "$major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null
}

install_node() {
  info "Node.js ≥ ${NODE_MIN_MAJOR} not found — installing..."

  # Prefer nvm if already present (non-interactive shells)
  if [ -d "${NVM_DIR:-$HOME/.nvm}" ] && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    info "Using existing nvm installation"
    # shellcheck source=/dev/null
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm install 24
    nvm use 24
    return
  fi

  # fnm (Fast Node Manager) — cross-platform, single binary
  if command -v fnm >/dev/null 2>&1; then
    info "Using fnm to install Node.js 22"
    fnm install 24
    fnm use 24
    return
  fi

  # Fallback: download Node.js binary directly
  local os arch url tmpdir
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux)  os="linux"  ;;
    *) die "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64)  arch="x64"   ;;
    arm64|aarch64) arch="arm64" ;;
    *) die "Unsupported architecture: $arch" ;;
  esac

  url="https://nodejs.org/dist/v24.18.0/node-v24.18.0-${os}-${arch}.tar.gz"
  tmpdir="$(mktemp -d)"
  info "Downloading Node.js from $url"
  curl -fsSL "$url" | tar -xz -C "$tmpdir" --strip-components=1

  # Add to PATH for this session
  export PATH="${tmpdir}/bin:$PATH"

  # Verify
  node_installed || die "Node.js installation failed"
  ok "Node.js $(node -v) installed"
}

# ── main ─────────────────────────────────────────────────────────────────────

main() {
  if ! node_installed; then
    install_node
  else
    ok "Node.js $(node -v) found"
  fi

  info "Starting Yomi via npx @rikaidev/yomi ..."
  exec npx @rikaidev/yomi "$@"
}

main "$@"
