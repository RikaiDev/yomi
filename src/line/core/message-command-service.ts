import crypto from 'node:crypto';
import { requireLineClient } from './client-runtime.js';
import { CONTENT_TYPE } from './constants.js';
import { encryptLineMediaBytes } from './media-encrypt.js';
import { uploadLineObsMediaObject } from '../client/obs-media-client.js';
import { i32Field } from './thrift/fields/builders.js';

/** LINE OBS service namespace for image media. */
const OBS_SID_IMAGE = 'emi';

/**
 * Acquire the encrypted access token the OBS upload gateway requires (the
 * plain session JWT is rejected there). LINE's TalkService returns a
 * `\x1e`-separated token; the gateway wants the second segment.
 *
 * @param client - Connected LINE client.
 * @returns Encrypted access token segment for X-Line-Access on uploads.
 */
async function acquireUploadAccessToken(client: any): Promise<string> {
  const result = await client.sendTalk('acquireEncryptedAccessToken', [i32Field(2, 2)]);
  const token = result?.fields?.[0];
  if (typeof token !== 'string' || !token.includes('\x1e')) {
    throw new Error('Failed to acquire encrypted access token for media upload');
  }
  return token.split('\x1e')[1];
}

/**
 * Resolve the lowercase file extension from a filename, defaulting to jpg
 * when absent or ambiguous.
 *
 * @param fileName - Original filename, if known.
 * @returns Lowercase extension without the leading dot.
 */
function resolveImageExtension(fileName: string | null | undefined): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(fileName ?? '');
  return match ? match[1].toLowerCase() : 'jpg';
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
        );
        return requireLineClient(getClient).sendMessage({
          to,
          text: null,
          contentType: encrypted.contentType,
          contentMetadata: text.contentMetadata
            ? { ...encrypted.contentMetadata, ...text.contentMetadata }
            : encrypted.contentMetadata,
          chunks: encrypted.chunks,
          relatedMessageId: text.relatedMessageId ?? null,
        });
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
        });
      }

      return requireLineClient(getClient).sendMessage(to, text);
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
      const client = requireLineClient(getClient);
      const mid = e2eeManager.getProfileMid?.();
      if (!mid) {
        throw new Error('Cannot send image without an authenticated LINE profile MID');
      }
      const extension = resolveImageExtension(fileName);
      const accessToken = await acquireUploadAccessToken(client);
      const keyMaterial = crypto.randomBytes(32).toString('base64');
      const encryptedFile = await encryptLineMediaBytes(imageBytes, keyMaterial);

      const { oid } = await uploadLineObsMediaObject({
        accessToken,
        data: encryptedFile,
        mid,
        objectPath: `reqid-${crypto.randomUUID()}`,
        params: { name: fileName ?? `image.${extension}`, type: 'file' },
        sid: OBS_SID_IMAGE,
      });

      // The preview object is required by the LINE protocol even though
      // Yomi has no separate thumbnail to offer — upload the same
      // ciphertext under the preview path.
      await uploadLineObsMediaObject({
        accessToken,
        data: encryptedFile,
        mid,
        objectPath: `${oid}__ud-preview`,
        params: {},
        sid: OBS_SID_IMAGE,
      });

      const encrypted = await e2eeManager.encryptE2EEMessage(to, { keyMaterial }, CONTENT_TYPE.IMAGE);
      const contentMetadata = {
        ...encrypted.contentMetadata,
        e2eeVersion: '2',
        MEDIA_CONTENT_INFO: JSON.stringify({ animated: false, category: 'original', extension, fileSize: encryptedFile.length }),
        OID: oid,
        SID: OBS_SID_IMAGE,
      };

      const sent = await client.sendMessage({
        chunks: encrypted.chunks,
        contentMetadata,
        contentType: CONTENT_TYPE.IMAGE,
        relatedMessageId: null,
        text: null,
        to,
      });

      return { messageId: sent?.id ?? null, oid, sent: true };
    },
  };
}
