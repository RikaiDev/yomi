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
- **build is clean** — `tsc` compiles.

Any mismatch fails the workflow and **nothing is published**. Publishing itself
is credential-free via npm OIDC Trusted Publishing (no token), with a provenance
attestation attached automatically.

## Local safety net

`prepublishOnly` runs `tsc --noEmit` on every `npm publish`, so a broken build
is refused even outside CI.
