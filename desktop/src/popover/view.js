/* Windows desktop workspace.  This file is embedded by popover/mod.rs so the
 * packaged app remains self-contained while the UI stays reviewable. */
const $ = (id) => document.getElementById(id);
const send = (value) => window.ipc && window.ipc.postMessage(value);
const state = {
  connected: false,
  chats: [],
  messages: [],
  selected: null,
  view: "attention",
  menu: null,
  briefing: true,
  generation: 0,
  media: {},
  pendingReads: {},
  ambientCandidates: [],
};
const pending = {};
const locale = localStorage.getItem("yomi-language") || "zh-TW";
let lang = locale;
let loginTimer = null;
let voiceRecorder = null;
let voiceStream = null;
const I = {
  "zh-TW": {
    attention: "優先收件匣",
    all_chats: "所有對話",
    yomi: "與 Yomi 對話",
    ambient: "Yomi 追蹤",
    settings: "安全與設定",
    windows_app: "Yomi Windows",
    priority: "優先",
    all: "全部",
    search: "搜尋對話",
    send: "送出",
    start: "從左側選擇對話開始",
    empty: "沒有符合的對話",
    no_messages: "尚無訊息",
    syncing: "正在同步…",
    synced: "已同步",
    login_title: "連結 LINE",
    login_copy: "以副裝置安全登入。電話號碼與憑證只會保留在這台電腦。",
    login_continue: "在此電腦繼續",
    cancel: "取消",
    online: "● 已連線",
    offline: "● 離線",
    encrypted: "點對點加密保護",
    group: "群組",
    close: "關閉",
    thread: "討論串",
    no_thread: "目前沒有回覆",
    ambient_loading: "正在分析最近訊息…",
    no_candidates: "目前沒有觀察候選",
    operation_failed: "操作失敗",
    mobile_only: "此操作需要在 LINE 手機版執行",
    postback: "此按鈕會在手機版 LINE 執行",
    settings_language: "語言",
    settings_appearance: "外觀",
    settings_sync: "同步模式",
    settings_notifications: "通知",
    settings_ai: "AI provider",
    settings_update: "更新",
    settings_about: "關於 Yomi",
    check_update: "檢查更新",
    relogin: "重新登入",
    signout: "登出",
    system: "系統",
    light: "淺色",
    dark: "深色",
    realtime: "即時推送",
    one_min: "每 1 分鐘",
    five_min: "每 5 分鐘",
    message_action: "已填入輸入框，請確認後送出",
    recording: "錄音中，點擊停止",
    mic_failed: "無法使用麥克風",
    attachment_failed: "附件處理失敗",
    briefing_title: "今日 Briefing",
    briefing_sub: "Yomi 先整理需要你處理的訊息；未讀不等於需要注意。",
    now: "現在處理",
    today: "今天處理",
    know: "值得知道",
    needs_attention: "需要你的注意",
    no_attention: "目前沒有需要處理的訊息",
    ask_yomi: "交代 Yomi",
    provider: "Provider",
    yomi_status: "Yomi 會以通知回報完成；Windows 目前不支援串流 approval UI。",
    run_yomi: "送給 Yomi",
    stop_recording: "停止錄音",
    download: "下載附件",
    open: "開啟",
    saved: "已儲存",
    appearance_note: "Windows WebView 外觀",
    sync_note: "背景同步間隔",
    notifications_note: "顯示 Yomi 桌面通知",
    about_note: "Windows desktop workspace",
    version: "版本",
  },
  en: {
    attention: "Priority inbox",
    all_chats: "All chats",
    yomi: "Ask Yomi",
    ambient: "Yomi Tracking",
    settings: "Settings",
    windows_app: "Yomi Windows",
    priority: "Priority",
    all: "All",
    search: "Search conversations",
    send: "Send",
    start: "Select a conversation to begin",
    empty: "No matching conversations",
    no_messages: "No messages",
    syncing: "Syncing…",
    synced: "Synced",
    login_title: "Connect LINE",
    login_copy:
      "Sign in as a secondary device. Credentials stay on this computer.",
    login_continue: "Continue on this computer",
    cancel: "Cancel",
    online: "● Connected",
    offline: "● Offline",
    encrypted: "End-to-end encrypted",
    group: "Group",
    close: "Close",
    thread: "Thread",
    no_thread: "No replies",
    ambient_loading: "Analyzing recent messages…",
    no_candidates: "No observation candidates",
    operation_failed: "Operation failed",
    mobile_only: "This action must be run in LINE mobile",
    postback: "This button runs in LINE mobile",
    settings_language: "Language",
    settings_appearance: "Appearance",
    settings_sync: "Sync mode",
    settings_notifications: "Notifications",
    settings_ai: "AI provider",
    settings_update: "Updates",
    settings_about: "About Yomi",
    check_update: "Check for updates",
    relogin: "Sign in again",
    signout: "Sign out",
    system: "System",
    light: "Light",
    dark: "Dark",
    realtime: "Realtime push",
    one_min: "Every 1 minute",
    five_min: "Every 5 minutes",
    message_action: "Filled the composer. Review before sending.",
    recording: "Recording; click to stop",
    mic_failed: "Microphone unavailable",
    attachment_failed: "Attachment failed",
    briefing_title: "Today's Briefing",
    briefing_sub:
      "Yomi sorts messages that need your attention; unread does not always mean actionable.",
    now: "Now",
    today: "Today",
    know: "Worth knowing",
    needs_attention: "Needs your attention",
    no_attention: "Nothing needs your attention right now",
    ask_yomi: "Ask Yomi",
    provider: "Provider",
    yomi_status:
      "Yomi reports completion through a notification; streaming approval UI is not available on Windows yet.",
    run_yomi: "Send to Yomi",
    stop_recording: "Stop recording",
    download: "Download attachment",
    open: "Open",
    saved: "Saved",
    appearance_note: "Windows WebView appearance",
    sync_note: "Background sync interval",
    notifications_note: "Show Yomi desktop notifications",
    about_note: "Windows desktop workspace",
    version: "Version",
  },
  ja: {
    attention: "優先受信箱",
    all_chats: "すべての会話",
    yomi: "Yomi に依頼",
    ambient: "Yomi トラッキング",
    settings: "設定",
    windows_app: "Yomi Windows",
    priority: "優先",
    all: "すべて",
    search: "会話を検索",
    send: "送信",
    start: "会話を選択",
    empty: "該当する会話はありません",
    no_messages: "メッセージはありません",
    syncing: "同期中…",
    synced: "同期済み",
    login_title: "LINE を接続",
    login_copy:
      "副端末として安全にログインします。認証情報はこのPCに保管されます。",
    login_continue: "このPCで続ける",
    cancel: "キャンセル",
    online: "● 接続済み",
    offline: "● オフライン",
    encrypted: "エンドツーエンド暗号化",
    group: "グループ",
    close: "閉じる",
    thread: "スレッド",
    no_thread: "返信はありません",
    ambient_loading: "最近のメッセージを分析中…",
    no_candidates: "観察候補はありません",
    operation_failed: "操作に失敗しました",
    mobile_only: "この操作は LINE モバイルで実行してください",
    postback: "このボタンは LINE モバイルで実行されます",
    settings_language: "言語",
    settings_appearance: "外観",
    settings_sync: "同期モード",
    settings_notifications: "通知",
    settings_ai: "AI provider",
    settings_update: "更新",
    settings_about: "Yomi について",
    check_update: "更新を確認",
    relogin: "再ログイン",
    signout: "サインアウト",
    system: "システム",
    light: "ライト",
    dark: "ダーク",
    realtime: "リアルタイム",
    one_min: "1分ごと",
    five_min: "5分ごと",
    message_action: "入力欄に設定しました。確認して送信してください",
    recording: "録音中。クリックで停止",
    mic_failed: "マイクを使用できません",
    attachment_failed: "添付ファイルに失敗しました",
    briefing_title: "今日の Briefing",
    briefing_sub:
      "Yomi が対応が必要なメッセージを整理します。未読でも対応不要の場合があります。",
    now: "今すぐ対応",
    today: "今日対応",
    know: "知っておく",
    needs_attention: "要対応",
    no_attention: "対応が必要なメッセージはありません",
    ask_yomi: "Yomi に依頼",
    provider: "Provider",
    yomi_status:
      "完了は通知で報告します。Windows では approval のストリーミングUIは未対応です。",
    run_yomi: "Yomi に送信",
    stop_recording: "録音を停止",
    download: "添付ファイルをダウンロード",
    open: "開く",
    saved: "保存しました",
    appearance_note: "Windows WebView の外観",
    sync_note: "バックグラウンド同期間隔",
    notifications_note: "Yomi のデスクトップ通知を表示",
    about_note: "Windows desktop workspace",
    version: "バージョン",
  },
};
function t(key) {
  return (I[lang] || I["zh-TW"])[key] || key;
}
function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function parse(value) {
  try {
    return JSON.parse(value);
  } catch {
    const index = [value.indexOf("["), value.indexOf("{")]
      .filter((x) => x >= 0)
      .sort((a, b) => a - b)[0];
    try {
      return index === undefined ? null : JSON.parse(value.slice(index));
    } catch {
      return null;
    }
  }
}
function toast(value) {
  $("toast").textContent = value;
  $("toast").classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.add("hidden"), 2600);
}
function bridge(id, command, args = [], stdin = null, mentions = []) {
  pending[id] = { command };
  send("bridge:" + JSON.stringify({ id, command, args, stdin, mentions }));
}
function isAttention(c) {
  return (
    !c.isMuted &&
    (c.unreadCount > 0 ||
      c.hasMention ||
      ["now", "today", "know"].includes(c.attentionTier) ||
      isPriority(c.id))
  );
}
function isPriority(id) {
  return JSON.parse(localStorage.getItem("yomi-priority") || "[]").includes(id);
}
function i18n() {
  document
    .querySelectorAll("[data-i18n]")
    .forEach((e) => (e.textContent = t(e.dataset.i18n)));
  $("search").placeholder = t("search");
  $("input").placeholder = t("send");
  renderChats();
  if (state.selected) renderHeader();
  else if (state.view === "attention") showBriefing();
}
function setView(view) {
  state.view = view;
  state.selected = null;
  state.messages = [];
  state.generation++;
  $("composer").classList.add("hidden");
  $("yomi-panel").classList.add("hidden");
  $("messages").classList.remove("hidden");
  $("briefing").classList.add("hidden");
  $("nav-attention").classList.toggle("active", view === "attention");
  $("nav-chats").classList.toggle("active", view === "chats");
  $("filter-attention").classList.toggle("active", view === "attention");
  $("filter-all").classList.toggle("active", view === "chats");
  $("inbox-title").textContent = t(
    view === "attention" ? "attention" : "all_chats",
  );
  renderChats();
  if (view === "attention") showBriefing();
  else $("detail-head").innerHTML = `<div class="empty">${t("start")}</div>`;
}
function renderChats() {
  const query = ($("search").value || "").trim().toLowerCase();
  const rows = state.chats
    .filter(
      (c) =>
        (state.view === "chats" || isAttention(c)) &&
        (!query || `${c.title} ${c.lastMessage}`.toLowerCase().includes(query)),
    )
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  $("inbox-title").textContent = t(
    state.view === "attention" ? "attention" : "all_chats",
  );
  $("attention-count").textContent = state.chats.filter(isAttention).length;
  $("chat-list").innerHTML = rows.length
    ? rows
        .map(
          (c) =>
            `<button class="chat ${state.selected === c.id ? "selected" : ""} ${c.isMuted ? "muted" : ""}" onclick="selectChat('${esc(c.id)}')"><div class="avatar">${c.pictureUrl ? `<img src="${esc(c.pictureUrl)}">` : esc((c.title || "YM").slice(0, 2))}</div><div class="chat-body"><div class="chat-top"><span class="chat-name">${esc(c.title)}${c.isGroup ? " 👥" : ""}</span><span class="time">${esc(c.timeString || "")}</span></div><div class="preview">${esc(c.lastMessage || "")}</div></div>${c.unreadCount ? `<span class="unread">${c.unreadCount}</span>` : ""}</button>`,
        )
        .join("")
    : `<div class="empty">${t("empty")}</div>`;
}
function showBriefing() {
  state.briefing = true;
  $("detail-head").innerHTML = "";
  $("messages").classList.add("hidden");
  $("briefing").classList.remove("hidden");
  const active = state.chats.filter(isAttention);
  const now = active.filter((c) => c.attentionTier === "now").length;
  const today = active.filter((c) => c.attentionTier === "today").length;
  const know = active.filter((c) => c.attentionTier === "know").length;
  $("briefing").innerHTML =
    `<div class="briefing-head"><div><h1>${t("briefing_title")}</h1><div class="sub">${t("briefing_sub")}</div></div><button class="primary" onclick="showYomi()">${t("ask_yomi")} ⌘J</button></div><div class="metric-row"><div class="metric"><b>${now}</b>${t("now")}</div><div class="metric"><b>${today}</b>${t("today")}</div><div class="metric"><b>${know}</b>${t("know")}</div></div><h2>${t("needs_attention")}</h2>${
      active.length
        ? active
            .slice(0, 8)
            .map(
              (c) =>
                `<button class="candidate" onclick="selectChat('${esc(c.id)}')"><div class="avatar">${esc((c.title || "YM").slice(0, 2))}</div><div class="candidate-body"><b>${esc(c.title)}</b><small>${esc(c.lastMessage || "")} · ${esc(c.attentionReason || c.attentionTier || "")}</small></div><span>›</span></button>`,
            )
            .join("")
        : `<div class="candidate">${t("no_attention")}</div>`
    }`;
}
function renderHeader() {
  const c = state.chats.find((x) => x.id === state.selected);
  if (!c) return;
  $("detail-head").innerHTML =
    `<div class="avatar">${c.pictureUrl ? `<img src="${esc(c.pictureUrl)}">` : esc((c.title || "YM").slice(0, 2))}</div><div class="person"><strong>${esc(c.title || "")}</strong><small>${c.isGroup ? t("group") : t("encrypted")}</small></div><div><button title="mute" onclick="mute()">${c.isMuted ? "🔕" : "🔔"}</button><button title="thread" onclick="thread()">☷</button><button title="refresh" onclick="loadMessages(state.selected,true)">↻</button></div>`;
}
function selectChat(id) {
  state.selected = id;
  state.briefing = false;
  state.generation++;
  $("briefing").classList.add("hidden");
  $("yomi-panel").classList.add("hidden");
  $("messages").classList.remove("hidden");
  $("composer").classList.remove("hidden");
  renderChats();
  renderHeader();
  $("messages").innerHTML = `<div class="empty">${t("syncing")}</div>`;
  loadMessages(id, false);
  bridge("menu:" + id, "rich-menu", [id]);
}
function loadMessages(id, manual) {
  const generation = state.generation;
  bridge("messages:" + id, "messages", [id, "40"]);
  if (manual) toast(t("syncing"));
  pending["messages:" + id].generation = generation;
}
function renderMessages() {
  if (!state.messages.length) {
    $("messages").innerHTML = `<div class="empty">${t("no_messages")}</div>`;
    return;
  }
  $("messages").innerHTML = state.messages.map(messageHtml).join("");
  $("messages").scrollTop = $("messages").scrollHeight;
}
function mediaButton(m) {
  return `<button class="file" onclick="media('${esc(m.id)}')">▧ ${esc(m.fileName || m.mediaType || "Media")}</button>`;
}
function messageHtml(m) {
  if (m.isDecryptFailure)
    return `<article class="message"><div class="event">ⓘ ${esc(m.fromName || "")} · ${esc(m.text || "")}</div></article>`;
  if (m.contentType === 18)
    return `<article class="system-event">${esc(m.text || "")} · ${esc(m.timeString || "")}</article>`;
  let body = "";
  const data = state.media[m.id];
  if (m.flexDocument) {
    body = flexDoc(m.flexDocument);
  } else if (m.mediaType === "image") {
    body = data
      ? `<img class="media" src="data:${esc(data.mimeType)};base64,${data.data}">`
      : m.mediaUrl
        ? `<img class="media" src="${esc(m.mediaUrl)}">`
        : mediaButton(m);
  } else if (m.mediaType === "video") {
    body = data
      ? `<video class="media" controls src="data:${esc(data.mimeType)};base64,${data.data}"></video>`
      : m.mediaUrl
        ? `<video class="media" controls src="${esc(m.mediaUrl)}"></video>`
        : mediaButton(m);
  } else if (m.mediaType === "audio") {
    body = data
      ? `<audio class="media audio" controls src="data:${esc(data.mimeType)};base64,${data.data}"></audio>`
      : `<button class="file" onclick="media('${esc(m.id)}')">▶ ${esc(m.fileName || "Audio")}</button>`;
  } else if (m.mediaType === "file") {
    body = data
      ? `<button class="file" onclick="downloadMedia('${esc(m.id)}')">${t("download")}: ${esc(m.fileName || "File")}</button>`
      : `<button class="file" onclick="media('${esc(m.id)}')">▤ ${esc(m.fileName || "File")}</button>`;
  } else if (m.mediaType === "sticker") {
    body = m.mediaUrl
      ? `<img class="media" src="${esc(m.mediaUrl)}">`
      : `☺ ${esc(m.text || "Sticker")}`;
  } else if (m.mediaType === "rich") {
    body = m.mediaUrl
      ? `<img class="media" src="${esc(m.mediaUrl)}">`
      : esc(m.text || "[rich]");
  } else if (m.mediaType === "call") {
    body = `<div class="event">☎ ${esc(m.text || "Call")}</div>`;
  } else {
    body = renderEmojiText(m.text || "", m.emojiRanges || []);
  }
  return `<article class="message ${m.isSelf ? "self" : ""}"><div class="bubble">${body}</div><div class="meta">${esc(m.fromName || "")} · ${esc(m.timeString || "")}${m.threadReplies?.length ? ` · <button onclick="thread('${esc(m.id)}')">${m.threadReplies.length} ${t("thread")}</button>` : ""}</div></article>`;
}
function linkify(value) {
  return esc(value).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" onclick="event.preventDefault();send(\'open_url:\'+this.href)">$1</a>',
  );
}
function renderEmojiText(value, ranges) {
  if (!ranges.length) return linkify(value);
  let cursor = 0;
  let html = "";
  for (const range of [...ranges].sort((a, b) => a.location - b.location)) {
    const start = Math.max(cursor, Number(range.location));
    const end = Math.min(value.length, start + Number(range.length));
    if (start < cursor || end <= start || !/^https:\/\//.test(range.url || "")) continue;
    html += linkify(value.slice(cursor, start));
    html += `<img class="inline-emoji" src="${esc(range.url)}" alt="${esc(value.slice(start, end))}">`;
    cursor = end;
  }
  return html + linkify(value.slice(cursor));
}
function flexColor(value, fallback = "transparent") {
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(String(value || "")) ? value : fallback;
}
function flexBackground(n) {
  const g = n.background;
  if (!g) return flexColor(n.backgroundColor);
  const center = g.centerColor
    ? `, ${flexColor(g.centerColor)} ${(g.centerPosition ?? 0.5) * 100}%`
    : "";
  return `linear-gradient(${g.angle}deg, ${flexColor(g.startColor)} 0%${center}, ${flexColor(g.endColor)} 100%)`;
}
function flexDimension(points, fraction) {
  if (points != null) return `${points}px`;
  if (fraction != null) return `${fraction * 100}%`;
  return null;
}
function flexBoxStyle(n) {
  const r = n.resolved;
  const horizontal = r.axis === "horizontal" || r.axis === "baseline";
  const widthValue = flexDimension(r.widthPoints, r.widthFraction);
  const maxWidthValue = flexDimension(r.maxWidthPoints, r.maxWidthFraction);
  const heightValue = flexDimension(r.heightPoints, r.heightFraction);
  const maxHeightValue = flexDimension(r.maxHeightPoints, r.maxHeightFraction);
  const width = widthValue ? `width:${widthValue};` : "";
  const maxWidth = maxWidthValue ? `max-width:${maxWidthValue};` : "";
  const height = heightValue ? `height:${heightValue};` : "";
  const maxHeight = maxHeightValue ? `max-height:${maxHeightValue};` : "";
  const offsets = `${r.offsetTop == null ? "" : `top:${r.offsetTop}px;`}${r.offsetBottom == null ? "" : `bottom:${r.offsetBottom}px;`}${r.offsetStart == null ? "" : `inset-inline-start:${r.offsetStart}px;`}${r.offsetEnd == null ? "" : `inset-inline-end:${r.offsetEnd}px;`}`;
  const separator = n.separator ? `border-top:1px solid ${flexColor(n.separatorColor, "var(--line)")};` : "";
  return `display:flex;flex-direction:${horizontal ? "row" : "column"};gap:${r.spacing}px;padding:${r.paddingTop}px ${r.paddingEnd}px ${r.paddingBottom}px ${r.paddingStart}px;background:${flexBackground(n)};align-items:${r.axis === "baseline" ? "baseline" : ["flex-start", "center", "flex-end"].includes(n.alignItems) ? n.alignItems : "stretch"};justify-content:${["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"].includes(n.justifyContent) ? n.justifyContent : "flex-start"};border:${r.borderWidth}px solid ${flexColor(n.borderColor)};${separator}border-radius:${r.cornerRadius}px;flex:${r.flexGrow} 0 ${r.flexGrow > 0 ? "0" : "auto"};position:${r.position};${offsets}${width}${maxWidth}${height}${maxHeight}`;
}
function flexNode(n) {
  if (!n) return "";
  if (n.type === "carousel")
    return `<div class="carousel peek">${(n.children || []).map((child) => `<div>${flexNode(child)}</div>`).join("")}</div>`;
  if (["image", "video", "icon"].includes(n.type) && n.url) {
    const ratio = n.resolved.aspectRatio;
    const mode = n.resolved.contentMode === "cover" ? "cover" : "contain";
    return `<img class="flex-image" src="${esc(n.url)}" style="aspect-ratio:${ratio};object-fit:${mode}">`;
  }
  const text = n.text
    ? `<div class="flex-text" style="font-size:${n.resolved.fontSize}px;font-weight:${n.resolved.fontWeight};color:${flexColor(n.color, "inherit")};text-align:${["start", "center", "end"].includes(n.align) ? n.align.replace("start", "left").replace("end", "right") : "left"};white-space:${n.resolved.lineLimit === 1 ? "nowrap" : "normal"};${n.resolved.lineLimit ? `-webkit-line-clamp:${n.resolved.lineLimit};` : ""}">${esc(n.text)}</div>`
    : "";
  const children = (n.children || []).map(flexNode).join("");
  if ((n.type === "text" || n.type === "span") && n.children?.length)
    return `<span class="flex-spans">${text}${children}</span>`;
  if (n.type === "button" || n.action) {
    const style = n.resolved.buttonStyle;
    return `<button class="flex-button ${style}" style="height:${n.resolved.buttonHeight}px;${style === "primary" ? `background:${flexColor(n.color, "var(--accent)")}` : `color:${flexColor(n.color, "var(--accent)")}`}" onclick='safeAction(${JSON.stringify(n.action || {})})'>${esc(n.action?.label || n.text || "")}</button>`;
  }
  if (n.type === "box" || n.type === "bubble")
    return `<div class="flex-node ${n.block ? `flex-block-${n.block}` : ""}" style="${flexBoxStyle(n)}">${text}${children}</div>`;
  return `${text}${children}`;
}
function flexDoc(d) {
  if (!d) return "";
  if (d.kind === "imagemap" && d.imageUrl)
    return `<div class="rich"><img src="${esc(d.imageUrl)}">${(d.regions || []).map((r, i) => `<button class="rich-region" style="left:${(r.x / d.width) * 100}%;top:${(r.y / d.height) * 100}%;width:${(r.width / d.width) * 100}%;height:${(r.height / d.height) * 100}%" onclick='safeAction(${JSON.stringify(r.action || {})})'></button>`).join("")}</div>`;
  return `<div class="flex" data-layout-version="${Number(d.layoutVersion || 0)}" data-layout-fingerprint="${esc(d.layoutFingerprint || "missing")}">${d.root ? flexNode(d.root) : ""}</div>`;
}
function safeAction(action) {
  if (!action) return;
  if (action.uri && /^https?:\/\//.test(action.uri)) {
    send("open_url:" + action.uri);
    return;
  }
  if (action.text) {
    $("input").value = action.text;
    $("input").focus();
    toast(t("message_action"));
    return;
  }
  toast(action.type === "postback" ? t("postback") : t("mobile_only"));
}
function loadChats(manual = false) {
  bridge("chats", "chats", ["all"]);
  if (manual) toast(t("syncing"));
}
function sendText() {
  const value = $("input").value.trim();
  if (!value || !state.selected) return;
  const id = "send:" + Date.now();
  bridge(id, "send-message", [state.selected, value], null, []);
  remember(value);
  $("input").value = "";
  loadMessages(state.selected, false);
}
function remember(value) {
  const history = JSON.parse(
    localStorage.getItem("yomi-history") || "[]",
  ).filter((x) => x !== value);
  history.push(value);
  localStorage.setItem("yomi-history", JSON.stringify(history.slice(-50)));
}
function key(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendText();
    return;
  }
  const history = JSON.parse(localStorage.getItem("yomi-history") || "[]");
  if (
    event.key === "ArrowUp" &&
    $("input").selectionStart === 0 &&
    history.length
  ) {
    event.preventDefault();
    $("input").value = history.at(-1);
  }
  if (event.key === "Escape" && voiceRecorder) stopVoice();
}
function mute() {
  const c = state.chats.find((x) => x.id === state.selected);
  if (c)
    bridge("mute:" + state.selected, "set-chat-muted", [
      state.selected,
      String(!c.isMuted),
    ]);
}
function media(id) {
  bridge("media:" + id, "media-preview", [state.selected, id]);
}
function downloadMedia(id) {
  const d = state.media[id];
  if (!d) return media(id);
  const a = document.createElement("a");
  a.href = `data:${d.mimeType};base64,${d.data}`;
  a.download = d.fileName || "yomi-attachment";
  a.click();
  toast(t("saved"));
}
function chooseFile(camera) {
  $(camera ? "camera-file" : "file").click();
}
function stageFiles(event) {
  const files = [...(event.target.files || [])];
  event.target.value = "";
  if (!files.length || !state.selected) return;
  state.attachments = state.attachments || [];
  for (const file of files.slice(0, 8 - state.attachments.length))
    state.attachments.push(file);
  renderAttachments();
}
function renderAttachments() {
  const list = state.attachments || [];
  const box = $("attachments");
  box.classList.toggle("hidden", !list.length);
  box.innerHTML = list
    .map(
      (f, i) =>
        `<div class="attachment"><span>${esc(f.name)}</span><button onclick="removeAttachment(${i})">×</button></div>`,
    )
    .join("");
}
function removeAttachment(i) {
  (state.attachments || []).splice(i, 1);
  renderAttachments();
}
function uploadAttachment(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const id = "upload:" + Date.now() + Math.random();
      send(
        "upload:" +
          JSON.stringify({
            id,
            name: file.name,
            kind: file.type.startsWith("image/") ? "image" : "file",
            data: String(reader.result).split(",")[1],
          }),
      );
      pending[id] = { command: "upload", file };
      resolve(id);
    };
    reader.readAsDataURL(file);
  });
}
async function sendAttachments() {
  for (const file of state.attachments || []) await uploadAttachment(file);
  state.attachments = [];
  renderAttachments();
}
function toggleStickers() {
  const box = $("stickers");
  box.classList.toggle("hidden");
  if (!box.classList.contains("hidden"))
    bridge("sticker-packages", "list-stickers", [lang]);
}
function voice() {
  if (voiceRecorder) {
    stopVoice();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) return toast(t("mic_failed"));
  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((stream) => {
      voiceStream = stream;
      voiceRecorder = new MediaRecorder(stream);
      const chunks = [];
      voiceRecorder.ondataavailable = (e) => chunks.push(e.data);
      voiceRecorder.onstop = () => {
        const reader = new FileReader();
        reader.onload = () => {
          const id = "voice:" + Date.now();
          send(
            "upload:" +
              JSON.stringify({
                id,
                name: "voice.webm",
                kind: "audio",
                data: String(reader.result).split(",")[1],
              }),
          );
          pending[id] = { command: "voice" };
        };
        reader.readAsDataURL(new Blob(chunks, { type: "audio/webm" }));
      };
      voiceRecorder.start();
      toast(t("recording"));
    })
    .catch(() => toast(t("mic_failed")));
}
function stopVoice() {
  voiceRecorder?.stop();
  voiceStream?.getTracks().forEach((track) => track.stop());
  voiceRecorder = null;
  voiceStream = null;
}
function thread(id) {
  const message =
    state.messages.find((x) => x.id === id) ||
    state.messages.find((x) => x.threadReplies?.length);
  $("drawer").classList.remove("hidden");
  $("drawer").innerHTML =
    `<button onclick="$('drawer').classList.add('hidden')">← ${t("close")}</button><h3>${t("thread")}</h3>${message ? `<div class="drawer-row"><b>${esc(message.fromName || "")}</b><br>${esc(message.text || "")}</div>${(message.threadReplies || []).map((x) => `<div class="drawer-row"><b>${esc(x.fromName || "")}</b><br>${esc(x.text || "")}</div>`).join("")}` : `<div class="drawer-row">${t("no_thread")}</div>`}`;
}
function ambient() {
  bridge("ambient", "ambient-observe", []);
  $("drawer").classList.remove("hidden");
  $("drawer").innerHTML =
    `<h3>${t("ambient")}</h3><div id="ambient-data">${t("ambient_loading")}</div>`;
}
function trackingDetail(index) {
  const candidate = state.ambientCandidates[index];
  if (!candidate) return;
  const evidence = (candidate.evidence || [])
    .map(
      (item) =>
        `<section class="tracking-evidence"><header><b>${esc(item.senderName || "LINE")}</b></header>${item.text ? `<p>${esc(item.text)}</p>` : ""}${item.ocrText ? `<div class="tracking-ocr"><b>${lang === "zh-TW" ? "圖片辨識文字" : lang === "ja" ? "画像から認識したテキスト" : "Recognized image text"}</b><pre>${esc(item.ocrText)}</pre></div>` : ""}</section>`,
    )
    .join("");
  $("drawer").classList.remove("hidden");
  $("drawer").innerHTML = `<button onclick="$('drawer').classList.add('hidden')">← ${t("close")}</button><h3>${esc(candidate.title || "")}</h3>${evidence}<button class="primary tracking-open" onclick="selectChat('${esc(candidate.chatId)}')">${lang === "zh-TW" ? "開啟對話" : lang === "ja" ? "トークを開く" : "Open conversation"}</button>`;
}
function showYomi() {
  state.selected = null;
  $("briefing").classList.add("hidden");
  $("messages").classList.add("hidden");
  $("composer").classList.add("hidden");
  $("detail-head").innerHTML = "";
  $("yomi-panel").classList.remove("hidden");
  const tools = window.codingTools || [];
  $("yomi-panel").innerHTML =
    `<h2>${t("yomi")}</h2><p>${t("yomi_status")}</p><div class="yomi-form"><textarea id="yomi-input" placeholder="${esc(t("yomi"))}"></textarea><button class="primary" onclick="runYomi()">${t("run_yomi")}</button></div><div class="yomi-status" id="yomi-status">${t("provider")}: <select id="yomi-provider">${tools.map((x) => `<option value="${esc(x.id)}">${esc(x.display_name || x.id)}${x.detected ? " ✓" : ""}</option>`).join("") || '<option value="auto">auto</option>'}</select></div>`;
}
function runYomi() {
  const prompt = $("yomi-input")?.value.trim();
  if (!prompt) return;
  const provider = $("yomi-provider")?.value || "auto";
  send("coding_tool_run:" + JSON.stringify({ provider, prompt }));
  $("yomi-status").textContent = t("syncing");
  toast(t("syncing"));
}
function settings() {
  const appearance = localStorage.getItem("yomi-appearance") || "system";
  const sync = localStorage.getItem("yomi-sync") || "realtime";
  const notifications = localStorage.getItem("yomi-notifications") !== "false";
  $("modal").classList.remove("hidden");
  $("modal").innerHTML =
    `<div class="card"><button onclick="closeModal()">×</button><h2>${t("settings")}</h2><div class="setting"><span>${t("settings_language")}</span><select id="language" onchange="lang=this.value;localStorage.setItem('yomi-language',lang);i18n();settings()"><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option></select></div><div class="setting"><span>${t("settings_appearance")}</span><select id="appearance" onchange="localStorage.setItem('yomi-appearance',this.value);applyAppearance(this.value)"><option value="system">${t("system")}</option><option value="light">${t("light")}</option><option value="dark">${t("dark")}</option></select></div><div class="setting"><span>${t("settings_sync")}</span><select id="sync-mode" onchange="localStorage.setItem('yomi-sync',this.value)"><option value="realtime">${t("realtime")}</option><option value="1m">${t("one_min")}</option><option value="5m">${t("five_min")}</option></select></div><div class="setting"><span>${t("settings_notifications")}</span><input id="notifications" type="checkbox" ${notifications ? "checked" : ""} onchange="localStorage.setItem('yomi-notifications',this.checked)"></div><div class="setting"><span>${t("settings_update")}</span><button onclick="send('open_url:https://github.com/RikaiDev/yomi/releases')">${t("check_update")}</button></div><div class="setting"><span>${t("settings_about")}</span><small>${t("about_note")} · ${t("version")} 0.1.0</small></div><div class="setting"><span>LINE</span><button onclick="closeModal();$('login').classList.remove('hidden')">${t("relogin")}</button></div></div>`;
  $("language").value = lang;
  $("appearance").value = appearance;
  $("sync-mode").value = sync;
}
function applyAppearance(value) {
  document.documentElement.dataset.theme = value;
}
function closeModal() {
  $("modal").classList.add("hidden");
}
function rich(menu) {
  state.menu = menu;
  if (!menu?.imageUrl) {
    $("rich").classList.add("hidden");
    return;
  }
  $("rich").classList.remove("hidden");
  $("rich").innerHTML =
    `<img src="${esc(menu.imageUrl)}"><div class="rich-actions">${(menu.areas || []).map((a, i) => `<button style="left:${(a.x / menu.width) * 100}%;top:${(a.y / menu.height) * 100}%;width:${(a.width / menu.width) * 100}%;height:${(a.height / menu.height) * 100}%" onclick="richAction(${i})"></button>`).join("")}</div>`;
}
function richAction(i) {
  const a = state.menu?.areas?.[i];
  safeAction({ type: a?.type, uri: a?.uri, text: a?.text });
}
function cancelLogin() {
  if (loginTimer) clearInterval(loginTimer);
  send("login_cancel");
  $("login").classList.add("hidden");
  $("login-button").disabled = false;
}
function login(event) {
  event.preventDefault();
  const phone = $("phone").value.trim();
  const region = $("region").value;
  $("login-button").disabled = true;
  $("login-status").textContent = t("syncing");
  send("login_start:" + JSON.stringify({ phone, region }));
}
window.receiveBridgeResult = (id, ok, raw, error) => {
  const request = pending[id] || {};
  delete pending[id];
  if (!ok) {
    if (id.startsWith("mark:")) delete state.pendingReads[id.slice(5)];
    toast(error || t("operation_failed"));
    return;
  }
  const data = parse(raw);
  if (id === "chats") {
    state.chats = (Array.isArray(data) ? data : []).map((chat) => {
      const cursor = state.pendingReads[chat.id];
      if (!cursor) return chat;
      if (!chat.unreadCount) {
        delete state.pendingReads[chat.id];
      } else if (Date.now() - cursor.createdAt < 60000 && (chat.timestamp || 0) <= cursor.timestamp) {
        return { ...chat, unreadCount: 0 };
      } else {
        delete state.pendingReads[chat.id];
      }
      return chat;
    });
    renderChats();
    $("sync-label").textContent =
      t("synced") + " " + new Date().toLocaleTimeString();
    if (!state.selected && state.view === "attention") showBriefing();
  } else if (id.startsWith("messages:")) {
    const chat = id.slice(9);
    if (
      state.selected !== chat ||
      (request.generation !== undefined &&
        request.generation !== state.generation)
    )
      return;
    state.messages = Array.isArray(data) ? data : [];
    renderMessages();
    if (state.messages.length) {
      const latest = state.messages.at(-1);
      state.pendingReads[chat] = { timestamp: latest.timestamp || 0, createdAt: Date.now() };
      const row = state.chats.find((item) => item.id === chat);
      if (row) row.unreadCount = 0;
      renderChats();
      bridge("mark:" + chat, "mark-read", [chat, state.messages.at(-1).id]);
    }
  } else if (id.startsWith("mark:")) {
    const chat = id.slice(5);
    if (!data?.marked) {
      delete state.pendingReads[chat];
      loadChats();
    }
  } else if (id.startsWith("menu:")) {
    if (state.selected === id.slice(5)) rich(data);
  } else if (id.startsWith("media:")) {
    const message = id.slice(6);
    if (data?.data) {
      state.media[message] = data;
      renderMessages();
    }
  } else if (id === "ambient") {
    const candidates = data?.candidates || [];
    state.ambientCandidates = candidates;
    $("ambient-data").innerHTML = candidates.length
      ? candidates
          .map(
            (x, index) =>
              `<button class="tracking-row" onclick="trackingDetail(${index})"><div><small>${esc(x.chatName || "")}</small><strong>${esc(x.title || "")}</strong><span>${esc(x.responseState === "waiting" ? (lang === "zh-TW" ? "等待你回覆" : lang === "ja" ? "あなたの返信待ち" : "Waiting for your reply") : (lang === "zh-TW" ? "待你確認" : lang === "ja" ? "確認が必要" : "Needs your review"))}</span></div><b>›</b></button>`,
          )
          .join("")
      : `<div class="drawer-row">${t("no_candidates")}</div>`;
  } else if (id === "sticker-packages") {
    const first = (data || [])[0];
    if (first)
      bridge("sticker-previews:" + first.packageId, "sticker-previews", [
        first.packageId,
        "12",
        lang,
      ]);
  } else if (id.startsWith("sticker-previews:")) {
    $("stickers").innerHTML = (data || [])
      .map(
        (x) =>
          `<img src="data:${x.mimeType};base64,${x.data}" onclick="bridge('sticker-send:${x.stickerId}','send-sticker',[state.selected,'${esc(x.stickerId)}','${esc(x.packageId)}','1'])">`,
      )
      .join("");
  } else if (id.startsWith("upload:") || id.startsWith("voice:")) {
    if (data?.filePath) {
      const file = request.file;
      if (request.command === "voice")
        bridge("audio-send:" + Date.now(), "send-audio", [
          state.selected,
          data.filePath,
          file?.name || "voice.webm",
        ]);
      else
        bridge("send-file:" + Date.now(), "send-file", [
          state.selected,
          data.filePath,
        ]);
    }
  } else if (
    id.startsWith("send:") ||
    id.startsWith("send-file:") ||
    id.startsWith("audio-send:") ||
    id.startsWith("sticker-send:")
  ) {
    loadChats();
    if (state.selected) loadMessages(state.selected, false);
  }
};
window.updateState = (s) => {
  state.connected = !!s.connected;
  window.codingTools = s.codingTools || [];
  $("status").textContent = s.connected ? t("online") : t("offline");
  $("connection").textContent = s.connected ? t("online") : t("offline");
  $("name").textContent = s.displayName || "LINE";
  $("avatar").textContent = s.avatarText || "YM";
  if (!s.connected) $("login").classList.remove("hidden");
  else $("login").classList.add("hidden");
  if (state.yomiPanelVisible) showYomi();
};
window.updateLoginState = (u) => {
  if (u.state === "pin") {
    const pin = u.pin || "";
    $("login-status").textContent = `PIN: ${pin} · 180s`;
    let left = 180;
    clearInterval(loginTimer);
    loginTimer = setInterval(() => {
      left--;
      if (left <= 0) clearInterval(loginTimer);
      $("login-status").textContent = `PIN: ${pin} · ${left}s`;
    }, 1000);
  } else if (u.state === "waiting_approval")
    $("login-status").textContent = t("login_copy");
  else if (u.state === "success") {
    clearInterval(loginTimer);
    $("login").classList.add("hidden");
    $("login-button").disabled = false;
    loadChats();
  } else if (u.state === "error") {
    $("login-button").disabled = false;
    $("login-status").textContent = u.message || t("operation_failed");
  }
};
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "r") {
    event.preventDefault();
    loadChats(true);
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "j") {
    event.preventDefault();
    showYomi();
  }
  if (event.key === "Escape") {
    $("drawer").classList.add("hidden");
    $("modal").classList.add("hidden");
  }
});
const dropzone = $("dropzone");
for (const type of ["dragenter", "dragover"])
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add("drop-target");
  });
for (const type of ["dragleave", "drop"])
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drop-target");
  });
dropzone.addEventListener("drop", (e) => {
  const files = [...e.dataTransfer.files];
  state.attachments = state.attachments || [];
  for (const file of files.slice(0, 8 - state.attachments.length))
    state.attachments.push(file);
  renderAttachments();
});
window.addEventListener("load", () => {
  i18n();
  $("detail-head").innerHTML = `<div class="empty">${t("start")}</div>`;
  state.attachments = [];
  loadChats();
  applyAppearance(localStorage.getItem("yomi-appearance") || "system");
  setInterval(() => {
    if (state.connected) loadChats(false);
  }, 30000);
});
