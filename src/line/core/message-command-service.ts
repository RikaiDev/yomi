import crypto from 'node:crypto'
import { uploadLineObsMediaObject } from '../client/obs-media-client.js'
import { requireLineClient } from './client-runtime.js'
import { CONTENT_TYPE } from './constants.js'
import {
  buildLineVideoChunkHashes,
  encryptLineMediaBytes,
  encryptLineVideoBytes,
} from './media-encrypt.js'
import { i32Field } from './thrift/fields/builders.js'
import { extractVideoThumbnail } from './video-thumbnail.js'

/** LINE OBS service namespace per media kind (image / file / audio / video). */
const OBS_SID_IMAGE = 'emi'
const OBS_SID_FILE = 'emf'
const OBS_SID_AUDIO = 'ema'
const OBS_SID_VIDEO = 'emv'

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
  /**
   * Produce the main OBS body from plaintext + key material. Defaults to the
   * whole-file AES-256-CTR path (image/audio/file), whose MAC covers the whole
   * ciphertext. Video overrides with {@link encryptLineVideoBytes}, whose MAC
   * covers the per-chunk hashes instead.
   */
  encrypt?: (bytes: Buffer, keyMaterial: string) => Promise<Buffer>
  /**
   * Auxiliary OBS objects uploaded alongside the main object (each keyed by an
   * oid suffix) plus extra plaintext contentMetadata to merge. Receives the
   * already-encrypted main body and the media key material (so a kind can
   * encrypt a side object — e.g. a video thumbnail — under the same key).
   * Defaults to the protocol-required `__ud-preview` carrying the same
   * ciphertext, with no extra metadata. Video overrides this to upload the
   * `__ud-hash` chunk-hash manifest a streaming receiver needs, plus an
   * encrypted `__ud-preview` thumbnail and its `MEDIA_THUMB_INFO`.
   */
  auxObjects?: (
    mainBody: Buffer,
    keyMaterial: string,
  ) => Promise<{
    objects: Array<{ suffix: string; data: Buffer }>
    metadata?: Record<string, string>
  }>
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
  const encryptedFile = await (spec.encrypt ?? encryptLineMediaBytes)(
    bytes,
    keyMaterial,
  )

  const { oid } = await uploadLineObsMediaObject({
    accessToken,
    data: encryptedFile,
    mid,
    objectPath: `reqid-${crypto.randomUUID()}`,
    params: { name: spec.uploadName, type: 'file' },
    sid: spec.sid,
  })

  // Auxiliary objects addressed by an oid suffix, plus any extra plaintext
  // metadata they contribute. Default: the `__ud-preview` object the LINE
  // protocol requires even without a separate thumbnail (same ciphertext).
  // Video swaps in the `__ud-hash` chunk-hash manifest and a real encrypted
  // `__ud-preview` thumbnail (with MEDIA_THUMB_INFO).
  const aux = spec.auxObjects
    ? await spec.auxObjects(encryptedFile, keyMaterial)
    : { objects: [{ suffix: '__ud-preview', data: encryptedFile }] }
  for (const object of aux.objects) {
    await uploadLineObsMediaObject({
      accessToken,
      data: object.data,
      mid,
      objectPath: `${oid}${object.suffix}`,
      params: {},
      sid: spec.sid,
    })
  }

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
    ...(aux.metadata ?? {}),
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
     * Send one E2EE audio message through the same upload-then-send pipeline as
     * image/file. Audio uses the whole-file AES path (like image), so unlike a
     * file its name is not sealed. contentMetadata carries FILE_SIZE and, when
     * known, DURATION (milliseconds) for the recipient's player progress bar.
     *
     * @param to - Recipient MID (1:1 `u...`, group `c...`, or room `r...`).
     * @param audioBytes - Raw (plaintext) audio bytes.
     * @param fileName - Original filename (used only for the OBS upload name).
     * @param durationMs - Audio duration in ms; omitted when unknown.
     * @returns The sent message id and the uploaded object id.
     */
    async sendAudio(
      to,
      audioBytes: Buffer,
      fileName: string | null,
      durationMs?: number,
    ) {
      const client = requireLineClient(getClient)
      const mid = e2eeManager.getProfileMid?.()
      if (!mid) {
        throw new Error(
          'Cannot send audio without an authenticated LINE profile MID',
        )
      }
      return sendE2EEMedia(client, mid, e2eeManager, to, audioBytes, {
        sid: OBS_SID_AUDIO,
        contentType: CONTENT_TYPE.AUDIO,
        uploadName: fileName ?? 'audio.m4a',
        metadata: () => {
          const meta: Record<string, string> = {
            FILE_SIZE: String(audioBytes.length),
          }
          if (durationMs != null && Number.isFinite(durationMs)) {
            meta.DURATION = String(Math.round(durationMs))
          }
          return meta
        },
      })
    },

    /**
     * Send one E2EE video through the shared upload-then-send pipeline. Video
     * reuses everything image/file/audio do — the ciphertext is the same
     * whole-file AES-256-CTR bytes — and differs in only two `spec` knobs:
     * `encrypt` swaps the MAC to cover the per-128KB-chunk hashes (so a receiver
     * can verify integrity while streaming), and `auxObjects` uploads the
     * `__ud-hash` chunk-hash manifest that receiver reads. A poster frame is
     * extracted with ffmpeg (best-effort) and uploaded as the encrypted
     * `__ud-preview` (with MEDIA_THUMB_INFO) so the video shows a thumbnail
     * before download; when ffmpeg is unavailable the video still sends, just
     * without a poster.
     *
     * @param to - Recipient MID (1:1 `u...`, group `c...`, or room `r...`).
     * @param videoBytes - Raw (plaintext) video bytes.
     * @param fileName - Original filename (used only for the OBS upload name).
     * @param durationMs - Video duration in ms; omitted when unknown.
     * @returns The sent message id and the uploaded object id.
     */
    async sendVideo(
      to,
      videoBytes: Buffer,
      fileName: string | null,
      durationMs?: number,
    ) {
      const client = requireLineClient(getClient)
      const mid = e2eeManager.getProfileMid?.()
      if (!mid) {
        throw new Error(
          'Cannot send video without an authenticated LINE profile MID',
        )
      }
      // Extract the poster once, up front, so the auxObjects hook can seal it
      // under the pipeline's key material. null (no ffmpeg / failure) => no
      // poster, and the video still sends.
      const thumbnail = await extractVideoThumbnail(videoBytes)
      return sendE2EEMedia(client, mid, e2eeManager, to, videoBytes, {
        sid: OBS_SID_VIDEO,
        contentType: CONTENT_TYPE.VIDEO,
        uploadName: fileName ?? 'video.mp4',
        encrypt: encryptLineVideoBytes,
        // Two auxiliary objects. `__ud-hash`: the concatenated per-chunk SHA-256
        // hashes over the ciphertext WITHOUT its trailing 32-byte MAC — exactly
        // the bytes a streaming receiver re-hashes per chunk (omitted for an
        // empty ciphertext). `__ud-preview`: the poster, encrypted under the
        // SAME key material via the whole-file media path (like an image), with
        // its dimensions surfaced as MEDIA_THUMB_INFO.
        //
        // KNOWN WEAKNESS (upstream, do not "fix" locally): reusing keyMaterial
        // for the poster reuses the AES-CTR keystream. deriveLineMediaKeyMaterial
        // is deterministic, so body and poster get byte-identical encKey AND
        // nonce, and encrypting two different plaintexts under one keystream is
        // a two-time pad: C_body XOR C_poster = P_body XOR P_poster over the
        // shorter length. Both objects sit at derivable OBS paths (`oid` and
        // `oid__ud-preview`), and MP4/JPEG headers are predictable enough to
        // bootstrap each other, so roughly a poster's worth of video plaintext
        // is recoverable by anyone holding both — starting with LINE's servers,
        // which is exactly who E2EE is meant to exclude.
        //
        // It cannot be fixed here. Receivers (this one included, see
        // mcp/media.ts) decrypt `__ud-preview` with the message's keyMaterial,
        // so deriving a separate nonce would make real LINE clients unable to
        // open posters Yomi sends. The fix belongs upstream — domain-separate
        // the HKDF info per object, or seal a second keyMaterial. The only local
        // mitigation is sending no poster at all: `extractVideoThumbnail`
        // returning null already takes that path and the video still sends.
        auxObjects: async (mainBody, keyMaterial) => {
          const objects: Array<{ suffix: string; data: Buffer }> = []
          const hashes = buildLineVideoChunkHashes(
            mainBody.subarray(0, Math.max(0, mainBody.length - 32)),
          )
          if (hashes.length > 0) {
            objects.push({ suffix: '__ud-hash', data: hashes })
          }
          let metadata: Record<string, string> | undefined
          if (thumbnail) {
            objects.push({
              suffix: '__ud-preview',
              data: await encryptLineMediaBytes(thumbnail.jpeg, keyMaterial),
            })
            metadata = {
              MEDIA_THUMB_INFO: JSON.stringify({
                width: thumbnail.width,
                height: thumbnail.height,
              }),
            }
          }
          return { objects, metadata }
        },
        metadata: () => {
          const meta: Record<string, string> = {
            FILE_SIZE: String(videoBytes.length),
          }
          if (durationMs != null && Number.isFinite(durationMs)) {
            meta.DURATION = String(Math.round(durationMs))
          }
          return meta
        },
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
    /**
     * Send a location message (contentType LOCATION) — a plain, non-E2EE
     * message carrying a Location struct (title, address, latitude, longitude).
     *
     * @param to - Recipient MID (1:1 `u...`, group `c...`, or room `r...`).
     * @param latitude - Latitude (Thrift double).
     * @param longitude - Longitude (Thrift double).
     * @param title - Optional place name shown on the pin.
     * @param address - Optional address shown under the pin.
     * @returns The sent message id.
     */
    async sendLocation(
      to,
      latitude: number,
      longitude: number,
      title = '',
      address = '',
    ) {
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error(
          'Cannot send location without finite latitude/longitude',
        )
      }
      // LINE Letter-Seals location too ("can not send using plain mode"
      // otherwise). encryptE2EEMessage wraps an object at contentType 15 as
      // {"location": data} and encrypts it into the chunks — coordinates ride
      // inside the ciphertext, not a plaintext Thrift Location struct.
      const encrypted = await e2eeManager.encryptE2EEMessage(
        to,
        { title, address, latitude, longitude },
        CONTENT_TYPE.LOCATION,
      )
      const sent = await requireLineClient(getClient).sendMessage({
        to,
        text: null,
        contentType: CONTENT_TYPE.LOCATION,
        contentMetadata: encrypted.contentMetadata,
        chunks: encrypted.chunks,
        relatedMessageId: null,
      })
      return { messageId: sent?.id ?? null, sent: true }
    },

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
