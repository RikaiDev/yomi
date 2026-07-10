import type { Buffer } from 'node:buffer';

/**
 * Key pair for E2EE key exchange
 */
export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface ImportedKey extends KeyPair {
  keyId: string;
  version?: string;
  createdTime?: number | null;
}

export interface GroupKey {
  keyId: string;
  privateKey: Buffer;
}

export interface GroupKeyFetchState {
  promise: Promise<GroupKey | undefined>;
  receiverKeyId: string;
}

export interface NegotiatedPublicKey {
  keyId: string;
  keyData: Buffer;
}

export interface HistoricalPeerKey extends NegotiatedPublicKey {
  mid: string;
}

export interface PeerPublicKeyCandidate extends NegotiatedPublicKey {
  source?: string;
}

export interface RawNegotiatedPublicKeyShape {
  keyId?: unknown;
  keyData?: unknown;
  publicKey?: {
    keyId?: unknown;
    keyData?: unknown;
    2?: unknown;
    4?: unknown;
  };
  2?: unknown;
  4?: unknown;
}

export interface EncryptedMessagePayload {
  chunks: Buffer[];
  contentMetadata: Record<string, string>;
  contentType: number;
}

/**
 * Context interface passed to module-level E2EE functions.
 * Implemented by KeyManager so it can be passed as `this`.
 */
export interface KeyManagerContext {
  getSelfKeyByMid: (mid: string) => ImportedKey | undefined;
  getSelfKeyById: (keyId: string) => ImportedKey | undefined;
  getProfileMid: () => string | undefined;
  raiseWarning: (reason: string, details?: Record<string, any>) => void;
  logGroupKeyEvent: (event: string, context?: Record<string, any>) => void;
  logE2EEWarning?: (event: string, context?: Record<string, any>) => void;
  readChunkKeyId?: (value: any) => string | null;
  getClient: () => any;
  getStore: () => any;
  peerPublicKeys: Map<string, Buffer>;
  groupKeys: Map<string, GroupKey>;
  groupKeyFetches: Map<string, GroupKeyFetchState>;
}
