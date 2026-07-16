/**
 * Yomi's version, as a build-time constant so it survives `bun build
 * --compile` (a runtime read of package.json fails inside bun's compiled
 * virtual filesystem). MUST stay equal to the "version" field in
 * package.json — the test in version.test.ts enforces that.
 */
export const YOMI_VERSION = '0.2.2'
