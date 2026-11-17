# Releasing `@rikaidev/yomi`

Publishing is automated and **gated** — you cannot ship a version whose
`package.json`, `src/version.ts`, and git tag disagree, nor one that fails
`tsc` or the test suite. That is by design: the point is to never discover a
missed edit *after* the package is public.

## Cut a release

1. **Bump the version.** This also syncs `src/version.ts` and creates the
   commit + tag for you:

   ```bash
   npm version patch     # or: minor | major
   ```

   The `version` lifecycle script runs `scripts/sync-version.mjs`, so
   `src/version.ts`'s `YOMI_VERSION` can never drift from `package.json`.

2. **Push the commit and tag:**

   ```bash
   git push --follow-tags
   ```

3. **Create the GitHub Release** for that tag — this triggers
   `.github/workflows/publish.yml`. The notes are generated deterministically
   from the range's Conventional Commits by `scripts/release-notes.mjs`, so
   every release reads the same way (grouped Features / Fixes / Performance /
   Refactoring / Internal, with a compare link) — do NOT hand-write them or use
   `--generate-notes`:

   ```bash
   TAG="v$(node -p "require('./package.json').version")"
   gh release create "$TAG" --title "$TAG" \
     --notes "$(node scripts/release-notes.mjs "$TAG")"
   ```

   Preview the notes for any tag first with `node scripts/release-notes.mjs <tag>`.
   Pass `--headline "<one sentence>"` to prepend a single lead line above the
   sections when a release warrants one; the section structure stays fixed.

## What the publish workflow verifies before `npm publish`

- **tag == version** — the release tag must equal `package.json`'s version,
  so a Release created against the wrong tag never ships under the wrong number;
- **tests pass** — `bun test`, which includes the `src/version.ts` ↔
  `package.json` drift guard (`src/version.test.ts`);
- **build emits** — `tsc` compiles *and writes* `dist/`, which is what the
  tarball ships;
- **the tarball actually starts in both protocol eras** — `npm pack`, install
  it into a clean project, then use the stable MCP v2 client to pin a
  stateless `2026-07-28` connection and separately complete a legacy
  `initialize` connection. Both probes list all 49 tools and call
  `get_scope_policy`; the modern probe also audits the connection-independent
  MCP Apps tool metadata and UI resource. A fourth probe drives the
  2026-07-28 multi-round-trip `login` flow — it answers the pre-flight
  elicitation with "the second-device setting is off" and asserts the server
  returns the enabling steps instead of starting a login. Every probe runs
  with `YOMI_DATA_DIR` redirected AND `YOMI_NO_KEYCHAIN=1`: the macOS Keychain
  is machine-global, so without the second one the probes would run against
  the real LINE session on the machine and `login` could act on a live
  account (`scripts/smoke-mcp.mjs`).

Any mismatch fails the workflow and **nothing is published**. Publishing itself
is credential-free via npm OIDC Trusted Publishing (no token), with a provenance
attestation attached automatically.

## Why the handshake gate exists

Releases 0.1.0–0.1.2 all built cleanly, passed their tests, and **could not
start at all**. `files` shipped TypeScript sources, so every install died on

```
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
```

because Node refuses to strip types for files under `node_modules`. Nobody
noticed for three releases: the package was only ever run from a repo checkout
(where that rule does not apply), and CI smoke-tested `--help` — the one command
that prints a literal string without importing any application code.

**A green build says nothing about whether the published artifact runs.** The
only check that means anything is installing the tarball the way a user does and
starting it. That is what `install-smoke.yml` and the publish gate now do, on
Linux, macOS and Windows.

## Local safety net

`prepublishOnly` runs `npm run build`, so `dist/` is always freshly emitted
before anything is packed or published.
