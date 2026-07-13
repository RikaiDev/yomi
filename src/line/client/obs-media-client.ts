import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import https from 'node:https'
import { LINE_APP_CONFIG } from '../core/config.js'
import { TBinaryWriter } from '../core/thrift/binary/binary-writer.js'
import { THRIFT_TYPE } from '../core/thrift/types.js'

const OBS_HOST = 'obs.line-apps.com'
// Uploads do NOT go to the OBS domain — they POST through the LINE gateway
// (LINE_GW_HOST_DOMAIN). obs.line-apps.com returns 400 for the /oa/ upload
// route; only the gateway accepts it, and only with an encrypted access token.
const OBS_UPLOAD_HOST = 'gwz.line.naver.jp'

/**
 * Build LINE talk metadata required for OBS media downloads.
 *
 * @param messageId - LINE message id.
 * @returns Base64 encoded X-Talk-Meta header.
 */
function buildTalkMeta(messageId: string): string {
  const writer = new TBinaryWriter()
  writer.writeFieldBegin(4, THRIFT_TYPE.STRING)
  writer.writeString(messageId)
  writer.writeFieldBegin(27, THRIFT_TYPE.LIST)
  writer.writeList(THRIFT_TYPE.STRUCT, [])
  writer.writeFieldStop()
  const message = Buffer.from(writer.getBuffer()).toString('base64')
  return Buffer.from(JSON.stringify({ message })).toString('base64')
}

/**
 * Download one LINE OBS media object.
 *
 * @param client - LINE protocol client.
 * @param options - OBS object options.
 * @param options.messageId - LINE message id.
 * @param options.oid - Object id.
 * @param options.sid - Service namespace.
 * @param options.preview - Whether to fetch the preview object.
 * @returns Downloaded encrypted bytes.
 */
export function downloadLineObsMediaObject(
  client: any,
  options: {
    messageId: string
    oid: string
    preview?: boolean
    sid: string
  },
): Promise<Buffer> {
  const oid = options.preview ? `${options.oid}__ud-preview` : options.oid
  const requestPath = `/r/talk/${options.sid}/${oid}`
  const headers = {
    'User-Agent': LINE_APP_CONFIG.userAgent,
    'X-Line-Access': client.authToken,
    'X-Line-Application': LINE_APP_CONFIG.lineApp,
    'X-Talk-Meta': buildTalkMeta(options.messageId),
    accept: 'application/x-thrift',
    'accept-encoding': 'gzip',
    'x-lal': 'ja_JP',
    'x-lhm': 'GET',
    'x-lpv': '1',
  }

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        headers,
        hostname: OBS_HOST,
        method: 'GET',
        path: requestPath,
        port: 443,
        timeout: 30000,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const body = Buffer.concat(chunks)
          if (!response.statusCode || response.statusCode >= 400) {
            reject(
              new Error(
                `LINE OBS download failed: status=${response.statusCode || 'unknown'} bytes=${body.length}`,
              ),
            )
            return
          }
          resolve(body)
        })
      },
    )
    request.on('timeout', () => {
      request.destroy()
      reject(new Error('LINE OBS download timed out'))
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Upload one LINE OBS media object (image bytes, or its preview object).
 *
 * Mirrors {@link downloadLineObsMediaObject}'s auth/header scheme, swapped
 * to a POST body upload. Callers are responsible for encrypting `data`
 * (ciphertext‖MAC) before calling this — this function performs no
 * encryption of its own.
 *
 * @param options - OBS object options.
 * @param options.sid - Service namespace (e.g. 'emi' for image).
 * @param options.objectPath - Object path segment (e.g. `reqid-<uuid>`, or `<oid>__ud-preview`).
 * @param options.data - Encrypted bytes to upload as the request body.
 * @param options.mid - Authenticated self MID (sent as X-Line-Mid).
 * @param options.accessToken - Encrypted access token (acquireEncryptedAccessToken, `\x1e`-split index 1); the gateway rejects the plain session JWT.
 * @param options.params - Extra fields merged into the X-Obs-Params header.
 * @returns The server-assigned object id and content hash.
 */
export async function uploadLineObsMediaObject(options: {
  sid: string
  objectPath: string
  data: Buffer
  mid: string
  accessToken: string
  params?: Record<string, unknown>
}): Promise<{ oid: string; hash: string | null }> {
  // Uploads POST to the LINE gateway (OBS_UPLOAD_HOST) at /oa/r/talk/{sid}/{oid}
  // — a different host AND route than downloads (obs.line-apps.com /r/talk/...).
  // The gateway requires the encrypted access token (not the session JWT), an
  // application/octet-stream body, AND HTTP/2: over HTTP/1.1 (node:https) it
  // returns 503, so this uses fetch, which negotiates h2 via ALPN. Verified
  // live against the real gateway (201 Created). The download-only x-lhm/x-lpv
  // are absent.
  const requestUrl = `https://${OBS_UPLOAD_HOST}/oa/r/talk/${options.sid}/${options.objectPath}`
  // The gateway requires `type` and `name` in X-Obs-Params on EVERY upload,
  // including the preview subresource — a request missing `name` is rejected
  // (400 without name, 503 with neither name nor type). Defaults are supplied
  // here so callers (e.g. the preview upload) need not repeat them; explicit
  // params still override.
  const obsParams = {
    type: 'file',
    ver: '2.0',
    name: randomUUID(),
    ...(options.params ?? {}),
  }
  const headers = {
    'User-Agent': LINE_APP_CONFIG.userAgent,
    'X-Line-Access': options.accessToken,
    'X-Line-Application': LINE_APP_CONFIG.lineApp,
    'X-Line-Mid': options.mid,
    'X-Obs-Params': Buffer.from(JSON.stringify(obsParams)).toString('base64'),
    'Content-Type': 'application/octet-stream',
    'x-lal': 'ja_JP',
  }
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers,
    body: options.data,
  })
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`LINE OBS upload failed: status=${response.status}`)
  }
  const oid = response.headers.get('x-obs-oid')
  if (!oid) {
    throw new Error(
      `LINE OBS upload succeeded but response is missing x-obs-oid header (status=${response.status})`,
    )
  }
  return { oid, hash: response.headers.get('x-obs-hash') }
}
