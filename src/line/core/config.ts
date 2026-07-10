/**
 * LINE Desktop client configuration.
 * Shared across LINE protocol clients.
 *
 * Protocol version derived from installed LINE.app via Info.plist.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const LINE_INFO_PLIST_PATH = '/Applications/LINE.app/Contents/Info.plist';

/**
 * Read a plist key from LINE.app, with fallback.
 *
 * @param key - The plist key to read
 * @param fallback - Default value if read fails
 * @returns The plist value or fallback
 */
function plist(key: string, fallback: string): string {
  if (!fs.existsSync(LINE_INFO_PLIST_PATH)) {
    return fallback;
  }
  try {
    return execSync(
      `defaults read ${LINE_INFO_PLIST_PATH} ${key} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
  }
  catch {
    return fallback;
  }
}

/**
 * macOS product version (e.g. "15.3"), NOT Darwin kernel version.
 *
 * @returns The macOS version string
 */
function macosVersion(): string {
  try {
    return execSync('sw_vers -productVersion', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
  }
  catch {
    return '15.0';
  }
}

const LINE_SHORT = plist('CFBundleShortVersionString', '26.0.2');
const LINE_BUILD = plist('CFBundleVersion', '3828');
const LINE_VERSION = `${LINE_SHORT}.${LINE_BUILD}`;
const MACOS_VER = macosVersion();

export const LINE_APP_CONFIG = {
  host: 'ga2.line.naver.jp',

  // Service paths
  talkPath: '/S4',
  syncPath: '/SYNC4',
  authPath: '/AS4',
  revokePath: '/RS4',
  tokenRefreshPath: '/EXT/auth/tokenrefresh/v1',
  qrPath: '/acct/lgn/sq/v1',
  qrLongPollPath: '/acct/lp/lgn/sq/v1',
  pwlessPath: '/acct/lgn/secpwless/v1',
  pwlessLongPollPath: '/acct/lp/lgn/secpwless/v1',

  // Client identification — matches real LINE desktop format
  lineApp: `DESKTOPMAC\t${LINE_VERSION}\tMAC\t${MACOS_VER}`,
  userAgent: `Line/${LINE_VERSION}`,

  // Device info shown on phone during secondary-device approval.
  systemName: os.hostname() || 'yomi',
  modelName: 'yomi',
};
