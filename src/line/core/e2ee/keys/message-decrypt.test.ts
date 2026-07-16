import { expect, test } from 'bun:test'
import { performDecrypt } from './message-decrypt.js'

/** Minimal chunks shape performDecrypt reads. */
function chunksWithVersion(version: string) {
  return {
    salt: Buffer.alloc(8),
    ciphertext: Buffer.alloc(32),
    sign: Buffer.alloc(12),
    version,
    senderKeyId: '1',
    receiverKeyId: '2',
    toType: 0,
    isUserChat: true,
    chatMid: null,
    isSelf: false,
  }
}

test('an unknown E2EE version is refused rather than downgraded to v1', () => {
  // `version` is envelope metadata from whoever sends the message. It used to
  // be `!== '2'` -> v1, quietly selecting the one cipher here that
  // authenticates nothing. Anything unrecognized must fail loudly instead.
  for (const version of ['3', '', 'x', '2 ', '02']) {
    expect(() =>
      performDecrypt(
        { to: 'u1', from: 'u2', contentType: 0 },
        chunksWithVersion(version) as any,
        Buffer.alloc(32),
        Buffer.alloc(32),
        null,
        '2',
      ),
    ).toThrow(/Unsupported E2EE version/)
  }
})
