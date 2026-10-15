#!/usr/bin/env node
/**
 * Build and freshness gate for the native desktop app.
 * A restart is deliberately a separate, opt-in phase after every check passes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dist = join(root, 'dist')
const source = join(root, 'src')
const app = join(root, 'desktop', 'mac-native', 'Yomi.app')
const executable = join(app, 'Contents', 'MacOS', 'Yomi')
const nativeMain = join(root, 'desktop', 'mac-native', 'main.swift')
const nativeSourceRoot = join(root, 'desktop', 'mac-native')

function fail(message) {
  console.error(`[desktop:harness] ${message}`)
  process.exitCode = 1
}

function assertSource(condition, message) {
  if (!condition) fail('native regression: ' + message)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed (${result.status ?? 'signal'})`)
    process.exit(1)
  }
}

function filesUnder(directory) {
  if (!existsSync(directory)) return []
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...filesUnder(path))
    else result.push(path)
  }
  return result
}

function mtime(path) {
  return statSync(path).mtimeMs
}

run('npm', ['run', 'build'])
mkdirSync(dist, { recursive: true })
writeFileSync(join(dist, '.yomi-build-stamp.json'), JSON.stringify({ builtAt: new Date().toISOString() }) + '\n')

// Static interaction/crash gates run before the native build. They keep the
// two failure modes that previously required a manual repro visible in CI:
// AppKit layout recursion and stale conversation results.
const nativeSwiftFiles = filesUnder(nativeSourceRoot).filter((path) => path.endsWith('.swift'))
const nativeText = nativeSwiftFiles.map((path) => readFileSync(path, 'utf8')).join('\n')
const runMjsText = readFileSync(join(root, 'run.mjs'), 'utf8')
const inboxText = readFileSync(join(nativeSourceRoot, 'Features', 'Inbox', 'InboxView.swift'), 'utf8')
const richMenuText = readFileSync(join(nativeSourceRoot, 'Features', 'Conversation', 'RichMenuView.swift'), 'utf8')
const conversationText = readFileSync(join(nativeSourceRoot, 'Features', 'Conversation', 'ConversationView.swift'), 'utf8')
assertSource(runMjsText.includes('const writeJson =') && runMjsText.includes('await writeJson(json);'), 'large desktop bridge JSON must flush stdout before process exit')
assertSource(nativeText.includes('displayedMessageId') && nativeText.includes('markReadOnSuccess'), 'read receipts must use the newest message actually presented in the conversation')
assertSource(inboxText.includes('$0.responseState != "received"') && !inboxText.includes('ambient_observer_scan_stats') && !inboxText.includes('ambient_observer_followed_count'), 'Briefing must hide observer diagnostics and render only unresolved actionable candidates')
assertSource(richMenuText.includes('.contentShape(Rectangle())') && richMenuText.includes('WidthDrivenRichMenuLayout') && richMenuText.includes('width / aspectRatio') && !richMenuText.includes('.aspectRatio(menu.width / menu.height') && !richMenuText.includes('.frame(maxHeight: 220)'), 'rich menus must use width-driven full-column geometry with explicit hit targets')
assertSource(conversationText.includes('ScrollView(.vertical, showsIndicators: false)') && conversationText.includes('shouldAnchorToLatest') && conversationText.includes('.overlay(alignment: .trailing)') && !conversationText.includes('.inspector(') && !conversationText.includes('threadBaseWindowFrame') && !conversationText.includes('window.setFrame'), 'thread drawers must overlay without reflowing the conversation, and loads must anchor to the provider latest message without scrollbar artifacts')
assertSource(!nativeText.includes('class LinkMessageTextView') || !nativeText.includes('override func layout()'), 'LinkMessageTextView must not invalidate intrinsic size from layout()')
assertSource(nativeText.includes('messageLoadGeneration'), 'conversation loads must carry a generation guard')
assertSource(nativeText.includes('if isSwitchingChat { messageLoadGeneration &+= 1 }'), 'same-chat refreshes must not invalidate an in-flight conversation snapshot')
assertSource(nativeText.includes('cachedIsCurrent') && nativeText.includes('>= listTimestamp'), 'stale message caches must never render behind the list latest cursor')
assertSource(nativeText.includes('if !cached.isEmpty {') && nativeText.includes('if shouldMarkRead, cachedIsCurrent'), 'stale-while-revalidate must paint any memory cache immediately without marking a stale cursor read')
assertSource(nativeText.includes('!diskMessages.isEmpty') && !nativeText.includes('(diskMessages.last?.timestamp ?? 0)\n                        >='), 'disk snapshots must paint immediately even when newer unread messages still require background refresh')
assertSource(nativeText.includes('deadline: .now() + 0.12') && nativeText.includes('self.currentChatMessages.isEmpty'), 'full conversation skeleton must wait for the cached-first-paint budget')
assertSource(nativeText.includes('decodeDesktopMessageBatch') && nativeText.includes('messageDecodeFailureCount'), 'one malformed rich message must not blank the entire conversation and decode failures must remain observable')
assertSource(nativeText.includes('accountHash') && nativeText.includes('messageCacheSource') && nativeText.includes('messageCachePaintLatencyMs'), 'message snapshots must be account-scoped with observable cache source and first-paint latency')
assertSource(nativeText.includes('pendingReadCursors') && nativeText.includes('item.timestampValue <= cursor.readThroughTimestamp'), 'stale chat-list polls must not resurrect unread badges behind an optimistic read cursor')
assertSource(!nativeText.includes('MaterialScrollView(pinsToBottom: true)'), 'conversation messages must use the native scroll path without per-frame offset state')
assertSource(nativeText.includes('DispatchQueue.main.async {\n                    self.mediaPreviewLoading.remove(loadingKey)'), 'parallel media completion must mutate its loading set on the main queue')
assertSource(!nativeText.includes('state.selectedChatId = item.id\n                                        state.loadChatMessages'), 'conversation selection must let the loader clear stale content before switching')
assertSource(nativeText.includes('cached.isEmpty ? 20 : 12') && nativeText.includes('deadline: .now() + bridgeTimeout'), 'conversation loads must use bounded cache-aware timeouts')
assertSource(!nativeText.includes('Picker("訊息通道"'), 'LINE composer must not expose a recipient mode toggle')
assertSource(nativeText.includes('YomiCommandSurface'), 'Yomi must have a separate contextual command surface')
assertSource(nativeText.includes('min(104, max(44, composerMeasuredHeight))'), 'composer must grow with content and clamp before internal scrolling')
assertSource(!nativeText.includes('parent.isFocused || !textView.string.isEmpty ? 58 : 38'), 'focus must not resize the composer')
assertSource(!nativeText.includes('guard !isYomiMode else { return false }'), 'Yomi composer must accept dropped files')
assertSource(nativeText.includes('voiceInput.toggle(currentText: activeText)'), 'voice input must work in both composer modes')
assertSource(nativeText.includes('if event.keyCode == 36') && nativeText.includes('modifiers.contains(.shift)') && nativeText.includes('onCommandReturn?()'), 'composer must submit on Enter and insert a newline on Shift+Enter')
assertSource(nativeText.includes('restoreFocusIfNeeded()') && nativeText.includes('self.parent.isFocused') && nativeText.includes('window.makeFirstResponder(textView)'), 'background message refreshes must preserve the active composer first responder')
assertSource(nativeText.includes('local-pending-') && nativeText.includes('isDeliveryPending') && nativeText.includes('response["messageId"]'), 'LINE sends must render an optimistic row and reconcile it with the server message id')
assertSource(!nativeText.includes('WorkTrayPanel') && !nativeText.includes('onAddToWorkTray'), 'unvalidated Work Tray UI must remain withdrawn')
assertSource(nativeText.includes('withTimeInterval: 600') && nativeText.includes('items.prefix(12)'), 'ambient observer must use a bounded scan interval and OCR queue')
assertSource(nativeText.includes('InboxRefreshCoordinator') && nativeText.includes('InboxRefreshPhase') && nativeText.includes('InboxRefreshIntent'), 'inbox refresh must be coordinated as one generation-tracked pipeline')
assertSource(nativeText.includes('transition(to: .classifying') && nativeText.includes('transition(to: .observing') && nativeText.includes('transition(to: .publishing'), 'refresh pipeline must sequence sync, classification, lifecycle observation, and publication')
assertSource(!conversationText.includes('loadRecentChats(') && !inboxText.includes('loadRecentChats('), 'views must emit refresh intents instead of orchestrating data services directly')
assertSource(inboxText.includes('unresolvedChatIDs') && inboxText.includes('item.needsAttention || unresolvedChatIDs.contains(item.id)'), 'priority inbox must retain unresolved lifecycle items independently of unread state')
assertSource(inboxText.includes('.font(.system(size: 15, weight: .semibold))') && !inboxText.includes('Int(candidate.confidence * 100)'), 'Yomi tracking must use readable enterprise hierarchy and keep model confidence out of the primary workflow')
assertSource(inboxText.includes('.contentShape(Rectangle())') && inboxText.includes('WorkPreviewView') && inboxText.includes('WorkModeView'), 'tracking rows must open a work preview and confirmed work must switch into a persistent work mode')
assertSource(!inboxText.includes('.sheet(item: $selectedCandidate)') && inboxText.includes('建立工作並開始'), 'work confirmation must use the main detail surface rather than a transient dialog')
assertSource(inboxText.includes('分享／交給其他應用程式') && nativeText.includes('NSSharingServicePicker'), 'work context must hand off through the platform share surface without hard-coded agent routing')
assertSource(nativeText.includes('YomiWorkShares/') && nativeText.includes('materializeWorkMaterials'), 'LINE attachments must be materialized automatically into an ephemeral work share package')
assertSource(nativeText.includes('$0.responseState != "received" || $0.updatedAt >= retentionStart') && nativeText.includes('unresolved.prefix(100)'), 'unresolved observations must survive rolling-window retention until a terminal condition')
assertSource(nativeText.includes('.contextMenu') && nativeText.includes('automaticallyRecognizeText: recognizeOnOpen'), 'message images must expose right-click OCR while retaining proactive candidate OCR')
assertSource(nativeText.includes('evidence.ocrEligible') && nativeText.includes('ambient-observations.cache'), 'ambient OCR must honor upstream eligibility and persist only in the encrypted cache')
assertSource(nativeText.includes('currentEngineVersion') && nativeText.includes('incoming.windowStart > previous.windowStart') && nativeText.includes('retentionStart'), 'ambient observations must rebuild on engine changes and retain checkpointed event memory')
assertSource(nativeText.includes('oldestUnresolvedStart') && nativeText.includes('$0.responseState != "received"') && nativeText.includes('min(rollingOverlapStart, oldestUnresolvedStart'), 'ambient scans must revisit unresolved events so delayed replies can close stale candidates')
assertSource(nativeText.includes('yomiStagedAttachments.map(\\.url.path)'), 'Yomi prompts must receive staged local file paths')
assertSource(nativeText.includes('yomi_guardian_introduction_seen_v2'), 'guardian introduction must be persisted as a first-use experience')
assertSource(nativeText.includes('我是阿聞') && nativeText.includes('我是吽行'), 'both guardians must introduce themselves by name')
assertSource(!nativeText.includes('黃泉雙狛') && nativeText.includes('兩位閱巡者，前來值勤'), 'guardian pair must use the original 閱巡者 identity')
assertSource(nativeText.includes('struct YomiGuardiansWatermark'), 'low-attention surfaces must support the guardian watermark')
assertSource(!nativeText.includes('.popover(isPresented: $showYomiSurface'), 'Briefing must open the full Yomi workspace instead of a utility popover')
assertSource(nativeText.includes('Text("交代 Yomi")') && nativeText.includes('Text("⌘J")'), 'Briefing must expose an outcome-oriented Yomi action with its shortcut')
assertSource(nativeText.includes('window?.appearance = NSAppearance(named: .aqua)') && nativeText.includes('window?.appearance = NSAppearance(named: .darkAqua)'), 'titlebar chrome must follow the selected theme')
assertSource(nativeText.includes('deadline: .now() + 120'), 'Codex streaming must have an inactivity watchdog')
assertSource(nativeText.includes('eventLogger.lifecycle("turn_reuse"'), 'subsequent prompts must reuse the active Codex thread')
assertSource(nativeText.includes('CodingToolBackendFactory') && nativeText.includes('agentBackend?.toolID'), 'coding tools must be selected through the shared backend abstraction')
assertSource(nativeText.includes('responseID == threadStartRequestID') && !nativeText.includes('responseID == 2'), 'thread startup must match its real JSON-RPC request id')
assertSource(nativeText.includes('terminateChildren(of: process.processIdentifier)'), 'stopping Codex must reap its MCP child process')
assertSource(nativeText.includes('agent-events.jsonl') && nativeText.includes('Prompts, deltas, LINE text'), 'agent diagnostics must be bounded and content-free')
assertSource(nativeText.includes('#selector(NSResponder.moveUp(_:))') && nativeText.includes('#selector(NSResponder.moveDown(_:))'), 'Yomi prompt must support keyboard history navigation')
assertSource(nativeText.includes('yomi_prompt_history_v1') && nativeText.includes('suffix(50)'), 'prompt history must be local, persistent, and bounded')
assertSource(nativeText.includes('Text("Yomi").font') && nativeText.includes('開啟完整 Yomi 對話'), 'every conversation header must expose the full Yomi workspace')
assertSource(nativeText.includes('if voiceStatusMessage != nil || state.isSendingReply'), 'empty composer status must not leave a blank padded row')
assertSource(nativeText.includes('private var isSystemEvent: Bool { msg.contentType == 18 }'), 'chat events must use a dedicated system renderer')
assertSource(nativeText.includes('private var isDecryptFailure: Bool') && nativeText.includes('icon: "info.circle.fill"'), 'decryption failures must render as a distinct system state')
assertSource(nativeText.includes('let naturalWidth = ceil(') && nativeText.includes('let width = min(maximumWidth'), 'text bubbles must size to content before reaching their maximum width')
assertSource(nativeText.includes('private var richCard: some View') && nativeText.includes('HStack(alignment: hasMedia ? .top : .bottom'), 'Flex media and caption must render as one top-aligned card')
assertSource(nativeText.includes('declaredAspectRatio') && nativeText.includes('node.resolved.contentMode == "cover" ? .fill : .fit'), 'Flex images must honor the shared drawing-area aspect ratio and fit/cover mode')
assertSource(nativeText.includes('node.resolved.fontSize') && nativeText.includes('document.layoutFingerprint'), 'macOS Flex must consume the shared resolved contract and expose its fingerprint')
assertSource(!nativeText.includes('LineFlexNodeView(node: root, onAction: perform)\n                        .padding(10)') && !nativeText.includes('.frame(maxWidth: 320, alignment: .leading)\n                        .background(EnterpriseTheme.surface)'), 'Flex documents must own their complete bubble background without a platform message wrapper')
assertSource(nativeText.includes('attachment.image = rendered') && nativeText.includes('ImageCache.shared.save(image: image'), 'LINE custom emoji must render as modern inline attachments backed by the shared image cache')
assertSource(nativeText.includes('InlineEmojiImageStore') && nativeText.includes('scheduleEmojiRetry') && !nativeText.includes('private static let emojiCache = NSCache'), 'inline emoji must use a bounded strong cache and retry transient CDN failures without reverting to placeholder text')
assertSource(nativeText.includes('request.timeoutInterval = 12') && nativeText.includes('@Published private(set) var failed') && nativeText.includes('imageLoader.failed'), 'remote media must leave the spinner for a bounded retry state instead of waiting forever')
assertSource(nativeText.includes('.task(id: document.imageUrl)') && nativeText.includes('.task(id: url) { loader.load(urlStr: url) }'), 'stateful media loaders must follow cache-to-network URL identity changes instead of remaining stuck on stale URLs')
assertSource(!conversationText.includes('back_to_briefing') && inboxText.includes('briefing_today') && inboxText.includes('state.selectedChatId = nil'), 'Briefing must be a pinned inbox overview rather than a back button repeated in every conversation')
assertSource(nativeText.includes('.scrollTargetBehavior(.viewAligned') && nativeText.includes('availableWidth: 286') && nativeText.includes('.frame(width: 320, alignment: .leading)') && nativeText.includes('.clipped()'), 'Flex carousels must use a fixed viewport with equal-width snapping bubbles and a bounded next-card peek')
assertSource(nativeText.includes('isZoomable: !isInCarousel') && nativeText.includes('DragGesture(minimumDistance: 8)') && nativeText.includes('.scrollPosition(id: $carouselPosition)'), 'carousel images must yield drag ownership to paged horizontal navigation instead of opening the image viewer')
assertSource(nativeText.includes('DesktopChatSnapshot') && nativeText.includes('chat-list-v1.json'), 'desktop startup must paint a bounded local chat snapshot before syncing')
assertSource(nativeText.includes('appendingPathComponent("runtime/node")') && nativeText.includes('appendingPathComponent("YomiCore")'), 'distributed desktop builds must prefer their bundled Node and YomiCore runtime')
assertSource(nativeText.includes('guard !chatRefreshInFlight else { return }'), 'chat loading must coalesce duplicate startup requests')
assertSource(nativeText.includes('withTimeInterval: 30.0') && nativeText.includes('if incoming != self.chats'), 'background polling must avoid high-frequency no-op publishes')
assertSource(nativeText.includes('attentionNow') && nativeText.includes('attentionToday') && nativeText.includes('attentionKnow'), 'attention tiers must use a semantic urgency palette')
assertSource(nativeText.includes('value == 0 ? EnterpriseTheme.secondaryText.opacity(0.5)'), 'zero-value metrics must not compete for attention')
assertSource(nativeText.includes('memoryImage(for url: URL)') && nativeText.includes('DispatchQueue.global(qos: .utility).async'), 'disk image decoding must stay off the main thread')
assertSource(nativeText.includes('mcpServer/elicitation/request') && nativeText.includes('respondToElicitation'), 'MCP elicitation must be surfaced and answered')
assertSource(nativeText.includes('isTrustedYomiRequest') && nativeText.includes('rawServerName.caseInsensitiveCompare("yomi")'), 'all tools from the trusted Yomi server must be enabled by default')
assertSource(nativeText.includes('acceptForSession') && nativeText.includes('本次對話皆允許'), 'command approval must support session-scoped consent')
assertSource(nativeText.includes('acceptPermanently') && nativeText.includes('yomi_permanent_readonly_approvals_v1'), 'safe read-only approval must persist across Yomi sessions')
assertSource(nativeText.includes('永遠允許同類唯讀命令') && nativeText.includes('permittedPrefixes'), 'permanent approval must be visible and restricted to classified read-only commands')
assertSource(nativeText.includes('Text(command)') && nativeText.includes('Label(cwd, systemImage: "folder")'), 'approval UI must show the exact command and working directory')
assertSource(nativeText.includes('.padding(.leading, 16)') && nativeText.includes('.frame(height: 48, alignment: .center)'), 'secondary navigation must align to the compact content grid')

// Keep the search matching/snippet rules executable without launching SwiftUI.
// This catches regressions where filtering works but the visible attributed
// ranges or URL/date-adjacent Chinese matches disappear in the row renderer.
const searchTestBinary = `/tmp/yomi-search-support-test-${process.pid}`
run('swiftc', [
  join(root, 'desktop', 'mac-native', 'SearchSupport.swift'),
  join(root, 'scripts', 'search-support-test-main.swift'),
  '-o',
  searchTestBinary,
])
run(searchTestBinary, [])

const optimisticTestBinary = `/tmp/yomi-optimistic-delivery-test-${process.pid}`
run('swiftc', [
  join(root, 'desktop', 'mac-native', 'Core', 'OptimisticDeliveryReducer.swift'),
  join(root, 'scripts', 'optimistic-delivery-test-main.swift'),
  '-o',
  optimisticTestBinary,
])
run(optimisticTestBinary, [])

const readCursorTestBinary = `/tmp/yomi-visible-read-cursor-test-${process.pid}`
run('swiftc', [
  join(root, 'desktop', 'mac-native', 'Core', 'VisibleReadCursorPolicy.swift'),
  join(root, 'scripts', 'visible-read-cursor-test-main.swift'),
  '-o',
  readCursorTestBinary,
])
run(readCursorTestBinary, [])

run('npm', ['run', 'desktop:build'])

const sourceFiles = filesUnder(source).filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
for (const sourcePath of sourceFiles) {
  const outputPath = join(dist, relative(source, sourcePath).replace(/\.ts$/, '.js'))
  if (!existsSync(outputPath)) fail(`missing compiled artifact for ${relative(root, sourcePath)}: ${relative(root, outputPath)}`)
  else if (mtime(outputPath) < mtime(sourcePath)) fail(`stale compiled artifact: ${relative(root, outputPath)}`)
}

const nativeSources = [
  ...nativeSwiftFiles,
  join(root, 'desktop', 'mac-native', 'Info.plist'),
  join(root, 'desktop', 'mac-native', 'AppIcon.icns'),
  join(root, 'desktop', 'mac-native', 'Design', 'AppliedGlyphs', 'YomiKomainuLine.svg'),
  join(root, 'desktop', 'mac-native', 'Design', 'AppliedGlyphs', 'YomiKomainuAgent.svg'),
]
for (const sourcePath of nativeSources) {
  if (mtime(executable) < mtime(sourcePath)) fail(`stale native artifact: ${relative(root, sourcePath)}`)
}
const stamp = join(dist, '.yomi-build-stamp.json')
if (existsSync(stamp) && mtime(executable) < mtime(stamp)) fail('native executable predates the TypeScript build stamp')
for (const resource of [
  join(app, 'Contents', 'Info.plist'),
  join(app, 'Contents', 'Resources', 'AppIcon.icns'),
  join(app, 'Contents', 'Resources', 'YomiKomainuLine.svg'),
  join(app, 'Contents', 'Resources', 'YomiKomainuAgent.svg'),
]) {
  if (!existsSync(resource)) fail(`missing app resource: ${relative(root, resource)}`)
  else if (mtime(resource) < Math.max(...nativeSources.map(mtime))) fail(`stale app resource: ${relative(root, resource)}`)
}

run('codesign', ['--verify', '--deep', '--strict', app])
run('node', ['run.mjs', 'version'])
run('node', ['run.mjs', 'help'])

if (process.env.YOMI_HARNESS_SMOKE_CHATS === '1') {
  run('node', ['run.mjs', 'chats', 'all'])
}

if (process.argv.includes('--restart')) {
  spawnSync('pkill', ['-x', 'Yomi'], { cwd: root, stdio: 'ignore' })
  run('open', [app])
}

if (process.exitCode === 1) process.exit(1)
console.log('[desktop:harness] build, freshness, signature, and CLI smoke checks passed')
