import { expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The file backend is what Windows and Linux actually run on — there is no
 * keychain there — so a write failure in it means no session is ever persisted:
 * no auth token, no mid, no E2EE keypair. That presents to the user as "login
 * succeeded but session did not persist", a re-scan of the phone PIN on every
 * restart, and every message stuck undecrypted.
 */
async function fileBackedStore() {
  process.env.YOMI_NO_KEYCHAIN = '1'
  const { CredentialStore } = await import('./credential-store.js')
  const dir = await mkdtemp(join(tmpdir(), 'yomi-cred-'))
  // Nested and absent: persistBlob has to create the parent itself, which is
  // where the Windows bug lived.
  const filePath = join(dir, 'nested', 'line-credentials.json')
  return { store: new CredentialStore('line', filePath), filePath, dir }
}

test('persists a credential into a parent directory that does not exist yet', async () => {
  const { store, filePath } = await fileBackedStore()

  await store.set('line_auth_token', 'tok')
  await store.set('line_mid', 'u123')

  expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
    line_auth_token: 'tok',
    line_mid: 'u123',
  })

  // Read back through a fresh store: the in-memory cache must not be what makes
  // the assertion above pass.
  const { CredentialStore } = await import('./credential-store.js')
  const reopened = new CredentialStore('line', filePath)
  expect(await reopened.get('line_auth_token')).toBe('tok')
})

test('routes volatile E2EE cache to its own file beside the credentials', async () => {
  const { store, filePath } = await fileBackedStore()

  await store.set('line_auth_token', 'tok')
  await store.set('line_e2ee_public_u123', 'pubkey')
  await store.flush()

  const cacheFile = join(dirname(filePath), 'line-e2ee-cache.json')
  expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toEqual({
    line_e2ee_public_u123: 'pubkey',
  })
  // The durable entry must not have been dragged along with it.
  expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
    line_auth_token: 'tok',
  })
  expect(await readdir(dirname(filePath))).toHaveLength(2)
})

test('derives directories with path.dirname, never by slicing on a forward slash', async () => {
  // `filePath.substring(0, filePath.lastIndexOf('/'))` returns '' for a Windows
  // path (there is no '/' in `C:\Users\...`), and `mkdir('')` throws ENOENT
  // straight into a catch that swallows it — so every credential write on
  // Windows failed silently. The behavioural tests above cannot catch this on a
  // POSIX CI runner, where the slice happens to work.
  const source = await readFile(join(SRC, 'auth/credential-store.ts'), 'utf8')
  expect(source).not.toContain("lastIndexOf('/')")
})

test('read-only desktop session disables Keychain mutation', async () => {
  const previousNoKeychain = process.env.YOMI_NO_KEYCHAIN
  const previousReadOnly = process.env.YOMI_READ_ONLY_SESSION
  process.env.YOMI_NO_KEYCHAIN = '0'
  process.env.YOMI_READ_ONLY_SESSION = '1'
  try {
    const { CredentialStore } = await import('./credential-store.js')
    const dir = await mkdtemp(join(tmpdir(), 'yomi-readonly-'))
    const store = new CredentialStore('line', join(dir, 'line.json'))
    if (process.platform === 'darwin') {
      expect(store.secureStorageEnabled).toBe(false)
      expect(store.keychainService).toBeNull()
    }
  } finally {
    if (previousNoKeychain == null) delete process.env.YOMI_NO_KEYCHAIN
    else process.env.YOMI_NO_KEYCHAIN = previousNoKeychain
    if (previousReadOnly == null) delete process.env.YOMI_READ_ONLY_SESSION
    else process.env.YOMI_READ_ONLY_SESSION = previousReadOnly
  }
})
