import Cocoa
import Combine
import SwiftUI

// MARK: - Floating Panels

@MainActor
class YomiPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        self.isOpaque = false
        self.backgroundColor = .clear
        self.level = .statusBar
        self.hasShadow = true
        self.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        self.isMovableByWindowBackground = false
    }
}

@MainActor
private final class YomiToolbarDelegate: NSObject, NSToolbarDelegate {
    static let themeIdentifier = NSToolbarItem.Identifier("dev.rikai.yomi.toolbar.theme")
    static let syncIdentifier = NSToolbarItem.Identifier("dev.rikai.yomi.toolbar.sync")
    let state: AppState
    weak var window: NSWindow?
    private var themeButton: NSButton?
    private var syncButton: NSButton?
    private var observation: AnyCancellable?

    init(state: AppState, window: NSWindow) {
        self.state = state
        self.window = window
        super.init()
        observation = state.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.refreshButtons() }
        }
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, Self.themeIdentifier, Self.syncIdentifier]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, Self.themeIdentifier, Self.syncIdentifier]
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool)
        -> NSToolbarItem?
    {
        let item = NSToolbarItem(itemIdentifier: itemIdentifier)
        if itemIdentifier == Self.themeIdentifier {
            let button = toolbarButton(symbol: "circle.lefthalf.filled", label: "切換外觀", action: #selector(toggleTheme(_:)))
            themeButton = button
            item.view = button
            item.label = "切換外觀"
            item.toolTip = "切換外觀"
        } else if itemIdentifier == Self.syncIdentifier {
            let button = toolbarButton(symbol: "arrow.triangle.2.circlepath", label: "更新訊息", action: #selector(sync(_:)))
            syncButton = button
            item.view = button
            item.label = "更新訊息"
            item.toolTip = "更新訊息"
        } else {
            return nil
        }
        refreshButtons()
        return item
    }

    private func setButton(_ button: NSButton?, symbol: String, label: String, tint: NSColor) {
        guard let button else { return }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label) ?? NSImage()
        image.isTemplate = true
        button.image = image
        button.contentTintColor = tint
        button.toolTip = label
        button.setAccessibilityLabel(label)
    }

    private func refreshButtons() {
        let isDark: Bool
        switch state.appearance {
        case .light:
            window?.appearance = NSAppearance(named: .aqua)
            isDark = false
        case .dark:
            window?.appearance = NSAppearance(named: .darkAqua)
            isDark = true
        case .system:
            window?.appearance = nil
            isDark = window?.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        }
        window?.backgroundColor =
            isDark
            ? NSColor(calibratedWhite: 0.105, alpha: 1)
            : NSColor(calibratedRed: 0.965, green: 0.949, blue: 0.918, alpha: 1)
        let chromeTint = isDark ? NSColor.white.withAlphaComponent(0.84) : NSColor(calibratedWhite: 0.18, alpha: 0.82)
        switch state.appearance {
        case .light: setButton(themeButton, symbol: "moon.fill", label: "切換為深色外觀", tint: chromeTint)
        case .dark: setButton(themeButton, symbol: "sun.max.fill", label: "切換為淺色外觀", tint: chromeTint)
        case .system: setButton(themeButton, symbol: "circle.lefthalf.filled", label: "目前跟隨系統，點一下切換外觀", tint: chromeTint)
        }

        if state.isSyncing {
            setButton(syncButton, symbol: "arrow.triangle.2.circlepath", label: "正在更新訊息…", tint: .systemOrange)
            startSyncPulse()
        } else if state.syncError != nil {
            stopSyncPulse()
            setButton(syncButton, symbol: "arrow.triangle.2.circlepath", label: "更新失敗，點一下重試", tint: .systemRed)
        } else if !state.lastSyncTimeString.isEmpty {
            stopSyncPulse()
            setButton(
                syncButton, symbol: "arrow.triangle.2.circlepath", label: "已同步 · \(state.lastSyncTimeString)",
                tint: chromeTint)
        } else {
            stopSyncPulse()
            setButton(syncButton, symbol: "arrow.triangle.2.circlepath", label: "更新訊息", tint: chromeTint)
        }
        syncButton?.isEnabled = !state.isSyncing
    }

    private func startSyncPulse() {
        guard let layer = syncButton?.layer, layer.animation(forKey: "yomi.sync.pulse") == nil else { return }
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 1.0
        pulse.toValue = 0.42
        pulse.duration = 0.65
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.isRemovedOnCompletion = false
        layer.add(pulse, forKey: "yomi.sync.pulse")
    }

    private func stopSyncPulse() {
        syncButton?.layer?.removeAnimation(forKey: "yomi.sync.pulse")
        syncButton?.layer?.opacity = 1
    }

    private func toolbarButton(symbol: String, label: String, action: Selector) -> NSButton {
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label) ?? NSImage()
        image.isTemplate = true
        let button = NSButton(image: image, target: self, action: action)
        button.isBordered = false
        button.bezelStyle = .regularSquare
        button.imagePosition = .imageOnly
        button.contentTintColor = NSColor.white.withAlphaComponent(0.82)
        button.wantsLayer = true
        button.toolTip = label
        button.setAccessibilityLabel(label)
        button.frame = NSRect(x: 0, y: 0, width: 30, height: 24)
        return button
    }

    @objc private func toggleTheme(_ sender: Any?) {
        switch state.appearance {
        case .dark: state.appearance = .light
        case .light: state.appearance = .dark
        case .system:
            let systemIsDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            state.appearance = systemIsDark ? .light : .dark
        }
    }

    @objc private func sync(_ sender: Any?) {
        state.refreshInbox(.manual)
    }
}

@MainActor
class YomiMainWindow: NSWindow {
    private var yomiToolbarDelegate: YomiToolbarDelegate?

    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        self.isOpaque = false
        self.backgroundColor = NSColor(calibratedWhite: 0.105, alpha: 1)
        self.title = ""
        self.titlebarAppearsTransparent = true
        self.titleVisibility = .hidden
        self.isMovableByWindowBackground = true
        self.minSize = NSSize(width: 840, height: 560)
        self.hasShadow = true
        self.isReleasedWhenClosed = false
        self.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    }

    func installTitlebar(state: AppState) {
        let delegate = YomiToolbarDelegate(state: state, window: self)
        let toolbar = NSToolbar(identifier: "dev.rikai.yomi.main-toolbar")
        toolbar.delegate = delegate
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        self.yomiToolbarDelegate = delegate
        self.toolbar = toolbar
        self.toolbarStyle = .unifiedCompact
    }
}

// MARK: - App Delegate & MenuBar Mouse Interaction Routing

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var statusItem: NSStatusItem!
    var panel: YomiPanel!
    var loginWindow: NSWindow?
    var integrationWindow: NSWindow?
    var mainWindow: YomiMainWindow?
    var loginViewModel = LoginViewModel()
    var state = AppState()
    var eventMonitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let iconUrl = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
            let iconImg = NSImage(contentsOf: iconUrl)
        {
            NSApp.applicationIconImage = iconImg
        } else if let iconPath = Bundle.main.path(forResource: "AppIcon", ofType: "png"),
            let iconImg = NSImage(contentsOfFile: iconPath)
        {
            NSApp.applicationIconImage = iconImg
        } else if let directImg = NSImage(contentsOfFile: "desktop/mac-native/AppIcon_1024.png") {
            NSApp.applicationIconImage = directImg
        }

        setupEnterpriseMainMenu()

        let panelWidth: CGFloat = 332
        let panelHeight: CGFloat = 376
        self.panel = YomiPanel(contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight))
        self.panel.contentViewController = NSHostingController(
            rootView: PopoverContentView(
                state: state,
                onOpenLoginWindow: { [weak self] in
                    self?.openLoginWindow()
                },
                onOpenIntegrationWindow: { [weak self] in
                    self?.openIntegrationWindow()
                },
                onOpenChatSpotlight: { [weak self] in
                    self?.openMainWindow()
                }
            ))
        self.panel.delegate = self

        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            button.image = createStatusIcon(hasUnread: false)
            button.action = #selector(statusItemClicked(_:))
            button.sendAction(on: [.leftMouseDown, .rightMouseDown])
            button.target = self
        }

        state.onUnreadStatusChanged = { [weak self] hasUnread in
            DispatchQueue.main.async {
                self?.statusItem.button?.image = createStatusIcon(hasUnread: hasUnread)
            }
        }
        state.onSessionEnded = { [weak self] in
            self?.showLoginPage()
        }

        eventMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            if let panel = self?.panel, panel.isVisible {
                self?.hidePanel()
            }
        }

        loginViewModel.onLoginSuccess = { [weak self] in
            guard let self else { return }
            self.state.refreshState()
            self.closeLoginWindow()
            self.showInboxPage()
            self.state.refreshInbox(.startup)
        }

        if CredentialManager.loadCredentials()?.lineAuthToken?.isEmpty == false {
            openMainWindow()
            DispatchQueue.main.async { [weak self] in
                self?.state.refreshInbox(.startup)
            }
        } else {
            showLoginPage()
        }
        DesktopUpdateManager.shared.checkOnLaunchIfNeeded()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            openMainWindow()
        }
        return true
    }

    func setupEnterpriseMainMenu() {
        let mainMenu = NSMenu()

        // 1. App Menu (Yomi)
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        appMenu.addItem(withTitle: "About Yomi", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        let updateItem = NSMenuItem(title: "Check for Updates…", action: #selector(checkForUpdatesFromMenu), keyEquivalent: "")
        updateItem.target = self
        appMenu.addItem(updateItem)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide Yomi", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthersItem = NSMenuItem(
            title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthersItem.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthersItem)
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Yomi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // 2. File Menu
        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: "File")
        fileMenuItem.submenu = fileMenu
        fileMenu.addItem(withTitle: "Open Main Window", action: #selector(openMainWindowFromMenu), keyEquivalent: "o")
        fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        // 3. Edit Menu (Standard macOS Copy / Paste / Cut / Select All / Undo)
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        // 4. View Menu
        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "View")
        viewMenuItem.submenu = viewMenu
        viewMenu.addItem(withTitle: "Refresh LINE Messages", action: #selector(menuRefreshSync), keyEquivalent: "r")

        // 5. Window Menu
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenuItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(NSMenuItem.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")

        NSApp.mainMenu = mainMenu
    }

    @objc private func checkForUpdatesFromMenu() {
        DesktopUpdateManager.shared.checkForUpdates()
    }

    @objc func openMainWindowFromMenu() {
        openMainWindow()
    }

    @objc func menuRefreshSync() {
        state.syncNow()
    }

    @objc func statusItemClicked(_ sender: AnyObject?) {
        let event = NSApp.currentEvent
        let isRightClick =
            (event?.type == .rightMouseDown || event?.type == .rightMouseUp)
            || ((event?.type == .leftMouseDown || event?.type == .leftMouseUp) && event?.modifierFlags.contains(.control) == true)

        if isRightClick {
            togglePanel(nil)
        } else {
            hidePanel()
            toggleMainWindow()
        }
    }

    @objc func togglePanel(_ sender: AnyObject?) {
        if panel.isVisible {
            hidePanel()
        } else {
            showPanel()
        }
    }

    func showPanel() {
        guard let button = statusItem.button, let buttonWindow = button.window else { return }

        state.refreshState()

        let buttonRectOnScreen = buttonWindow.convertToScreen(button.bounds)
        let screen = buttonWindow.screen ?? NSScreen.main ?? NSScreen.screens[0]
        let screenFrame = screen.visibleFrame

        let panelSize = panel.frame.size
        var targetX = buttonRectOnScreen.midX - (panelSize.width / 2.0)
        let targetY = buttonRectOnScreen.minY - panelSize.height - 4.0

        targetX = max(screenFrame.minX + 8, min(targetX, screenFrame.maxX - panelSize.width - 8))

        panel.setFrameOrigin(NSPoint(x: targetX, y: targetY))
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func hidePanel() {
        panel.orderOut(nil)
    }

    func windowDidResignKey(_ notification: Notification) {
        hidePanel()
    }

    func openLoginWindow() {
        showLoginPage()
    }

    func closeLoginWindow() {
        loginViewModel.cancel()
        loginWindow?.orderOut(nil)
    }

    func openIntegrationWindow() {
        hidePanel()

        if integrationWindow == nil {
            let win = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 450, height: 410),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            win.title = "Claude & Codex Desktop Integration"
            win.isReleasedWhenClosed = false
            win.delegate = self
            win.center()
            win.contentViewController = NSHostingController(
                rootView: IdeIntegrationSheetView(
                    state: state,
                    onClose: { [weak self] in
                        self?.integrationWindow?.orderOut(nil)
                    })
            )
            self.integrationWindow = win
        }

        integrationWindow?.center()
        integrationWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func toggleMainWindow() {
        if let win = mainWindow, win.isVisible {
            win.orderOut(nil)
        } else {
            openMainWindow()
        }
    }

    func showLoginPage() {
        hidePanel()
        loginWindow?.orderOut(nil)
        loginViewModel.step = .inputPhone
        let window = ensureMainWindow()
        enforceMainWindowMinimum(window)
        window.contentViewController = NSHostingController(
            rootView: YomiLoginPageView(viewModel: loginViewModel)
                .preferredColorScheme(state.appearance.colorScheme)
        )
        window.level = .normal
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func showInboxPage() {
        let window = ensureMainWindow()
        enforceMainWindowMinimum(window)
        window.contentViewController = NSHostingController(
            rootView: YomiEnterpriseMainWindowView(
                state: state,
                onOpenLogin: { [weak self] in self?.openLoginWindow() }
            )
        )
        window.level = state.isSpotlightPinned ? .floating : .normal
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func openMainWindow() {
        hidePanel()
        if CredentialManager.loadCredentials()?.lineAuthToken?.isEmpty == false {
            showInboxPage()
        } else {
            showLoginPage()
        }
    }

    private func ensureMainWindow() -> YomiMainWindow {
        if let mainWindow { return mainWindow }
        let initialFrame = initialMainWindowFrame()
        let win = YomiMainWindow(
            contentRect: initialFrame
        )
        win.delegate = self
        win.installTitlebar(state: state)
        self.mainWindow = win
        return win
    }

    private func enforceMainWindowMinimum(_ window: NSWindow) {
        let minimum = NSSize(width: 840, height: 560)
        window.minSize = minimum
        guard window.frame.width < minimum.width || window.frame.height < minimum.height else { return }
        var frame = window.frame
        frame.size.width = max(frame.width, minimum.width)
        frame.size.height = max(frame.height, minimum.height)
        window.setFrame(frame, display: true, animate: false)
    }

    /// Size and position only the first main-window creation. Reopening must
    /// preserve the user's last resize and placement. On small displays the
    /// requested ideal size is clamped to the visible work area with margins.
    private func initialMainWindowFrame() -> NSRect {
        let ideal = NSSize(width: 1100, height: 720)
        let minimum = NSSize(width: 840, height: 560)
        let screen = NSScreen.main ?? NSScreen.screens.first
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: ideal.width, height: ideal.height)
        let width = min(max(minimum.width, ideal.width), max(minimum.width, visible.width - 24))
        let height = min(max(minimum.height, ideal.height), max(minimum.height, visible.height - 24))
        let size = NSSize(width: width, height: height)
        return NSRect(
            x: visible.midX - size.width / 2,
            y: visible.midY - size.height / 2,
            width: size.width,
            height: size.height
        )
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender == loginWindow {
            closeLoginWindow()
            return false
        }
        if sender == integrationWindow {
            integrationWindow?.orderOut(nil)
            return false
        }
        if sender == mainWindow {
            mainWindow?.orderOut(nil)
            return false
        }
        return true
    }
}
