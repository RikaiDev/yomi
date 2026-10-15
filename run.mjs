#!/usr/bin/env node
/**
 * Yomi entry point — the npm shim.
 *
 * Usage:
 *   yomi                Start the MCP stdio server (default)
 *   yomi serve          Same as above, explicit
 *   yomi login [...]    Run the passwordless login flow in a terminal
 *   yomi help           Show this help
 *   yomi version        Print version
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the compiled `dist/` build when it exists (this is what the npm
// tarball ships), and fall back to the TypeScript sources for a repo
// checkout that has not been built yet.
//
// The fallback CANNOT rescue an installed package: Node refuses to strip
// types for files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_
// STRIPPING), which is exactly how every 0.1.x release failed to start.
// `files` in package.json must therefore always ship `dist/`.
const distUrl = new URL('./dist/', import.meta.url);
const sourceRoot = fileURLToPath(new URL('./src/', import.meta.url));

function newestMtime(directory) {
  if (!existsSync(directory)) return 0;
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
    else if (entry.name.endsWith('.ts')) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

const distServerPath = fileURLToPath(new URL('mcp/server.js', distUrl));
const distMtime = existsSync(distServerPath) ? statSync(distServerPath).mtimeMs : 0;
const sourceIsNewer = existsSync(sourceRoot) && newestMtime(sourceRoot) > distMtime;
const built = existsSync(distServerPath) && process.env.YOMI_DEV_SOURCE !== '1' && !sourceIsNewer;
const base = built ? distUrl : new URL('./src/', import.meta.url);
const ext = built ? '.js' : '.ts';

/** Import a module by its path under src/, resolved to dist/ when built. */
const load = (path) => import(new URL(path + ext, base).href);

const writeStdout = (text) =>
  new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
const writeJson = (value) => writeStdout(`${JSON.stringify(value)}\n`);

const args = process.argv.slice(2);
const cmd = args[0] ?? 'serve';

switch (cmd) {
  case 'login': {
    const { cliLogin } = await load('cli/login');
    const code = await cliLogin(args.slice(1));
    process.exit(code);
  }
  case 'setup-mcp':
  case 'integrate': {
    const { integrateAllClients, integrateClient, getClientTargets } = await load('mcp/integrator');
    const targetArg = args[1];
    if (targetArg) {
      const targets = getClientTargets();
      const matched = targets.find(t => t.id === targetArg || t.name.toLowerCase().includes(targetArg.toLowerCase()));
      if (matched) {
        const res = integrateClient(matched);
        console.log(JSON.stringify(res));
      } else {
        console.error(`Target client "${targetArg}" not recognized.`);
        process.exit(1);
      }
    } else {
      const report = integrateAllClients();
      console.log(JSON.stringify(report));
    }
    process.exit(0);
  }
  case 'chats':
  case 'conversations': {
    const { cliListConversationsJson } = await load('cli/query');
    const limit = args[1] && args[1] !== 'all' ? parseInt(args[1], 10) : undefined;
    const attentionOnly = args.includes('--attention-only');
    const semantic = args.includes('--semantic');
    const json = await cliListConversationsJson({ limit, attentionOnly, semantic });
    await writeJson(json);
    process.exit(0);
  }
  case 'desktop-inbox': {
    // Keep one authenticated LINE runtime for the complete desktop startup
    // pass. Its resume result is the session authority; do not infer logout
    // from an empty list, a cache miss, or a second probe process.
    const { LineProtocolService } = await load('line/core/service');
    const { cliListConversationsJson } = await load('cli/query');
    const service = new LineProtocolService();
    const connected = await service.resumeSession();
    if (!connected) {
      await writeJson({
        session: { connected: false, reason: service.loginReason ?? 'unavailable' },
        chats: [],
      });
      process.exit(0);
    }
    const chats = await cliListConversationsJson({}, service);
    await writeJson({ session: { connected: true, reason: null }, chats });
    process.exit(0);
  }
  case 'desktop-startup-messages': {
    // One shared runtime warms all requested rooms at launch. This is a
    // startup batch, not a click-triggered series of independent sessions.
    const { LineProtocolService } = await load('line/core/service');
    const { cliGetChatMessagesJson } = await load('cli/query');
    const chatIds = args.slice(1).filter(Boolean);
    const service = new LineProtocolService();
    const connected = await service.resumeSession();
    if (!connected) {
      await writeJson({
        session: { connected: false, reason: service.loginReason ?? 'unavailable' },
        messages: {},
      });
      process.exit(0);
    }
    const messages = {};
    for (const chatId of chatIds) {
      messages[chatId] = await cliGetChatMessagesJson(chatId, 40, service);
    }
    await writeJson({ session: { connected: true, reason: null }, messages });
    process.exit(0);
  }
  case 'work-item': {
    const operation = args[1] || 'create';
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    let payload;
    try {
      payload = JSON.parse(input || '{}');
    } catch {
      console.error(JSON.stringify({ error: 'invalid JSON payload' }));
      process.exit(1);
    }
    const { cliCreateWorkItemDraftJson, cliWorkItemOperationJson } = await load('cli/work-item');
    try {
      const result = operation === 'create'
        ? await cliCreateWorkItemDraftJson(
            payload.messages || payload.message,
            payload.options || {},
          )
        : await cliWorkItemOperationJson(operation, payload.draft);
      await writeJson(result);
      process.exit(0);
    } catch (error) {
      console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      process.exit(1);
    }
  }
  case 'ambient-observe': {
    const { scanAmbientObservations } = await load('ambient/ambient-observer');
    const since = args[1] ? Number(args[1]) : undefined;
    const report = await scanAmbientObservations(Number.isFinite(since) ? since : undefined);
    // Work-event promotion intentionally abstains until the factorized model
    // contract passes its independent acceptance suite. Ambient candidates
    // remain available as revisable evidence; no flat classifier is allowed
    // to create authoritative work items.
    await writeJson({ ...report, workItems: [] });
    process.exit(0);
  }
  case 'work-items': {
    await writeJson([]);
    process.exit(0);
  }
  case 'messages':
  case 'chat-messages': {
    const { cliGetChatMessagesJson } = await load('cli/query');
    const chatId = args[1];
    const count = args[2] ? parseInt(args[2], 10) : 30;
    if (!chatId) {
      console.error(JSON.stringify({ error: 'chatId required' }));
      process.exit(1);
    }
    const json = await cliGetChatMessagesJson(chatId, count);
    await writeJson(json);
    process.exit(0);
  }
  case 'rich-menu': {
    const chatId = args[1];
    if (!chatId) {
      console.error(JSON.stringify({ error: 'chatId required' }));
      process.exit(1);
    }
    const { LineProtocolService } = await load('line/core/service');
    const service = new LineProtocolService();
    if (!(await service.resumeSession())) process.exit(1);
    const menu = await service.client.getBuddyRichMenu(chatId);
    await writeJson(menu);
    process.exit(0);
  }
  case 'attention-classify': {
    const { cliClassifyAttentionJson } = await load('cli/query');
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const items = JSON.parse(input || '[]');
    await writeJson(await cliClassifyAttentionJson(items));
    process.exit(0);
  }
  case 'list-stickers': {
    const { cliListStickersJson } = await load('cli/query');
    const language = args[1] || 'zh_TW';
    await writeJson(await cliListStickersJson(language));
    process.exit(0);
  }
  case 'sticker-previews': {
    const { cliStickerPreviewsJson } = await load('cli/query');
    const packageId = args[1];
    const limit = args[2] ? parseInt(args[2], 10) : 12;
    const language = args[3] || 'en';
    if (!packageId) {
      console.error(JSON.stringify({ error: 'packageId required' }));
      process.exit(1);
    }
    await writeJson(await cliStickerPreviewsJson(packageId, limit, language));
    process.exit(0);
  }
  case 'send-sticker': {
    const chatId = args[1];
    const stickerId = args[2];
    const packageId = args[3];
    const version = args[4] || '1';
    if (!chatId || !stickerId || !packageId) {
      console.error(JSON.stringify({ error: 'chatId, stickerId and packageId required' }));
      process.exit(1);
    }
    const { LineProtocolService } = await load('line/core/service');
    const service = new LineProtocolService();
    if (!(await service.resumeSession())) process.exit(1);
    const sent = await service.sendSticker(chatId, stickerId, packageId, version);
    console.log(JSON.stringify({ sent: true, messageId: sent?.id ?? sent?.messageId ?? null }));
    process.exit(0);
  }
  case 'send-message': {
    const chatId = args[1];
    const text = args.slice(2).join(' ').trim();
    if (!chatId || !text) {
      console.error(JSON.stringify({ error: 'chatId and text required' }));
      process.exit(1);
    }
    const { LineProtocolService } = await load('line/core/service');
    const { buildMentionMetadata } = await load('line/core/mention');
    const service = new LineProtocolService();
    if (!(await service.resumeSession())) process.exit(1);
    const targets = JSON.parse(process.env.YOMI_MENTIONS_JSON || '[]');
    const mentions = targets.flatMap(({ mid, name }) => {
      const start = text.indexOf(`@${name}`);
      return start < 0 ? [] : [{ mid, start, end: start + name.length + 1 }];
    });
    const metadata = mentions.length ? { MENTION: buildMentionMetadata(text, mentions) } : undefined;
    const sent = await service.sendMessage(chatId, text, metadata);
    console.log(JSON.stringify({
      sent: true,
      messageId: sent?.id ?? sent?.messageId ?? null,
    }));
    process.exit(0);
  }
  case 'send-image': {
    const chatId = args[1];
    const imagePath = args[2];
    if (!chatId || !imagePath) {
      console.error(JSON.stringify({ error: 'chatId and imagePath required' }));
      process.exit(1);
    }
    const { LineProtocolService } = await load('line/core/service');
    const { readFile } = await import('node:fs/promises');
    const { basename } = await import('node:path');
    const service = new LineProtocolService();
    if (!(await service.resumeSession())) process.exit(1);
    const bytes = await readFile(imagePath);
    if (bytes.length === 0) {
      console.error(JSON.stringify({ error: 'image is empty' }));
      process.exit(1);
    }
    const sent = await service.sendImage(chatId, bytes, basename(imagePath));
    console.log(JSON.stringify({
      sent: true,
      messageId: sent?.messageId ?? sent?.id ?? null,
      oid: sent?.oid ?? null,
    }));
    process.exit(0);
  }
  case 'send-file': {
    const chatId = args[1];
    const filePath = args[2];
    if (!chatId || !filePath) {
      console.error(JSON.stringify({ error: 'chatId and filePath required' }));
      process.exit(1);
    }
    const { LineProtocolService } = await load('line/core/service');
    const { readFile } = await import('node:fs/promises');
    const { basename } = await import('node:path');
    const service = new LineProtocolService();
    if (!(await service.resumeSession())) process.exit(1);
    const bytes = await readFile(filePath);
    if (bytes.length === 0) {
      console.error(JSON.stringify({ error: 'file is empty' }));
      process.exit(1);
    }
    const sent = await service.sendFile(chatId, bytes, basename(filePath));
    console.log(JSON.stringify({
      sent: true,
      messageId: sent?.messageId ?? sent?.id ?? null,
      oid: sent?.oid ?? null,
    }));
    process.exit(0);
  }
  case 'send-audio': {
    const chatId = args[1];
    const filePath = args[2];
    const fileName = args[3];
    if (!chatId || !filePath) {
      console.error(JSON.stringify({ error: 'chatId and filePath required' }));
      process.exit(1);
    }
    const { LineProtocolService } = await load('line/core/service');
    const { readFile } = await import('node:fs/promises');
    const { basename } = await import('node:path');
    const service = new LineProtocolService();
    if (!(await service.resumeSession())) process.exit(1);
    const bytes = await readFile(filePath);
    if (bytes.length === 0) {
      console.error(JSON.stringify({ error: 'audio is empty' }));
      process.exit(1);
    }
    const sent = await service.sendAudio(chatId, bytes, fileName || basename(filePath));
    console.log(JSON.stringify({
      sent: true,
      messageId: sent?.messageId ?? sent?.id ?? null,
      oid: sent?.oid ?? null,
    }));
    process.exit(0);
  }
  case 'media-preview': {
    const chatId = args[1];
    const messageId = args[2];
    if (!chatId || !messageId) {
      console.error(JSON.stringify({ error: 'chatId and messageId required' }));
      process.exit(1);
    }
    const { LineProtocolService } = await load('line/core/service');
    const { fetchLineMessageMedia } = await load('mcp/media');
    const service = new LineProtocolService();
    if (!(await service.resumeSession())) process.exit(1);
    const result = await fetchLineMessageMedia(service, chatId, messageId, args[3] !== 'original');
    if (args.includes('--file-output')) {
      const { mkdtemp, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const directory = await mkdtemp(join(tmpdir(), 'yomi-media-'));
      const filePath = join(directory, 'payload');
      await writeFile(filePath, result.bytes, { mode: 0o600 });
      await writeJson({ filePath, mimeType: result.mimeType, fileName: result.fileName ?? null });
      process.exit(0);
    }
    await writeJson({
      data: result.bytes.toString('base64'),
      mimeType: result.mimeType,
      fileName: result.fileName ?? null,
    });
    process.exit(0);
  }
  case 'mark-read': {
    const { cliMarkReadJson } = await load('cli/query');
    const chatId = args[1];
    const msgId = args[2];
    if (!chatId) {
      console.error(JSON.stringify({ error: 'chatId required' }));
      process.exit(1);
    }
    const res = await cliMarkReadJson(chatId, msgId);
    console.log(JSON.stringify(res));
    process.exit(0);
  }
  case 'set-chat-muted': {
    const chatId = args[1];
    const disabled = args[2] === 'true';
    if (!chatId?.startsWith('u') || !['true', 'false'].includes(args[2])) {
      console.error(JSON.stringify({ error: '1:1 chatId and true|false required' }));
      process.exit(1);
    }
    const { LineProtocolService } = await load('line/core/service');
    const service = new LineProtocolService();
    if (!(await service.resumeSession())) process.exit(1);
    await service.client.updateContactNotificationDisabled(chatId, disabled);
    console.log(JSON.stringify({ success: true, chatId, isMuted: disabled }));
    process.exit(0);
  }
  case 'summary':
  case 'recent':
  case 'query': {
    const { cliRecentSummary } = await load('cli/query');
    const summary = await cliRecentSummary();
    console.log(summary);
    process.exit(0);
  }
  case 'serve':
    await load('mcp/server');
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(`Yomi (読み) — read, reply, send images to, and search your LINE from any AI agent.

Usage:
  yomi                Start the MCP stdio server (default)
  yomi serve          Same as above, explicit
  yomi login [...]    Run the passwordless login flow in a terminal
  yomi help           Show this help
  yomi version        Print version

Examples:
  npx @rikaidev/yomi                  # start MCP server
  npx @rikaidev/yomi login            # interactive login
  npx @rikaidev/yomi login --phone +886912345678 --region TW`);
    break;
  case 'version':
  case '--version':
  case '-v': {
    const { YOMI_VERSION } = await load('version');
    console.log(YOMI_VERSION);
    break;
  }
  default:
    console.error(`Unknown command: ${cmd}\nRun 'yomi help' for usage.`);
    process.exit(1);
}
