import crypto from 'node:crypto'
import { uploadLineObsMediaObject } from '../client/obs-media-client.js'
import { requireLineClient } from './client-runtime.js'
import { CONTENT_TYPE } from './constants.js'
import { encryptLineMediaBytes } from './media-encrypt.js'
import { i32Field } from './thrift/fields/builders.js'

/** LINE OBS service namespace per media kind (image vs. file attachment). */
const OBS_SID_IMAGE = 'emi'
const OBS_SID_FILE = 'emf'

/** Per-kind knobs for the one shared E2EE media send pipeline. */
interface E2EEMediaSpec {
  /** OBS service namespace: OBS_SID_IMAGE | OBS_SID_FILE. */
  sid: string
  /** LINE content type: CONTENT_TYPE.IMAGE | CONTENT_TYPE.FILE. */
  contentType: number
  /** `name` param for the OBS upload. */
  uploadName: string
  /** Fields sealed INSIDE the E2EE payload alongside keyMaterial (e.g. a file's name — it is E2EE, not plaintext). */
  sealed?: Record<string, unknown>
  /**
   * Per-kind PLAINTEXT contentMetadata, given the encrypted byte length.
   * These fields differ by kind and are NOT shared: an image carries
   * MEDIA_CONTENT_INFO (with the encrypted size), a file carries FILE_SIZE
   * (the plaintext size) and no MEDIA_CONTENT_INFO — matching what LINE's own
   * clients emit. OID/SID/e2eeVersion are added by the pipeline for both.
   */
  metadata: (encryptedLength: number) => Record<string, string>
}

/**
 * The one E2EE media send pipeline, shared by every media kind. Encrypts the
 * bytes with a fresh random key, uploads the ciphertext (original + the
 * protocol-required preview object) to OBS, then sends an E2EE data message
 * that seals the key material (plus any per-kind `sealed` fields) and points
 * at the uploaded object via OID/SID. Image vs. file differ ONLY in `spec`
 * (namespace, content type, what is sealed vs. exposed) — sendImage/sendFile
 * are thin callers so there is exactly one implementation, never a second copy
 * that can drift.
 *
 * @param client - Connected LINE client.
 * @param mid - Sender's own MID (the OBS object is addressed by the sender).
 * @param e2eeManager - LINE E2EE manager (dispatches pairwise vs. group by recipient MID).
 * @param to - Recipient MID (1:1 `u...`, group `c...`, or room `r...`).
 * @param bytes - Raw (plaintext) media bytes.
 * @param spec - Per-kind knobs.
 * @returns The sent message id and uploaded object id.
 */
async function sendE2EEMedia(
  client: any,
  mid: string,
  e2eeManager: any,
  to: string,
  bytes: Buffer,
  spec: E2EEMediaSpec,
): Promise<{ messageId: string | null; oid: string; sent: true }> {
  const accessToken = await acquireUploadAccessToken(client)
  const keyMaterial = crypto.randomBytes(32).toString('base64')
  const encryptedFile = await encryptLineMediaBytes(bytes, keyMaterial)

  const { oid } = await uploadLineObsMediaObject({
    accessToken,
    data: encryptedFile,
    mid,
    objectPath: `reqid-${crypto.randomUUID()}`,
    params: { name: spec.uploadName, type: 'file' },
    sid: spec.sid,
  })

  // The preview object is required by the LINE protocol even when there is no
  // separate thumbnail to offer — upload the same ciphertext under the preview
  // path.
  await uploadLineObsMediaObject({
    accessToken,
    data: encryptedFile,
    mid,
    objectPath: `${oid}__ud-preview`,
    params: {},
    sid: spec.sid,
  })

  const encrypted = await e2eeManager.encryptE2EEMessage(
    to,
    { keyMaterial, ...(spec.sealed ?? {}) },
    spec.contentType,
  )
  const contentMetadata = {
    ...encrypted.contentMetadata,
    e2eeVersion: '2',
    OID: oid,
    SID: spec.sid,
    ...spec.metadata(encryptedFile.length),
  }

  const sent = await client.sendMessage({
    chunks: encrypted.chunks,
    contentMetadata,
    contentType: spec.contentType,
    relatedMessageId: null,
    text: null,
    to,
  })

  return { messageId: sent?.id ?? null, oid, sent: true }
}

/**
 * Acquire the encrypted access token the OBS upload gateway requires (the
 * plain session JWT is rejected there). LINE's TalkService returns a
 * `\x1e`-separated token; the gateway wants the second segment.
 *
 * @param client - Connected LINE client.
 * @returns Encrypted access token segment for X-Line-Access on uploads.
 */
async function acquireUploadAccessToken(client: any): Promise<string> {
  const result = await client.sendTalk('acquireEncryptedAccessToken', [
    i32Field(2, 2),
  ])
  const token = result?.fields?.[0]
  if (typeof token !== 'string' || !token.includes('\x1e')) {
    throw new Error('Failed to acquire encrypted access token for media upload')
  }
  return token.split('\x1e')[1]
}

/**
 * Resolve the lowercase file extension from a filename, defaulting to jpg
 * when absent or ambiguous.
 *
 * @param fileName - Original filename, if known.
 * @returns Lowercase extension without the leading dot.
 */
function resolveImageExtension(fileName: string | null | undefined): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(fileName ?? '')
  return match ? match[1].toLowerCase() : 'jpg'
}

/**
 * Build the LINE message command boundary for a connected runtime.
 *
 * @param getClient - Deferred LINE client accessor
 * @param e2eeManager - LINE E2EE manager
 * @returns Message command methods
 */
export function createMessageCommandService(getClient, e2eeManager) {
  return {
    /**
     * Send a LINE message, optionally preparing an E2EE payload first.
     *
     * `text.contentMetadata`, when supplied, is merged onto whatever
     * `contentMetadata` the send would otherwise carry — e.g. an outbound
     * `MENTION` payload (see `../mention.ts`) built by the caller.
     * `contentMetadata` is a plain Thrift map field carried alongside the
     * message, never part of the E2EE ciphertext chunks, so merging it in
     * does not touch what gets encrypted or how; it is a no-op when the
     * caller supplies nothing, so existing behavior is unchanged.
     *
     * @param to - Recipient MID
     * @param text - Text content or richer message options
     * @returns LINE sendMessage result
     */
    async sendMessage(to, text) {
      if (typeof text === 'object' && text !== null && text.e2ee) {
        const encrypted = await e2eeManager.encryptE2EEMessage(
          to,
          text.text,
          text.contentType ?? 0,
        )
        return requireLineClient(getClient).sendMessage({
          to,
          text: null,
          contentType: encrypted.contentType,
          contentMetadata: text.contentMetadata
            ? { ...encrypted.contentMetadata, ...text.contentMetadata }
            : encrypted.contentMetadata,
          chunks: encrypted.chunks,
          relatedMessageId: text.relatedMessageId ?? null,
          messageRelationType: text.messageRelationType ?? null,
          relatedMessageServiceCode: text.relatedMessageServiceCode ?? null,
        })
      }

      // Plaintext path, extended to carry contentMetadata (e.g. mentions)
      // without requiring the E2EE branch above. Does not disturb the
      // legacy `sendMessage(to, "plain string")` call form other call
      // sites rely on — that keeps hitting the final line untouched.
      if (typeof text === 'object' && text !== null && text.contentMetadata) {
        return requireLineClient(getClient).sendMessage({
          to,
          text: text.text ?? null,
          contentMetadata: text.contentMetadata,
        })
      }

      return requireLineClient(getClient).sendMessage(to, text)
    },

    /**
     * Send one E2EE image via the LINE OBS upload-then-send flow: encrypt
     * the image bytes with a fresh random key, upload the ciphertext
     * (original + preview object), then seal that key material inside an
     * E2EE data message pointing at the uploaded object.
     *
     * Supports 1:1 chats, groups, and rooms — `e2eeManager.encryptE2EEMessage`
     * below dispatches on the recipient MID's prefix (`u`/`c`/`r`) and takes
     * the pairwise peer-key path for `u` or the group-key path for `c`/`r`.
     * The OBS upload itself has no 1:1 dependency: it is addressed by the
     * *sender's own* mid (`e2eeManager.getProfileMid()`), not the recipient,
     * since it is uploading the sender's media object for later retrieval.
     *
     * Exactly one send per call — no retry, no queueing. If the E2EE key
     * material cannot be resolved (peer negotiation fails, or a group's
     * E2EE key cannot be resolved) or the OBS upload is rejected, the
     * underlying call throws and no message is sent — never a silent
     * fallback.
     *
     * @param to - Recipient MID (1:1 `u...`, group `c...`, or room `r...`).
     * @param imageBytes - Raw (plaintext) image bytes to send.
     * @param fileName - Original filename, used to derive the extension.
     * @returns The sent message id and the uploaded object id.
     */
    async sendImage(to, imageBytes: Buffer, fileName: string | null) {
      const client = requireLineClient(getClient)
      const mid = e2eeManager.getProfileMid?.()
      if (!mid) {
        throw new Error(
          'Cannot send image without an authenticated LINE profile MID',
        )
      }
      const extension = resolveImageExtension(fileName)
      return sendE2EEMedia(client, mid, e2eeManager, to, imageBytes, {
        sid: OBS_SID_IMAGE,
        contentType: CONTENT_TYPE.IMAGE,
        uploadName: fileName ?? `image.${extension}`,
        metadata: (encryptedLength) => ({
          MEDIA_CONTENT_INFO: JSON.stringify({
            animated: false,
            category: 'original',
            extension,
            fileSize: encryptedLength,
          }),
        }),
      })
    },

    /**
     * Send one E2EE file attachment (any type) through the same upload-then-
     * send pipeline as {@link sendImage}. The only differences: the file OBS
     * namespace, contentType FILE, and the original filename sealed inside the
     * E2EE payload (LINE keeps a file's name end-to-end encrypted, not in
     * plaintext metadata) so the recipient recovers it on decrypt.
     *
     * Exactly one send per call — no retry. Throws (sending nothing) if the
     * profile MID is missing, the filename is empty, E2EE key material cannot
     * be resolved, or the OBS upload is rejected.
     *
     * @param to - Recipient MID (1:1 `u...`, group `c...`, or room `r...`).
     * @param fileBytes - Raw (plaintext) file bytes to send.
     * @param fileName - Original filename (required; sealed E2EE for the recipient).
     * @returns The sent message id and the uploaded object id.
     */
    async sendFile(to, fileBytes: Buffer, fileName: string) {
      const client = requireLineClient(getClient)
      const mid = e2eeManager.getProfileMid?.()
      if (!mid) {
        throw new Error(
          'Cannot send file without an authenticated LINE profile MID',
        )
      }
      if (!fileName) {
        throw new Error('Cannot send file without a fileName')
      }
      return sendE2EEMedia(client, mid, e2eeManager, to, fileBytes, {
        sid: OBS_SID_FILE,
        contentType: CONTENT_TYPE.FILE,
        uploadName: fileName,
        sealed: { fileName },
        // Files carry FILE_SIZE (plaintext size) and NO MEDIA_CONTENT_INFO —
        // this matches what LINE's own clients emit for a file attachment.
        metadata: () => ({ FILE_SIZE: String(fileBytes.length) }),
      })
    },

    /**
     * Share a LINE contact card. Unlike image/file, this is NOT media: no OBS
     * upload and no media E2EE — it is a plain message with contentType CONTACT
     * whose `contentMetadata` names the shared person by mid. The shape mirrors
     * what LINE clients emit: `{ mid, displayName, app_extension_type: 'null' }`
     * (LINE's server adds `seq`). Exactly one send per call.
     *
     * @param to - Recipient MID (1:1 `u...`, group `c...`, or room `r...`).
     * @param contactMid - MID of the person whose card is being shared.
     * @param displayName - Display name to show on the card (may be empty; LINE resolves from mid).
     * @returns The sent message id.
     */
    async sendContact(to, contactMid: string, displayName: string) {
      if (!contactMid) {
        throw new Error('Cannot send contact without a contactMid')
      }
      const sent = await requireLineClient(getClient).sendMessage({
        to,
        text: null,
        contentType: CONTENT_TYPE.CONTACT,
        contentMetadata: {
          mid: contactMid,
          displayName: displayName ?? '',
          app_extension_type: 'null',
        },
        relatedMessageId: null,
      })
      return { messageId: sent?.id ?? null, sent: true }
    },

    /**
     * Send a LINE sticker. Like send_contact this is a plain message with a
     * dedicated contentType (STICKER) whose contentMetadata names the sticker
     * by package + id — no OBS, no media E2EE. Shape { STKID, STKPKGID, STKVER }
     * mirrors what LINE clients emit (LINE's server adds STKTXT/seq).
     *
     * @param to - Recipient MID (1:1 `u...`, group `c...`, or room `r...`).
     * @param stickerId - LINE sticker id (STKID).
     * @param packageId - LINE sticker package id (STKPKGID).
     * @param version - Sticker version (STKVER); defaults to '1'.
     * @returns The sent message id.
     */
    async sendSticker(to, stickerId: string, packageId: string, version = '1') {
      if (!stickerId || !packageId) {
        throw new Error('Cannot send sticker without stickerId and packageId')
      }
      const sent = await requireLineClient(getClient).sendMessage({
        to,
        text: null,
        contentType: CONTENT_TYPE.STICKER,
        contentMetadata: {
          STKID: stickerId,
          STKPKGID: packageId,
          STKVER: version,
        },
        relatedMessageId: null,
      })
      return { messageId: sent?.id ?? null, sent: true }
    },
  }
}
