/**
 * LINE Passwordless Login Protocol Steps.
 *
 * Flow: createSession → verifyLoginCertificate → requestPinCodeVerif →
 *       checkPinCodeVerified → putExchangeKey → requestPaakAuth →
 *       checkPaakAuthenticated → loginV2
 *
 * Field layouts verified against CHRLINE reference + live test (2026-03-27).
 */

import type { ThriftFieldTuple } from '../../core/thrift/types.js';
import { boolField, encodeCallMessage, mapField, stringField, structField } from '../../core/thrift/index.js';

/**
 * Number of long-poll hops `checkPinCodeVerified` makes before giving up.
 * Each hop is bounded by `PWLESS_POLL_TIMEOUT_MS` (../index.ts) — the two
 * multiplied together give the real client-side ceiling for this step, which
 * is minutes, not the duration of a single hop.
 */
export const PIN_VERIFY_POLL_ATTEMPTS = 15;

/**
 * Number of long-poll hops `checkPaakAuthenticated` makes before giving up.
 * Same relationship to `PWLESS_POLL_TIMEOUT_MS` as `PIN_VERIFY_POLL_ATTEMPTS`.
 */
export const PAAK_AUTH_POLL_ATTEMPTS = 12;

interface PwlessContext {
  sessionId: string;
  seq: number;
  aborted: boolean;
  sendPwless: (data: Buffer) => Promise<any>;
  sendPwlessLongPoll: (data: Buffer) => Promise<any>;
}

/**
 * Step 1: Create a pwless login session with phone number.
 *
 * @param ctx - Pwless login context
 * @param phone - E.164 phone number (e.g. +886912345678)
 * @param region - Region code (e.g. TW, JP)
 * @returns Session ID string
 */
export async function createSession(ctx: PwlessContext, phone: string, region: string): Promise<string> {
  const fields: ThriftFieldTuple[] = [structField(1, [stringField(1, phone), stringField(2, region)])];
  const data = encodeCallMessage('createSession', ctx.seq++, fields);
  const result = await ctx.sendPwless(data);
  const sid = result?.fields?.[0]?.[1];
  if (!sid) {
    throw new Error(`createSession failed: ${JSON.stringify(result)}`);
  }
  return sid;
}

/**
 * Step 2: Verify login certificate (skip PIN if cert valid).
 *
 * @param ctx - Pwless login context
 * @param certificate - Previously saved certificate, or empty string
 * @returns True if certificate is valid (PIN can be skipped)
 */
export async function verifyLoginCertificate(ctx: PwlessContext, certificate: string): Promise<boolean> {
  const fields: ThriftFieldTuple[] = [structField(1, [stringField(1, ctx.sessionId), stringField(2, certificate || '')])];
  const data = encodeCallMessage('verifyLoginCertificate', ctx.seq++, fields);
  const result = await ctx.sendPwless(data);
  return !!(result?.fields?.[0] && !result?.fields?.[1]);
}

/**
 * Step 3a: Request PIN code verification.
 *
 * @param ctx - Pwless login context
 * @returns PIN code string to display to user
 */
export async function requestPinCodeVerif(ctx: PwlessContext): Promise<string> {
  const fields: ThriftFieldTuple[] = [structField(1, [stringField(1, ctx.sessionId)])];
  const data = encodeCallMessage('requestPinCodeVerif', ctx.seq++, fields);
  const result = await ctx.sendPwless(data);
  const pin = result?.fields?.[0]?.[1];
  if (!pin) {
    throw new Error(`requestPinCodeVerif failed: ${JSON.stringify(result)}`);
  }
  return pin;
}

/**
 * Step 3b: Long-poll until PIN is verified on phone.
 *
 * @param ctx - Pwless login context
 * @returns True if PIN verified, false if timed out
 */
export async function checkPinCodeVerified(ctx: PwlessContext): Promise<boolean> {
  for (let i = 0; i < PIN_VERIFY_POLL_ATTEMPTS; i++) {
    if (ctx.aborted) {
      return false;
    }
    const fields: ThriftFieldTuple[] = [structField(1, [stringField(1, ctx.sessionId)])];
    const data = encodeCallMessage('checkPinCodeVerified', ctx.seq++, fields);
    const result = await ctx.sendPwlessLongPoll(data);
    if (result.error === 'timeout' || result.error) {
      continue;
    }
    if (result.fields && !result.fields[1]) {
      return true;
    }
  }
  return false;
}

/**
 * Step 4: Exchange E2EE public key with server.
 * Uses MAP type for key-value exchange.
 *
 * @param ctx - Pwless login context
 * @param publicKeyBase64 - NaCl X25519 public key in base64
 */
export async function putExchangeKey(ctx: PwlessContext, publicKeyBase64: string): Promise<void> {
  const fields: ThriftFieldTuple[] = [structField(1, [
    stringField(1, ctx.sessionId),
    mapField(2, 11, 11, { e2eeVersion: '1', temporalPublicKey: publicKeyBase64 }),
  ])];
  const data = encodeCallMessage('putExchangeKey', ctx.seq++, fields);
  await ctx.sendPwless(data);
}

/**
 * Step 5: Request PAAK (biometric) authentication.
 *
 * @param ctx - Pwless login context
 */
export async function requestPaakAuth(ctx: PwlessContext): Promise<void> {
  const fields: ThriftFieldTuple[] = [structField(1, [stringField(1, ctx.sessionId)])];
  const data = encodeCallMessage('requestPaakAuth', ctx.seq++, fields);
  await ctx.sendPwless(data);
}

/**
 * Step 6: Long-poll until biometric is confirmed on phone.
 *
 * @param ctx - Pwless login context
 * @returns True if PAAK confirmed
 */
export async function checkPaakAuthenticated(ctx: PwlessContext): Promise<boolean> {
  for (let i = 0; i < PAAK_AUTH_POLL_ATTEMPTS; i++) {
    if (ctx.aborted) {
      return false;
    }
    const fields: ThriftFieldTuple[] = [structField(1, [
      stringField(1, ctx.sessionId),
      stringField(2, 'CHANNELGW'),
      boolField(3, true),
    ])];
    const data = encodeCallMessage('checkPaakAuthenticated', ctx.seq++, fields);
    const result = await ctx.sendPwlessLongPoll(data);
    if (result.error === 'timeout' || result.error) {
      continue;
    }
    if (result.fields?.[0] && !result.fields?.[1]) {
      return true;
    }
  }
  return false;
}

/**
 * Step 7: Retrieve E2EE key from server.
 * Must be called after PAAK and before loginV2 to complete the session properly.
 *
 * @param ctx - Pwless login context
 * @returns E2EE key response (encryptedKeyChain, publicKey, etc.)
 */
export async function getE2eeKey(ctx: PwlessContext): Promise<any> {
  const fields: ThriftFieldTuple[] = [structField(1, [stringField(1, ctx.sessionId)])];
  const data = encodeCallMessage('getE2eeKey', ctx.seq++, fields);
  const result = await ctx.sendPwless(data);
  return result?.fields?.[0] ?? null;
}

/**
 * Step 8: Final login call. Returns authToken, certificate, mid.
 *
 * @param ctx - Pwless login context
 * @param systemName - Device hostname
 * @returns Login result with authToken, refreshToken, certificate, mid
 */
export async function loginV2(ctx: PwlessContext, systemName: string): Promise<any> {
  const fields: ThriftFieldTuple[] = [structField(1, [
    stringField(1, ctx.sessionId),
    boolField(2, true),
    stringField(3, systemName),
    stringField(4, 'CHANNELGW'),
  ])];
  const data = encodeCallMessage('loginV2', ctx.seq++, fields);
  const result = await ctx.sendPwless(data);
  if (result?.fields?.[1]) {
    const exc = result.fields[1];
    throw new Error(`loginV2 failed: code=${exc[1]} msg="${exc[2]}"`);
  }
  const rp = result?.fields?.[0];
  if (!rp) {
    throw new Error(`loginV2: unexpected response`);
  }
  const tokenInfo = rp[3];
  return {
    authToken: tokenInfo?.[1],
    refreshToken: tokenInfo?.[2],
    certificate: rp[2],
    mid: rp[5],
  };
}
