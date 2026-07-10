/**
 * LINE Credential Stores — re-exports
 *
 * Both stores live in Yomi's vendored auth/credential-store module.
 * This module re-exports them under their original names for
 * compatibility with the LINE protocol core.
 */

export { CredentialStore as FileCredentialStore, InMemoryStore } from '../../auth/credential-store.js';
