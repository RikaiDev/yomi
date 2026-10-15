# Yomi Desktop preview releases

Desktop previews are self-contained installers for non-technical users. They
bundle Node 24 and a production-only YomiCore, so users never install Node,
clone this repository, or configure `YOMI_RUN_MJS`.

## Artifacts

- `Yomi-Desktop-macOS-arm64-<version>.dmg`
- `Yomi-Desktop-Windows-x64-<version>-Setup.exe`
- one `.sha256` file beside each installer

Desktop bundles include the local semantic classifier used by the attention
inbox. Packaging retains only the target platform's ONNX runtime; browser and
other-platform binaries are removed. The unpacked core has a 220 MB hard limit,
and each compressed installer has a 120 MB hard limit.

## Required GitHub Actions secrets

### macOS

- `MACOS_CERTIFICATE_BASE64`: base64-encoded Developer ID Application `.p12`
- `MACOS_CERTIFICATE_PASSWORD`: password protecting the `.p12`
- `MACOS_KEYCHAIN_PASSWORD`: temporary CI keychain password
- `MACOS_SIGNING_IDENTITY`: full `Developer ID Application: ... (TEAMID)` name
- `APPLE_API_KEY_BASE64`: base64-encoded App Store Connect Team API `.p8`
- `APPLE_API_KEY_ID`: Team API key identifier
- `APPLE_API_ISSUER_ID`: App Store Connect API issuer UUID

### Windows

- SignPath Foundation project slug and signing-policy identifiers, after the
  project's free OSS application is approved; or
- `WINDOWS_CERTIFICATE_BASE64`: base64-encoded trusted code-signing `.pfx`
- `WINDOWS_CERTIFICATE_PASSWORD`: password protecting the `.pfx`

The release workflow deliberately fails rather than publishing an unsigned
installer. See [`CODE_SIGNING.md`](CODE_SIGNING.md).

## Local macOS packaging rehearsal

An unsigned rehearsal proves the bundle, DMG, size gate, and mounted-image
smoke test. It must never be uploaded for users.

```bash
npm run build
YOMI_ALLOW_UNSIGNED_PREVIEW=1 \
YOMI_NODE_BINARY="$HOME/.nvm/versions/node/v24.14.0/bin/node" \
bash scripts/build-macos-desktop-release.sh
```

## Publishing

Desktop tags share the core version and add a preview suffix:

```bash
git tag desktop-v0.4.2-alpha.1
git push origin desktop-v0.4.2-alpha.1
```

`.github/workflows/desktop-preview.yml` then:

1. runs core quality gates;
2. builds the macOS DMG and Windows Setup.exe on their native runners;
3. signs both products;
4. notarizes and staples the macOS app;
5. installs or mounts the finished package and runs its bundled core;
6. enforces size budgets and generates SHA-256 files; and
7. creates a GitHub pre-release only after both platforms pass.

The npm and MCPB release workflows ignore `desktop-v*` releases. Their normal
`v<version>` release flow remains unchanged.
