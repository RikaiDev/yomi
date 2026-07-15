import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Longest edge of the generated poster, matching LINE's own video thumbnails. */
const THUMBNAIL_MAX_EDGE = 384

/**
 * Read a JPEG's pixel dimensions from its first Start-Of-Frame marker.
 *
 * MEDIA_THUMB_INFO must carry the poster's real width/height, and we produce
 * the poster ourselves as JPEG, so a tiny dependency-free SOF parser avoids
 * pulling in an image-decoding library. Returns null if no SOF marker is found.
 *
 * @param jpeg - JPEG bytes.
 * @returns `{ width, height }`, or null when the markers can't be read.
 */
function readJpegDimensions(
  jpeg: Buffer,
): { width: number; height: number } | null {
  // Skip the SOI (0xFFD8); then walk marker segments until a SOF marker.
  let offset = 2
  while (offset + 9 < jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = jpeg[offset + 1]
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry frame dimensions;
    // the non-SOF markers in those ranges (DHT 0xC4, JPG 0xC8, DAC 0xCC) don't.
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    if (isSof) {
      const height = jpeg.readUInt16BE(offset + 5)
      const width = jpeg.readUInt16BE(offset + 7)
      return { width, height }
    }
    // Standalone markers (RSTn/SOI/EOI/TEM) have no length word; everything
    // else is followed by a 2-byte segment length to skip past.
    if (
      (marker >= 0xd0 && marker <= 0xd9) ||
      marker === 0x01 ||
      marker === 0xff
    ) {
      offset += 2
      continue
    }
    const segmentLength = jpeg.readUInt16BE(offset + 2)
    offset += 2 + segmentLength
  }
  return null
}

/**
 * Extract a poster frame from a video, best-effort, using ffmpeg.
 *
 * Grabs the first frame, scaled to fit within {@link THUMBNAIL_MAX_EDGE} on the
 * longest edge (aspect preserved), encoded as JPEG — the same shape LINE's own
 * clients attach as a video's `__ud-preview`. Returns null (never throws) when
 * ffmpeg is absent or fails, so the caller sends the video without a poster
 * rather than not at all.
 *
 * @param videoBytes - Raw video bytes.
 * @returns `{ jpeg, width, height }`, or null when no poster could be made.
 */
export async function extractVideoThumbnail(
  videoBytes: Buffer,
): Promise<{ jpeg: Buffer; width: number; height: number } | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yomi-vthumb-'))
  const inPath = path.join(dir, `in-${crypto.randomUUID()}`)
  const outPath = path.join(dir, `out-${crypto.randomUUID()}.jpg`)
  try {
    await fs.writeFile(inPath, videoBytes)
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'ffmpeg',
        [
          '-y',
          '-i',
          inPath,
          '-frames:v',
          '1',
          '-vf',
          `scale=${THUMBNAIL_MAX_EDGE}:${THUMBNAIL_MAX_EDGE}:force_original_aspect_ratio=decrease`,
          '-f',
          'mjpeg',
          '-q:v',
          '5',
          outPath,
        ],
        { stdio: ['ignore', 'ignore', 'ignore'] },
      )
      proc.on('error', reject)
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)),
      )
    })
    const jpeg = await fs.readFile(outPath)
    if (jpeg.length === 0) {
      return null
    }
    const dims = readJpegDimensions(jpeg)
    if (!dims) {
      return null
    }
    return { jpeg, width: dims.width, height: dims.height }
  } catch {
    return null
  } finally {
    await fs.rm(dir, { force: true, recursive: true }).catch(() => {})
  }
}
