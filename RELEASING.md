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
   `.github/workflows/publish.yml`:

   ```bash
   gh release create "v$(node -p "require('./package.json').version")" --generate-notes
   ```

## What the publish workflow verifies before `npm publish`

- **tag == version** — the release tag must equal `package.json`'s version,
  so a Release created against the wrong tag never ships under the wrong number;
- **tests pass** — `bun test`, which includes the `src/version.ts` ↔
  `package.json` drift guard (`src/version.test.ts`);
- **build emits** — `tsc` compiles *and writes* `dist/`, which is what the
  tarball ships;
- **the tarball actually starts** — `npm pack`, install it into a clean
  project, then start it as a real MCP stdio server and complete an
  `initialize` handshake (`scripts/smoke-mcp.mjs`).

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
