import { BaseWindow, nativeTheme, screen, shell } from "electron";
import { Tab } from "./Tab";
import { TopBar } from "./TopBar";
import { SideBar } from "./SideBar";
import { AgentOverlay } from "./AgentOverlay";

const TAB_TOPBAR_HEIGHT = 88;
const TARGET_ASPECT_RATIO = 1440 / 900;

const getChromeBackgroundColor = (): string => (nativeTheme.shouldUseDarkColors ? "#141414" : "#ffffff");

export class Window {
  private _baseWindow: BaseWindow;
  private tabsMap: Map<string, Tab> = new Map();
  private activeTabId: string | null = null;
  private tabCounter: number = 0;
  private _topBar: TopBar;
  private _sideBar: SideBar;
  private _agentOverlay: AgentOverlay | null = null;

  constructor() {
    // Create the browser window.
    this._baseWindow = new BaseWindow({
      width: 1000,
      height: 800,
      show: true,
      autoHideMenuBar: false,
      titleBarStyle: "hidden",
      backgroundColor: getChromeBackgroundColor(),
      ...(process.platform !== "darwin" ? { titleBarOverlay: true } : {}),
      trafficLightPosition: { x: 15, y: 13 },
    });

    this._baseWindow.setMinimumSize(1000, 800);

    this._topBar = new TopBar(this._baseWindow);
    this._sideBar = new SideBar(this._baseWindow);

    // this._sideBar.view.webContents.openDevTools({mode: 'detach'});

    // Set the window reference on the LLM client to avoid circular dependency
    this._sideBar.client.setWindow(this);

    this._agentOverlay = new AgentOverlay(this._baseWindow);
    this.updateOverlayBounds();

    // Create the first tab
    this.createTab();

    nativeTheme.on("updated", () => {
      const bg = getChromeBackgroundColor();
      try {
        const anyWin = this._baseWindow as any;
        if (anyWin && typeof anyWin.setBackgroundColor === "function") {
          anyWin.setBackgroundColor(bg);
        }
      } catch {
        // ignore
      }

      try {
        this.tabsMap.forEach((tab) => tab.setBackgroundColor(bg));
      } catch {
        // ignore
      }
    });

    // Set up window resize handler
    this._baseWindow.on("resize", () => {
      this.updateTabBounds();
      this.updateOverlayBounds();
      this._topBar.updateBounds();
      this._sideBar.updateBounds();
      // Notify renderer of resize through active tab
      const bounds = this._baseWindow.getBounds();
      if (this.activeTab) {
        this.activeTab.webContents.send("window-resized", {
          width: bounds.width,
          height: bounds.height,
        });
      }
    });

    this._baseWindow.on("move", () => {
      this.updateOverlayBounds();
    });

    this._baseWindow.on("moved", () => {
      this.updateOverlayBounds();
    });

    this._baseWindow.on("show", () => {
      this.updateOverlayBounds();
      try {
        this._agentOverlay?.show();
      } catch {
        // ignore
      }
    });

    this._baseWindow.on("minimize", () => {
      try {
        this._agentOverlay?.hide();
      } catch {
        // ignore
      }
    });

    this._baseWindow.on("restore", () => {
      this.updateOverlayBounds();
      try {
        this._agentOverlay?.show();
      } catch {
        // ignore
      }
    });

    this.setupEventListeners();
  }

  private shouldLockTabAspectRatio(): boolean {
    const raw = process.env.AI_LOCK_TAB_ASPECT_RATIO;
    return raw === "1" || raw === "true";
  }

  private getTabContainerBounds(): { x: number; y: number; width: number; height: number } {
    const bounds = this._baseWindow.getBounds();
    const sidebarWidth = this._sideBar.getIsVisible() ? this._sideBar.getWidth() : 0;

    return {
      x: 0,
      y: TAB_TOPBAR_HEIGHT,
      width: Math.max(0, bounds.width - sidebarWidth),
      height: Math.max(0, bounds.height - TAB_TOPBAR_HEIGHT),
    };
  }

  private fitAspectRatioWithin(bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): { x: number; y: number; width: number; height: number } {
    const w = Math.max(0, Math.floor(bounds.width));
    const h = Math.max(0, Math.floor(bounds.height));
    if (w === 0 || h === 0) return bounds;

    const containerAspect = w / h;
    let fitW = w;
    let fitH = h;

    if (containerAspect > TARGET_ASPECT_RATIO) {
      // Too wide: height is limiting.
      fitH = h;
      fitW = Math.floor(h * TARGET_ASPECT_RATIO);
    } else {
      // Too tall (or equal): width is limiting.
      fitW = w;
      fitH = Math.floor(w / TARGET_ASPECT_RATIO);
    }

    const offsetX = Math.floor((w - fitW) / 2);
    const offsetY = Math.floor((h - fitH) / 2);

    return {
      x: bounds.x + offsetX,
      y: bounds.y + offsetY,
      width: fitW,
      height: fitH,
    };
  }

  private getTabBoundsForLayout(): { x: number; y: number; width: number; height: number } {
    const container = this.getTabContainerBounds();
    return this.shouldLockTabAspectRatio() ? this.fitAspectRatioWithin(container) : container;
  }

  private setupEventListeners(): void {
    this._baseWindow.on("closed", () => {
      // Clean up all tabs when window is closed
      this.tabsMap.forEach((tab) => tab.destroy());
      this.tabsMap.clear();

      try {
        this._agentOverlay?.destroy();
      } catch {
        // ignore
      }
    });
  }

  // Getters
  get window(): BaseWindow {
    return this._baseWindow;
  }

  get activeTab(): Tab | null {
    if (this.activeTabId) {
      return this.tabsMap.get(this.activeTabId) || null;
    }
    return null;
  }

  get allTabs(): Tab[] {
    return Array.from(this.tabsMap.values());
  }

  get tabCount(): number {
    return this.tabsMap.size;
  }

  // Tab management methods
  createTab(url?: string): Tab {
    const tabId = `tab-${++this.tabCounter}`;
    const tab = new Tab(tabId, url);

    tab.setBackgroundColor(getChromeBackgroundColor());

    tab.webContents.setWindowOpenHandler((details) => {
      try {
        const parsed = new URL(details.url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          tab.loadURL(details.url);
          return { action: "deny" };
        }
      } catch {
        // ignore URL parsing errors and fall through
      }

      shell.openExternal(details.url);
      return { action: "deny" };
    });

    // Add the tab's WebContentsView to the window
    this._baseWindow.contentView.addChildView(tab.view);

    // Set the bounds to fill the window below the topbar and to the left of sidebar
    tab.view.setBounds(this.getTabBoundsForLayout());

    this.updateOverlayBounds();

    // Store the tab
    this.tabsMap.set(tabId, tab);

    // If this is the first tab, make it active
    if (this.tabsMap.size === 1) {
      this.switchActiveTab(tabId);
    } else {
      // Hide the tab initially if it's not the first one
      tab.hide();
    }

    return tab;
  }

  closeTab(tabId: string): boolean {
    const tab = this.tabsMap.get(tabId);
    if (!tab) {
      return false;
    }

    // Remove the WebContentsView from the window
    this._baseWindow.contentView.removeChildView(tab.view);

    // Destroy the tab
    tab.destroy();

    // Remove from our tabs map
    this.tabsMap.delete(tabId);

    // If this was the active tab, switch to another tab
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
      const remainingTabs = Array.from(this.tabsMap.keys());
      if (remainingTabs.length > 0) {
        this.switchActiveTab(remainingTabs[0]);
      }
    }

    // If no tabs left, close the window
    if (this.tabsMap.size === 0) {
      this._baseWindow.close();
    }

    return true;
  }

  switchActiveTab(tabId: string): boolean {
    const tab = this.tabsMap.get(tabId);
    if (!tab) {
      return false;
    }

    // Hide the currently active tab
    if (this.activeTabId && this.activeTabId !== tabId) {
      const currentTab = this.tabsMap.get(this.activeTabId);
      if (currentTab) {
        currentTab.hide();
      }
    }

    // Show the new active tab
    tab.show();
    this.activeTabId = tabId;

    this.updateOverlayBounds();

    // Update the window title to match the tab title
    this._baseWindow.setTitle(tab.title || "Blueberry Browser");

    return true;
  }

  getTab(tabId: string): Tab | null {
    return this.tabsMap.get(tabId) || null;
  }

  // Window methods
  show(): void {
    this._baseWindow.show();
  }

  hide(): void {
    this._baseWindow.hide();
  }

  close(): void {
    this._baseWindow.close();
  }

  focus(): void {
    this._baseWindow.focus();
  }

  minimize(): void {
    this._baseWindow.minimize();
  }

  maximize(): void {
    this._baseWindow.maximize();
  }

  unmaximize(): void {
    this._baseWindow.unmaximize();
  }

  isMaximized(): boolean {
    return this._baseWindow.isMaximized();
  }

  setTitle(title: string): void {
    this._baseWindow.setTitle(title);
  }

  setBounds(bounds: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }): void {
    this._baseWindow.setBounds(bounds);
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return this._baseWindow.getBounds();
  }

  resizeTabContainerToExactAspectRatio(): boolean {
    try {
      const current = this._baseWindow.getBounds();
      const sidebarWidth = this._sideBar.getIsVisible() ? this._sideBar.getWidth() : 0;

      const containerW = Math.max(1, Math.floor(current.width - sidebarWidth));
      const containerH = Math.max(1, Math.floor(current.height - TAB_TOPBAR_HEIGHT));

      const currentAspect = containerW / containerH;

      let targetWindowW = current.width;
      let targetWindowH = current.height;

      if (currentAspect > TARGET_ASPECT_RATIO) {
        // Too wide: expand height.
        const targetContainerH = Math.ceil(containerW / TARGET_ASPECT_RATIO);
        targetWindowH = targetContainerH + TAB_TOPBAR_HEIGHT;
      } else if (currentAspect < TARGET_ASPECT_RATIO) {
        // Too tall: expand width.
        const targetContainerW = Math.ceil(containerH * TARGET_ASPECT_RATIO);
        targetWindowW = targetContainerW + sidebarWidth;
      } else {
        return true;
      }

      // Respect minimum window size.
      targetWindowW = Math.max(1000, Math.floor(targetWindowW));
      targetWindowH = Math.max(800, Math.floor(targetWindowH));

      // Clamp to the current display work area.
      const display = screen.getDisplayMatching(current);
      const workArea = display?.workArea ?? display?.bounds;
      const maxW = typeof workArea?.width === "number" ? workArea.width : targetWindowW;
      const maxH = typeof workArea?.height === "number" ? workArea.height : targetWindowH;
      const clampedW = Math.min(targetWindowW, maxW);
      const clampedH = Math.min(targetWindowH, maxH);

      // Preserve center when resizing.
      const centerX = current.x + Math.floor(current.width / 2);
      const centerY = current.y + Math.floor(current.height / 2);
      let nextX = centerX - Math.floor(clampedW / 2);
      let nextY = centerY - Math.floor(clampedH / 2);

      if (workArea) {
        const minX = typeof workArea.x === "number" ? workArea.x : nextX;
        const minY = typeof workArea.y === "number" ? workArea.y : nextY;
        const maxX2 = minX + maxW;
        const maxY2 = minY + maxH;

        if (nextX < minX) nextX = minX;
        if (nextY < minY) nextY = minY;
        if (nextX + clampedW > maxX2) nextX = Math.max(minX, maxX2 - clampedW);
        if (nextY + clampedH > maxY2) nextY = Math.max(minY, maxY2 - clampedH);
      }

      try {
        if (this._baseWindow.isMaximized()) {
          this._baseWindow.unmaximize();
        }
      } catch {
        // ignore
      }

      this._baseWindow.setBounds({ x: nextX, y: nextY, width: clampedW, height: clampedH });
      this.updateAllBounds();
      return true;
    } catch {
      return false;
    }
  }

  // Handle window resize to update tab bounds
  private updateTabBounds(): void {
    const tabBounds = this.getTabBoundsForLayout();

    this.tabsMap.forEach((tab) => {
      tab.view.setBounds(tabBounds);
    });
  }

  private updateOverlayBounds(): void {
    const tabBounds = this.getTabBoundsForLayout();
    if (this._agentOverlay) {
      this._agentOverlay.setBounds({
        x: tabBounds.x,
        y: tabBounds.y,
        width: tabBounds.width,
        height: tabBounds.height,
      });
    }
  }

  // Public method to update all bounds when sidebar is toggled
  updateAllBounds(): void {
    this.updateTabBounds();
    this._sideBar.updateBounds();
    this.updateOverlayBounds();
  }

  // Getter for sidebar to access from main process
  get sidebar(): SideBar {
    return this._sideBar;
  }

  get agentOverlay(): AgentOverlay {
    if (!this._agentOverlay) {
      throw new Error("AgentOverlay not initialized");
    }
    return this._agentOverlay;
  }

  // Getter for topBar to access from main process
  get topBar(): TopBar {
    return this._topBar;
  }

  // Getter for all tabs as array
  get tabs(): Tab[] {
    return Array.from(this.tabsMap.values());
  }

  // Getter for baseWindow to access from Menu
  get baseWindow(): BaseWindow {
    return this._baseWindow;
  }
}
