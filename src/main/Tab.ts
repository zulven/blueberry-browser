import { NativeImage, WebContentsView } from "electron";

export class Tab {
  private webContentsView: WebContentsView;
  private _id: string;
  private _title: string;
  private _url: string;
  private _isVisible: boolean = false;

  constructor(id: string, url: string = "https://www.google.com") {
    this._id = id;
    this._url = url;
    this._title = "New Tab";

    // Create the WebContentsView for web content only
    this.webContentsView = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });

    // Set up event listeners
    this.setupEventListeners();

    // Load the initial URL
    this.loadURL(url);
  }

  private setupEventListeners(): void {
    // Update title when page title changes
    this.webContentsView.webContents.on("page-title-updated", (_, title) => {
      this._title = title;
    });

    this.webContentsView.webContents.on("console-message", (event) => {
      const anyEvent = event as any;
      const level = typeof anyEvent?.level === "number" ? anyEvent.level : 0;
      const message = typeof anyEvent?.message === "string" ? anyEvent.message : "";
      const line = typeof anyEvent?.line === "number" ? anyEvent.line : 0;
      const sourceId = typeof anyEvent?.sourceId === "string" ? anyEvent.sourceId : "";

      // 0=log, 1=warn, 2=error, 3=debug (varies slightly by Electron version)
      if (level >= 1) {
        console.log(`[TAB console level=${level}] ${message} (${sourceId}:${line})`);
      }
    });

    // Update URL when navigation occurs
    this.webContentsView.webContents.on("did-navigate", (_, url) => {
      this._url = url;
    });

    this.webContentsView.webContents.on("did-navigate-in-page", (_, url) => {
      this._url = url;
    });
  }

  // Getters
  get id(): string {
    return this._id;
  }

  get title(): string {
    return this._title;
  }

  get url(): string {
    return this._url;
  }

  get isVisible(): boolean {
    return this._isVisible;
  }

  get webContents() {
    return this.webContentsView.webContents;
  }

  get view(): WebContentsView {
    return this.webContentsView;
  }

  // Public methods
  show(): void {
    this._isVisible = true;
    this.webContentsView.setVisible(true);
  }

  hide(): void {
    this._isVisible = false;
    this.webContentsView.setVisible(false);
  }

  setBackgroundColor(color: string): void {
    try {
      if (typeof color !== "string" || color.trim().length === 0) return;
      const wcAny = this.webContentsView.webContents as any;
      if (wcAny && typeof wcAny.setBackgroundColor === "function") {
        wcAny.setBackgroundColor(color);
      }
    } catch {
      // ignore
    }
  }

  async screenshot(): Promise<NativeImage> {
    return await this.webContentsView.webContents.capturePage();
  }

  async runJs(code: string): Promise<any> {
    const wc = this.webContentsView.webContents;
    if (wc.isDestroyed()) {
      throw new Error("Tab webContents is destroyed");
    }

    const maxAttempts = 3;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await wc.executeJavaScript(code, true);
      } catch (error) {
        lastError = error;

        const msg =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "";

        const retryable =
          msg.toLowerCase().includes("execution context was destroyed") ||
          msg.toLowerCase().includes("render frame was disposed") ||
          msg.toLowerCase().includes("cannot find context with specified id") ||
          msg.toLowerCase().includes("script failed to execute") ||
          msg.toLowerCase().includes("object has been destroyed");

        if (!retryable || attempt === maxAttempts) {
          throw error;
        }

        await new Promise((r) => setTimeout(r, 75 * attempt));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Failed to execute JS"));
  }

  async getTabHtml(): Promise<string> {
    return await this.runJs("(() => document.documentElement.outerHTML)()");
  }

  async getTabText(): Promise<string> {
    return await this.runJs("(() => document.documentElement.innerText)()");
  }

  async getViewportText(): Promise<string> {
    const js =
      "(() => {" +
      "try{" +
      "const root=document.body||document.documentElement;" +
      "if(!root)return '';" +
      "const vw=window.innerWidth||document.documentElement.clientWidth||0;" +
      "const vh=window.innerHeight||document.documentElement.clientHeight||0;" +
      "if(!vw||!vh)return '';" +
      "const parts=[];const seen=new Set();" +
      "const isVisible=(el)=>{" +
      "if(!el||!(el instanceof Element))return false;" +
      "const s=window.getComputedStyle(el);" +
      "if(!s)return false;" +
      "if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false;" +
      "if(el.hasAttribute('hidden')||el.getAttribute('aria-hidden')==='true')return false;" +
      "return true;" +
      "};" +
      "const intersects=(r)=>r.bottom>0&&r.right>0&&r.top<vh&&r.left<vw;" +
      "const SHOW_TEXT=(typeof NodeFilter!=='undefined'&&NodeFilter.SHOW_TEXT)?NodeFilter.SHOW_TEXT:4;" +
      "const FILTER_ACCEPT=(typeof NodeFilter!=='undefined'&&NodeFilter.FILTER_ACCEPT)?NodeFilter.FILTER_ACCEPT:1;" +
      "const FILTER_REJECT=(typeof NodeFilter!=='undefined'&&NodeFilter.FILTER_REJECT)?NodeFilter.FILTER_REJECT:2;" +
      "const walker=document.createTreeWalker(root,SHOW_TEXT,{acceptNode:(node)=>{" +
      "const t=node&&node.nodeValue?String(node.nodeValue).replace(/\\s+/g,' ').trim():'';" +
      "if(!t)return FILTER_REJECT;" +
      "const p=node.parentElement;" +
      "if(!p||!isVisible(p))return FILTER_REJECT;" +
      "return FILTER_ACCEPT;" +
      "}});" +
      "for(let n=walker.nextNode();n;n=walker.nextNode()){" +
      "const p=n.parentElement;" +
      "if(!p)continue;" +
      "const r=p.getBoundingClientRect();" +
      "if(!intersects(r))continue;" +
      "const t=n.nodeValue?String(n.nodeValue).replace(/\\s+/g,' ').trim():'';" +
      "if(!t)continue;" +
      "const key=t+'@@'+Math.round(r.top)+'@@'+Math.round(r.left);" +
      "if(seen.has(key))continue;" +
      "seen.add(key);parts.push(t);" +
      "}" +
      "return parts.join('\\n');" +
      "}catch(e){return '';}})()";

    return await this.runJs(js);
  }

  loadURL(url: string): Promise<void> {
    this._url = url;
    return this.webContentsView.webContents.loadURL(url);
  }

  goBack(): void {
    if (this.webContentsView.webContents.navigationHistory.canGoBack()) {
      this.webContentsView.webContents.navigationHistory.goBack();
    }
  }

  goForward(): void {
    if (this.webContentsView.webContents.navigationHistory.canGoForward()) {
      this.webContentsView.webContents.navigationHistory.goForward();
    }
  }

  reload(): void {
    this.webContentsView.webContents.reload();
  }

  stop(): void {
    this.webContentsView.webContents.stop();
  }

  destroy(): void {
    this.webContentsView.webContents.close();
  }
}
