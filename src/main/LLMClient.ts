import { WebContents, dialog } from "electron";
import { streamText, tool, type LanguageModel, type CoreMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { Window } from "./Window";
import { GeminiComputerUseAgent } from "./gemini/GeminiComputerUseAgent";
import * as dotenv from "dotenv";
import { join } from "path";

// Load environment variables from .env file
dotenv.config({ path: join(__dirname, "../../.env") });

interface ChatRequest {
  message: string;
  messageId: string;
}

interface StreamChunk {
  content: string;
  isComplete: boolean;
}

interface ReasoningChunk {
  content: string;
  isComplete: boolean;
}

interface NavigationChunk {
  content: string;
  isComplete: boolean;
}

type LLMProvider = "openai" | "anthropic" | "google";

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  openai: "gpt-5.1",
  anthropic: "claude-3-5-sonnet-20241022",
  google: "gemini-2.5-computer-use-preview-10-2025",
};

const MAX_CONTEXT_LENGTH = 4000;
const DEFAULT_TEMPERATURE = 0.7;

const GEMINI_COMPUTER_USE_MODEL_PREFIX = "gemini-2.5-computer-use-preview";
const DEFAULT_COMPUTER_USE_SCREEN_WIDTH = 1440;
const DEFAULT_COMPUTER_USE_SCREEN_HEIGHT = 900;

export class LLMClient {
  private readonly webContents: WebContents;
  private window: Window | null = null;
  private readonly provider: LLMProvider;
  private readonly modelName: string;
  private readonly model: LanguageModel | null;
  private messages: CoreMessage[] = [];

  private activeRunAbortController: AbortController | null = null;
  private activeRunMessageId: string | null = null;

  private geminiComputerUseContents: any[] | null = null;

  private activeGeminiComputerUseRunId: string | null = null;
  private geminiComputerUseNavigationOverlayBuffer = "";

  private highlightTrackTimer: NodeJS.Timeout | null = null;
  private highlightTrackUrl: string | null = null;

  private stopHighlightTracking(): void {
    if (this.highlightTrackTimer) {
      clearInterval(this.highlightTrackTimer);
      this.highlightTrackTimer = null;
    }
    this.highlightTrackUrl = null;
  }

  private async clearHighlight(runId: string): Promise<void> {
    await this.sendOverlayEvent({ type: "highlight-clear", runId });
  }

  private async startHighlightTracking(tab: any, x: number, y: number): Promise<void> {
    const runId = this.activeGeminiComputerUseRunId;
    if (!runId) return;

    // Reset any existing tracker
    this.stopHighlightTracking();
    this.highlightTrackUrl = typeof tab?.url === "string" ? tab.url : null;

    const emitOnce = async (): Promise<boolean> => {
      const rect = await this.getHighlightRectAt(tab, x, y);
      if (rect) {
        await this.sendOverlayEvent({ type: "highlight", runId, rect });
        return true;
      }
      await this.sendOverlayEvent({ type: "highlight-point", runId, x, y });
      return false;
    };

    try {
      await emitOnce();
    } catch {
      // ignore
    }

    this.highlightTrackTimer = setInterval(() => {
      // fire-and-forget (we handle errors)
      (async () => {
        if (this.activeGeminiComputerUseRunId !== runId) {
          this.stopHighlightTracking();
          return;
        }

        const currentUrl = typeof tab?.url === "string" ? tab.url : null;
        if (this.highlightTrackUrl && currentUrl && currentUrl !== this.highlightTrackUrl) {
          await this.clearHighlight(runId);
          this.stopHighlightTracking();
          return;
        }

        const rect = await this.getHighlightRectAt(tab, x, y);
        if (!rect) {
          await this.clearHighlight(runId);
          this.stopHighlightTracking();
          return;
        }

        await this.sendOverlayEvent({ type: "highlight", runId, rect });
      })().catch(() => undefined);
    }, 250);
  }

  private async sendOverlayEvent(event: any): Promise<void> {
    if (!this.window) return;
    try {
      await this.window.agentOverlay.sendEvent(event);
    } catch {
      // ignore
    }
  }

  private async getHighlightRectAt(tab: any, x: number, y: number): Promise<
    | { x: number; y: number; width: number; height: number }
    | null
  > {
    const js = `(() => {
      try {
        const x = ${x};
        const y = ${y};
        const stack = typeof document.elementsFromPoint === 'function'
          ? document.elementsFromPoint(x, y)
          : [];
        const candidates = (stack && stack.length ? stack : [document.elementFromPoint(x, y)]).filter(Boolean);

        const isInteractive = (el) => {
          if (!el || !(el instanceof Element)) return false;
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'summary' || tag === 'label') return true;
          const role = el.getAttribute('role');
          if (role === 'button' || role === 'link' || role === 'textbox') return true;
          if (el.isContentEditable) return true;
          if (typeof el.onclick === 'function') return true;
          const cs = window.getComputedStyle(el);
          if (cs && cs.cursor === 'pointer') return true;
          return false;
        };

        let base = null;
        for (const el of candidates) {
          if (el && el instanceof Element) { base = el; break; }
        }
        if (!base) return null;

        let target = base;
        let cur = base;
        for (let i = 0; i < 7 && cur; i++) {
          if (isInteractive(cur)) { target = cur; break; }
          cur = cur.parentElement;
        }

        // Try to find a sensible rect.
        let rectEl = target;
        for (let i = 0; i < 5 && rectEl; i++) {
          const r = rectEl.getBoundingClientRect();
          if (r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.width > 2 && r.height > 2) {
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          }
          rectEl = rectEl.parentElement;
        }

        return null;
      } catch {
        return null;
      }
    })();`;

    try {
      const res = await tab.runJs(js);
      if (
        res &&
        typeof res.x === "number" &&
        typeof res.y === "number" &&
        typeof res.width === "number" &&
        typeof res.height === "number"
      ) {
        return res;
      }
    } catch {
      // ignore
    }
    return null;
  }

  private readonly debugStream: boolean =
    process.env.AI_SDK_DEBUG_STREAM === "true" ||
    process.env.AI_SDK_DEBUG_STREAM === "1";

  private openaiReasoningSummaryUnsupported: boolean = false;

  constructor(webContents: WebContents) {
    this.webContents = webContents;
    this.provider = this.getProvider();
    this.modelName = this.getModelName();
    this.model = this.initializeModel();

    this.logInitializationStatus();
  }

  // Set the window reference after construction to avoid circular dependencies
  setWindow(window: Window): void {
    this.window = window;
  }

  private getTabByIdOrActive(tabId?: string | null) {
    if (!this.window) return null;
    if (typeof tabId === "string" && tabId.length > 0) {
      return this.window.getTab(tabId);
    }
    return this.window.activeTab;
  }

  private async requestUserApproval(params: {
    title: string;
    detail: string;
    confirmLabel?: string;
  }): Promise<boolean> {
    const parentWindow = this.window?.window;
    const options = {
      type: "question" as const,
      buttons: [params.confirmLabel ?? "Allow", "Deny"],
      defaultId: 0,
      cancelId: 1,
      title: params.title,
      message: params.title,
      detail: params.detail,
      noLink: true,
    };

    const result = parentWindow
      ? await dialog.showMessageBox(parentWindow, options)
      : await dialog.showMessageBox(options);

    return result.response === 0;
  }

  private getTools(): any {
    return {
      listTabs: tool({
        description:
          "List all open tabs with their ids, titles, urls, and which tab is active.",
        inputSchema: z.object({}),
        execute: async () => {
          if (!this.window) return { tabs: [] };
          const activeId = this.window.activeTab ? this.window.activeTab.id : null;
          return {
            tabs: this.window.allTabs.map((t) => ({
              id: t.id,
              title: t.title,
              url: t.url,
              isActive: activeId === t.id,
            })),
          };
        },
      }),

      getPageText: tool({
        description:
          "Get the visible text of a tab. If tabId is omitted, uses the active tab.",
        inputSchema: z.object({ tabId: z.string().optional() }),
        execute: async ({ tabId }) => {
          const tab = this.getTabByIdOrActive(tabId);
          if (!tab) return { text: "" };
          const text = await tab.getTabText();
          return { text: this.truncateText(text, MAX_CONTEXT_LENGTH) };
        },
      }),

      getPageHtml: tool({
        description:
          "Get the HTML of a tab. If tabId is omitted, uses the active tab.",
        inputSchema: z.object({ tabId: z.string().optional() }),
        execute: async ({ tabId }) => {
          const tab = this.getTabByIdOrActive(tabId);
          if (!tab) return { html: "" };
          const html = await tab.getTabHtml();
          return { html: this.truncateText(html, MAX_CONTEXT_LENGTH) };
        },
      }),

      screenshot: tool({
        description:
          "Capture a screenshot of a tab as a data URL. If tabId is omitted, uses the active tab.",
        inputSchema: z.object({ tabId: z.string().optional() }),
        execute: async ({ tabId }) => {
          const tab = this.getTabByIdOrActive(tabId);
          if (!tab) return { dataUrl: null };
          const image = await tab.screenshot();
          return { dataUrl: image.toDataURL() };
        },
      }),

      navigate: tool({
        description:
          "Navigate a tab to a URL. Requires user approval. If tabId is omitted, uses the active tab.",
        inputSchema: z.object({ tabId: z.string().optional(), url: z.string() }),
        execute: async ({ tabId, url }) => {
          const tab = this.getTabByIdOrActive(tabId);
          if (!tab) return { ok: false, error: "No tab available." };

          const allowed = await this.requestUserApproval({
            title: "Allow navigation?",
            detail: `The assistant wants to navigate tab ${tab.id} to:\n${url}`,
            confirmLabel: "Navigate",
          });

          if (!allowed) return { ok: false, denied: true };

          await tab.loadURL(url);
          return { ok: true };
        },
      }),

      runJs: tool({
        description:
          "Run JavaScript in a tab and return the result. Requires user approval. If tabId is omitted, uses the active tab.",
        inputSchema: z.object({ tabId: z.string().optional(), code: z.string() }),
        execute: async ({ tabId, code }) => {
          const tab = this.getTabByIdOrActive(tabId);
          if (!tab) return { ok: false, error: "No tab available." };

          const allowed = await this.requestUserApproval({
            title: "Allow running JavaScript?",
            detail: `The assistant wants to execute JavaScript in tab ${tab.id}:\n\n${code}`,
            confirmLabel: "Run",
          });

          if (!allowed) return { ok: false, denied: true };

          const result = await tab.runJs(code);
          return { ok: true, result };
        },
      }),
    };
  }

  private getProvider(): LLMProvider {
    const provider = process.env.LLM_PROVIDER?.toLowerCase();
    if (provider === "anthropic") return "anthropic";
    if (provider === "google" || provider === "gemini") return "google";
    return "google"; // Default to Gemini
  }

  private getModelName(): string {
    return process.env.LLM_MODEL || DEFAULT_MODELS[this.provider];
  }

  private initializeModel(): LanguageModel | null {
    const apiKey = this.getApiKey();
    if (!apiKey) return null;

    switch (this.provider) {
      case "anthropic":
        return anthropic(this.modelName);
      case "google":
        return google(this.modelName);
      case "openai":
        return typeof (openai as any).responses === "function"
          ? (openai as any).responses(this.modelName)
          : openai(this.modelName);
      default:
        return null;
    }
  }

  private getApiKey(): string | undefined {
    switch (this.provider) {
      case "anthropic":
        return process.env.ANTHROPIC_API_KEY;
      case "google":
        return (
          process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
          process.env.GEMINI_API_KEY
        );
      case "openai":
        return process.env.OPENAI_API_KEY;
      default:
        return undefined;
    }
  }

  private logInitializationStatus(): void {
    if (this.model) {
      console.log(
        `✅ LLM Client initialized with ${this.provider} provider using model: ${this.modelName}`
      );
    } else {
      const keyName =
        this.provider === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : this.provider === "google"
            ? "GOOGLE_GENERATIVE_AI_API_KEY"
            : "OPENAI_API_KEY";
      console.error(
        `❌ LLM Client initialization failed: ${keyName} not found in environment variables.\n` +
          `Please add your API key to the .env file in the project root.`
      );
    }
  }

  async sendChatMessage(request: ChatRequest): Promise<void> {
    try {
      // Abort any in-flight run before starting a new one.
      this.abortActiveRun();
      this.activeRunAbortController = new AbortController();
      this.activeRunMessageId = request.messageId;

      // Get screenshot from active tab if available
      let screenshot: string | null = null;
      if (this.window) {
        const activeTab = this.window.activeTab;
        if (activeTab) {
          try {
            const image = await activeTab.screenshot();
            screenshot = image.toDataURL();
          } catch (error) {
            console.error("Failed to capture screenshot:", error);
          }
        }
      }

      // Build user message content with screenshot first, then text
      const userContent: any[] = [];
      
      // Add screenshot as the first part if available
      if (screenshot) {
        userContent.push({
          type: "image",
          image: screenshot,
        });
      }
      
      // Add text content
      userContent.push({
        type: "text",
        text: request.message,
      });

      // Create user message in CoreMessage format
      const userMessage: CoreMessage = {
        role: "user",
        content: userContent.length === 1 ? request.message : userContent,
      };
      
      this.messages.push(userMessage);

      // Send updated messages to renderer
      this.sendMessagesToRenderer();

      if (!this.model) {
        this.sendErrorMessage(
          request.messageId,
          "LLM service is not configured. Please add your API key to the .env file."
        );
        return;
      }

      const messages = await this.prepareMessagesWithContext(request);
      await this.streamResponse(messages, request.messageId, this.activeRunAbortController.signal);
    } catch (error) {
      if (this.isAbortError(error)) {
        // User-initiated cancellation; do not surface as an error.
        return;
      }
      console.error("Error in LLM request:", error);
      this.handleStreamError(error, request.messageId);
    } finally {
      // Only clear if we are still the active run.
      if (this.activeRunMessageId === request.messageId) {
        this.activeRunAbortController = null;
        this.activeRunMessageId = null;
      }
    }
  }

  abortActiveRun(): void {
    const controller = this.activeRunAbortController;
    const messageId = this.activeRunMessageId;

    if (!controller || controller.signal.aborted) return;

    try {
      controller.abort();
    } catch {
      // ignore
    }

    if (messageId) {
      // Mark streams complete so UI exits loading state.
      this.sendReasoningChunk(messageId, { content: "", isComplete: true });
      this.sendNavigationChunk(messageId, { content: "", isComplete: true });
      this.sendStreamChunk(messageId, { content: "", isComplete: true });
    }

    // If we abort a Gemini Computer Use run mid-step, the model response containing
    // functionCall parts may have been persisted without a corresponding functionResponse.
    // Prune trailing functionCall turns to prevent follow-up INVALID_ARGUMENT errors.
    if (Array.isArray(this.geminiComputerUseContents)) {
      this.geminiComputerUseContents = this.pruneDanglingGeminiFunctionCalls(this.geminiComputerUseContents);
    }
  }

  private isAbortError(error: unknown): boolean {
    if (!error) return false;
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return msg === "aborted" || msg.includes("abort") || msg.includes("aborted");
    }
    const str = String(error).toLowerCase();
    return str.includes("abort") || str.includes("aborted");
  }

  private pruneDanglingGeminiFunctionCalls(contents: any[]): any[] {
    if (!Array.isArray(contents)) return [];
    const out = contents.slice();

    const hasFunctionCall = (content: any): boolean => {
      const parts = content && typeof content === "object" ? (content as any).parts : null;
      if (!Array.isArray(parts)) return false;
      return parts.some((p: any) => {
        if (!p || typeof p !== "object") return false;
        return Boolean((p as any).functionCall || (p as any).function_call);
      });
    };

    // Remove any trailing model turns containing function calls.
    while (out.length > 0) {
      const last = out[out.length - 1];
      const role = last && typeof last === "object" ? (last as any).role : null;
      if (role === "model" && hasFunctionCall(last)) {
        out.pop();
        continue;
      }
      break;
    }

    return out;
  }

  clearMessages(): void {
    this.messages = [];
    this.geminiComputerUseContents = null;
    this.sendMessagesToRenderer();
  }

  getMessages(): CoreMessage[] {
    return this.messages;
  }

  private sendMessagesToRenderer(): void {
    this.webContents.send("chat-messages-updated", this.messages);
  }

  private async prepareMessagesWithContext(_request: ChatRequest): Promise<CoreMessage[]> {
    // Get page context from active tab
    let pageUrl: string | null = null;
    let pageText: string | null = null;
    
    if (this.window) {
      const activeTab = this.window.activeTab;
      if (activeTab) {
        pageUrl = activeTab.url;
        try {
          pageText = await activeTab.getTabText();
        } catch (error) {
          console.error("Failed to get page text:", error);
        }
      }
    }

    // Build system message
    const systemMessage: CoreMessage = {
      role: "system",
      content: this.buildSystemPrompt(pageUrl, pageText),
    };

    // Include all messages in history (system + conversation)
    return [systemMessage, ...this.messages];
  }

  private buildSystemPrompt(url: string | null, pageText: string | null): string {
    const parts: string[] = [
      "You are a helpful AI assistant integrated into a web browser.",
      "You can analyze and discuss web pages with the user.",
      "The user's messages may include screenshots of the current page as the first image.",
    ];

    if (url) {
      parts.push(`\nCurrent page URL: ${url}`);
    }

    if (pageText) {
      const truncatedText = this.truncateText(pageText, MAX_CONTEXT_LENGTH);
      parts.push(`\nPage content (text):\n${truncatedText}`);
    }

    parts.push(
      "\nPlease provide helpful, accurate, and contextual responses about the current webpage.",
      "If the user asks about specific content, refer to the page content and/or screenshot provided."
    );

    return parts.join("\n");
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + "...";
  }

  private isGeminiComputerUseModel(): boolean {
    return (
      this.provider === "google" &&
      typeof this.modelName === "string" &&
      this.modelName.toLowerCase().startsWith(GEMINI_COMPUTER_USE_MODEL_PREFIX)
    );
  }

  private denormalizeCoord(value: unknown, max: number): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(max, Math.round((n / 1000) * max)));
  }

  private async getActiveTabOrThrow() {
    const tab = this.getTabByIdOrActive(null);
    if (!tab) throw new Error("No active tab available");
    return tab;
  }

  private isValidPngBase64(data: string): boolean {
    if (typeof data !== "string" || data.length < 64) return false;
    let buf: Buffer;
    try {
      buf = Buffer.from(data, "base64");
    } catch {
      return false;
    }

    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (buf.length < 16) return false;
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < sig.length; i++) {
      if (buf[i] !== sig[i]) return false;
    }

    // Avoid tiny/empty frames.
    if (buf.length < 1024) return false;

    return true;
  }

  private isGeminiInputImageError(error: unknown): boolean {
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error ?? "");
    return msg.toLowerCase().includes("unable to process input image");
  }

  private async captureActiveTabPngBase64(): Promise<{ data: string; width: number; height: number }> {
    const maxAttempts = 3;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const tab = await this.getActiveTabOrThrow();
        const image = await tab.screenshot();
        const size = image.getSize();
        const width = typeof size?.width === "number" ? size.width : DEFAULT_COMPUTER_USE_SCREEN_WIDTH;
        const height = typeof size?.height === "number" ? size.height : DEFAULT_COMPUTER_USE_SCREEN_HEIGHT;

        const maxW = DEFAULT_COMPUTER_USE_SCREEN_WIDTH;
        const maxH = DEFAULT_COMPUTER_USE_SCREEN_HEIGHT;
        const scale = Math.min(1, maxW / Math.max(1, width), maxH / Math.max(1, height));

        const capped =
          scale < 1
            ? image.resize({
                width: Math.max(1, Math.round(width * scale)),
                height: Math.max(1, Math.round(height * scale)),
                quality: "best",
              })
            : image;

        const cappedSize = capped.getSize();
        const cappedWidth =
          typeof cappedSize?.width === "number" ? cappedSize.width : Math.min(width, maxW);
        const cappedHeight =
          typeof cappedSize?.height === "number" ? cappedSize.height : Math.min(height, maxH);

        const png = capped.toPNG();
        const data = png.toString("base64");

        if (!this.isValidPngBase64(data)) {
          throw new Error("Invalid screenshot PNG data");
        }

        return { data, width: cappedWidth, height: cappedHeight };
      } catch (e) {
        lastError = e;
        // Small backoff to allow the page/frame to settle (esp. after navigation).
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 150 * attempt));
        }
      }
    }

    const extra = lastError instanceof Error ? lastError.message : String(lastError ?? "");
    throw new Error(
      `Unable to capture a valid page screenshot. Please try again. (${extra || "unknown error"})`
    );
  }

  private async executeComputerUseAction(action: {
    name: string;
    args?: Record<string, any>;
  }): Promise<{ name: string; response: any }> {
    const tab = await this.getActiveTabOrThrow();
    const args = action.args ?? {};

    // Ensure the tab is focused so keyboard/mouse events go to the page.
    try {
      tab.webContents.focus();
    } catch {
      // ignore
    }

    const screen = await tab.runJs(
      "(() => ({ w: window.innerWidth || 1440, h: window.innerHeight || 900 }))()"
    );
    const w = typeof screen?.w === "number" ? screen.w : DEFAULT_COMPUTER_USE_SCREEN_WIDTH;
    const h = typeof screen?.h === "number" ? screen.h : DEFAULT_COMPUTER_USE_SCREEN_HEIGHT;

    const x = this.denormalizeCoord(args.x, w);
    let y = this.denormalizeCoord(args.y, h);
    const destX = this.denormalizeCoord(args.destination_x, w);
    let destY = this.denormalizeCoord(args.destination_y, h);

    const ensureSafeBottomMargin = async (inputY: number): Promise<{ y: number; scrolledBy: number }> => {
      const safeBottomPx = 160;
      const threshold = h - safeBottomPx;
      if (!Number.isFinite(inputY) || inputY <= threshold) return { y: inputY, scrolledBy: 0 };

      const desired = Math.max(0, Math.round(inputY - threshold));
      if (desired <= 0) return { y: inputY, scrolledBy: 0 };

      const scrolledBy = await tab.runJs(
        `(() => {
          const before = window.scrollY || 0;
          try {
            window.scrollBy({ top: ${desired}, left: 0, behavior: 'instant' });
          } catch {
            window.scrollBy(0, ${desired});
          }
          const after = window.scrollY || 0;
          return after - before;
        })()`
      );

      const actual = typeof scrolledBy === "number" ? scrolledBy : Number(scrolledBy);
      const applied = Number.isFinite(actual) ? actual : 0;
      return { y: Math.max(0, inputY - applied), scrolledBy: applied };
    };

    const sendKey = (keyCode: string, modifiers?: Array<"shift" | "control" | "alt" | "meta">) => {
      tab.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      tab.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    };

    const sendCharText = (text: string) => {
      for (const ch of text) {
        tab.webContents.sendInputEvent({ type: "char", keyCode: ch });
      }
    };

    try {
      switch (action.name) {
        case "open_web_browser": {
          return { name: action.name, response: { ok: true, url: tab.url } };
        }
        case "search": {
          // Use the browser's default search/homepage behavior.
          // In Blueberry this is currently the same default used for new tabs and address-bar search.
          const url = "https://www.google.com";
          await tab.loadURL(url);
          return { name: action.name, response: { ok: true, url } };
        }
        case "navigate": {
          const rawUrl = (args as any).url;
          const url =
            typeof rawUrl === "string"
              ? rawUrl
              : rawUrl && typeof rawUrl === "object" && typeof rawUrl.value === "string"
                ? rawUrl.value
                : rawUrl && typeof rawUrl === "object" && typeof rawUrl.url === "string"
                  ? rawUrl.url
                  : "";
          if (!url)
            return {
              name: action.name,
              response: { ok: false, error: "Missing url", url: tab.url },
            };
          await tab.loadURL(url);
          return { name: action.name, response: { ok: true, url } };
        }
        case "go_back": {
          tab.goBack();
          return { name: action.name, response: { ok: true, url: tab.url } };
        }
        case "go_forward": {
          tab.goForward();
          return { name: action.name, response: { ok: true, url: tab.url } };
        }
        case "wait_5_seconds": {
          await new Promise((r) => setTimeout(r, 5000));
          return { name: action.name, response: { ok: true, url: tab.url } };
        }
        case "click_at":
        case "hover_at": {
          const adjusted = await ensureSafeBottomMargin(y);
          y = adjusted.y;

          if (action.name === "hover_at") {
            if (this.activeGeminiComputerUseRunId) {
              await this.sendOverlayEvent({
                type: "pointer",
                runId: this.activeGeminiComputerUseRunId,
                mode: "pointer",
                x,
                y,
              });
              await this.startHighlightTracking(tab, x, y);
            }
            tab.webContents.sendInputEvent({ type: "mouseMove", x, y });
            return { name: action.name, response: { ok: true, x, y, type: "mousemove", url: tab.url } };
          }

          tab.webContents.sendInputEvent({ type: "mouseMove", x, y });
          tab.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
          tab.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
          if (this.activeGeminiComputerUseRunId) {
            await this.sendOverlayEvent({
              type: "pointer",
              runId: this.activeGeminiComputerUseRunId,
              mode: "pointer",
              x,
              y,
            });
            await this.startHighlightTracking(tab, x, y);
          }
          return { name: action.name, response: { ok: true, x, y, type: "click", url: tab.url } };
        }

        case "type_text_at": {
          const text = typeof args.text === "string" ? args.text : "";
          const pressEnter = Boolean(args.press_enter);
          const clearBefore =
            typeof args.clear_before_typing === "boolean" ? args.clear_before_typing : false;

          const adjusted = await ensureSafeBottomMargin(y);
          y = adjusted.y;

          if (this.activeGeminiComputerUseRunId) {
            await this.sendOverlayEvent({
              type: "pointer",
              runId: this.activeGeminiComputerUseRunId,
              mode: "text",
              x,
              y,
            });
            await this.startHighlightTracking(tab, x, y);
          }

          // Focus the element by clicking, then type using real input events.
          tab.webContents.sendInputEvent({ type: "mouseMove", x, y });
          // Many complex apps (e.g. Google Sheets) require a double-click to enter edit mode.
          tab.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 2 });
          tab.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 2 });
          await new Promise((r) => setTimeout(r, 120));

          if (clearBefore) {
            const isMac = process.platform === "darwin";
            const mod: Array<"shift" | "control" | "alt" | "meta"> = isMac ? ["meta"] : ["control"];
            // Select all
            sendKey("A", mod);
            // Delete
            sendKey("Backspace");
            await new Promise((r) => setTimeout(r, 60));
          }

          if (text.length > 0) {
            // Prefer insertText when available (more reliable for webapps).
            const wcAny = tab.webContents as any;
            if (typeof wcAny.insertText === "function") {
              wcAny.insertText(text);
            } else {
              sendCharText(text);
            }
          }

          if (pressEnter) {
            sendKey("Enter");
          }

          return { name: action.name, response: { ok: true, x, y, url: tab.url } };
        }

        case "scroll_document": {
          const direction = typeof args.direction === "string" ? args.direction : "down";
          const centerX = Math.round(w / 2);
          const centerY = Math.round(h / 2);

          let dx = 0;
          let dy = 0;
          if (direction === "left" || direction === "right") {
            // Flip so Gemini's "right" scrolls right and "left" scrolls left.
            dx = direction === "left" ? Math.round(w * 0.75) : -Math.round(w * 0.75);
          } else {
            // Electron's mouseWheel deltaY is inverted vs DOM wheel in some contexts.
            // Flip so Gemini's "down" scrolls down and "up" scrolls up.
            dy = direction === "up" ? Math.round(h * 0.75) : -Math.round(h * 0.75);
          }

          const wheelTicksX = Math.max(-10, Math.min(10, Math.round(dx / 120)));
          const wheelTicksY = Math.max(-10, Math.min(10, Math.round(dy / 120)));
          tab.webContents.sendInputEvent({ type: "mouseMove", x: centerX, y: centerY });
          tab.webContents.sendInputEvent({
            type: "mouseWheel",
            x: centerX,
            y: centerY,
            deltaX: dx,
            deltaY: dy,
            wheelTicksX,
            wheelTicksY,
          } as any);
          await new Promise((r) => setTimeout(r, 150));
          return { name: action.name, response: { ok: true, direction, url: tab.url } };
        }

        case "scroll_at": {
          const direction = typeof args.direction === "string" ? args.direction : "down";
          const magnitude = typeof args.magnitude === "number" ? args.magnitude : 400;
          let dx = 0;
          let dy = 0;
          if (direction === "left" || direction === "right") {
            dx = direction === "left" ? Math.abs(magnitude) : -Math.abs(magnitude);
          } else {
            dy = direction === "up" ? Math.abs(magnitude) : -Math.abs(magnitude);
          }

          const wheelTicksX = Math.max(-10, Math.min(10, Math.round(dx / 120)));
          const wheelTicksY = Math.max(-10, Math.min(10, Math.round(dy / 120)));
          tab.webContents.sendInputEvent({ type: "mouseMove", x, y });
          tab.webContents.sendInputEvent({
            type: "mouseWheel",
            x,
            y,
            deltaX: dx,
            deltaY: dy,
            wheelTicksX,
            wheelTicksY,
          } as any);
          await new Promise((r) => setTimeout(r, 150));
          return {
            name: action.name,
            response: { ok: true, direction, magnitude, url: tab.url },
          };
        }

        case "key_combination": {
          const keys = typeof args.keys === "string" ? args.keys : "";
          const parts = keys
            .split("+")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          const rawKey = parts[parts.length - 1] ?? "";

          const keyMap: Record<string, string> = {
            enter: "Enter",
            return: "Enter",
            tab: "Tab",
            esc: "Escape",
            escape: "Escape",
            backspace: "Backspace",
            delete: "Delete",
            del: "Delete",
            space: "Space",
            spacebar: "Space",
            arrowup: "Up",
            up: "Up",
            arrowdown: "Down",
            down: "Down",
            arrowleft: "Left",
            left: "Left",
            arrowright: "Right",
            right: "Right",
            home: "Home",
            end: "End",
            pageup: "PageUp",
            pagedown: "PageDown",
          };

          const key = keyMap[rawKey] ?? (rawKey.length === 1 ? rawKey.toUpperCase() : rawKey);
          const modifiers: Array<"shift" | "control" | "alt" | "meta"> = [];
          if (parts.includes("control") || parts.includes("ctrl")) modifiers.push("control");
          if (parts.includes("meta") || parts.includes("command") || parts.includes("cmd")) modifiers.push("meta");
          if (parts.includes("shift")) modifiers.push("shift");
          if (parts.includes("alt")) modifiers.push("alt");
          sendKey(key.length > 0 ? key : "Unidentified", modifiers);
          return { name: action.name, response: { ok: true, keys, url: tab.url } };
        }

        case "drag_and_drop": {
          const adjustedFrom = await ensureSafeBottomMargin(y);
          y = adjustedFrom.y;
          const adjustedTo = await ensureSafeBottomMargin(destY);
          destY = adjustedTo.y;

          tab.webContents.sendInputEvent({ type: "mouseMove", x, y });
          tab.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
          tab.webContents.sendInputEvent({ type: "mouseMove", x: destX, y: destY });
          tab.webContents.sendInputEvent({ type: "mouseUp", x: destX, y: destY, button: "left", clickCount: 1 });

          if (this.activeGeminiComputerUseRunId) {
            await this.sendOverlayEvent({
              type: "pointer",
              runId: this.activeGeminiComputerUseRunId,
              mode: "pointer",
              x: destX,
              y: destY,
            });
            await this.startHighlightTracking(tab, destX, destY);
          }
          return {
            name: action.name,
            response: { ok: true, x, y, destination_x: destX, destination_y: destY, url: tab.url },
          };
        }
        default: {
          return { name: action.name, response: { ok: false, error: `Unsupported action ${action.name}` } };
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e ?? "");
      return { name: action.name, response: { ok: false, error: message, url: tab.url } };
    }
  }

  private async geminiComputerUseLoop(params: {
    messageId: string;
    userPrompt: string;
    systemInstruction: string;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error("Google Generative AI API key is missing.");
    }

    const maxStepsRaw = process.env.AI_COMPUTER_USE_MAX_STEPS;
    const maxSteps = Number.isFinite(Number(maxStepsRaw))
      ? Math.max(1, Math.min(50, Number(maxStepsRaw)))
      : 15;

    let messageIndex: number | null = null;
    let resetAssistantOnNextDelta = false;
    let sentAnyNavigationDelta = false;
    let overlayStarted = false;
    let overlayStartPromise: Promise<void> | null = null;

    if (params.abortSignal?.aborted) {
      return;
    }

    const ensureAssistantMessage = (): number => {
      if (messageIndex !== null) return messageIndex;
      messageIndex = this.messages.length;
      this.messages.push({ role: "assistant", content: "" });
      this.sendMessagesToRenderer();
      return messageIndex;
    };

    const agent = new GeminiComputerUseAgent(apiKey);

    if (!Array.isArray(this.geminiComputerUseContents)) {
      this.geminiComputerUseContents = [];
    }

    this.geminiComputerUseContents = this.normalizeGeminiContents(this.geminiComputerUseContents);
    this.geminiComputerUseContents = this.sanitizeGeminiComputerUseContents(this.geminiComputerUseContents);

    // Append the new user turn (text + current screenshot) to the persistent CU history.
    const userShot = await this.captureActiveTabPngBase64();
    this.geminiComputerUseContents.push({
      role: "user",
      parts: [
        { text: params.userPrompt },
        {
          inlineData: {
            mimeType: "image/png",
            data: userShot.data,
          },
        },
      ],
    });

    this.activeGeminiComputerUseRunId = params.messageId;
    this.geminiComputerUseNavigationOverlayBuffer = "";

    const ensureOverlayStarted = (): Promise<void> => {
      if (overlayStarted) return overlayStartPromise ?? Promise.resolve();
      overlayStarted = true;
      overlayStartPromise = this.sendOverlayEvent({ type: "start", runId: params.messageId }).catch(
        () => undefined
      );
      return overlayStartPromise;
    };

    try {
      await agent.run({
        model: this.modelName,
        userPrompt: params.userPrompt,
        systemInstruction: params.systemInstruction,
        maxSteps,
        excludedPredefinedFunctions: ["open_web_browser"],
        existingContents: this.geminiComputerUseContents,
        skipInitialUserTurn: true,
        abortSignal: params.abortSignal,
        callbacks: {
          captureScreenshot: async () => await this.captureActiveTabPngBase64(),
          executeAction: async (action) => {
            if (params.abortSignal?.aborted) {
              throw new Error("aborted");
            }
            resetAssistantOnNextDelta = true;

            // Start the overlay as soon as we know the run is truly using tools.
            // (If we wait until later, early overlay log events can be dropped.)
            await ensureOverlayStarted();

            const tab = await this.getActiveTabOrThrow();
            const currentUrl = tab.url;
            const executed = await this.executeComputerUseAction(action);
            if (params.abortSignal?.aborted) {
              throw new Error("aborted");
            }
            return {
              name: executed.name,
              response: {
                url: currentUrl,
                ...(executed.response ?? {}),
              },
            };
          },
          onAssistantDelta: (delta) => {
            if (params.abortSignal?.aborted) return;
            if (!delta) return;
            const idx = ensureAssistantMessage();
            const current =
              typeof this.messages[idx]?.content === "string"
                ? (this.messages[idx].content as string)
                : "";

            if (resetAssistantOnNextDelta) {
              resetAssistantOnNextDelta = false;
              this.messages[idx] = { role: "assistant", content: delta };
            } else {
              this.messages[idx] = { role: "assistant", content: current + delta };
            }
            this.sendMessagesToRenderer();
            this.sendStreamChunk(params.messageId, { content: delta, isComplete: false });
          },
          onReasoningDelta: (delta) => {
            if (params.abortSignal?.aborted) return;
            if (!delta) return;
            this.sendReasoningChunk(params.messageId, { content: delta, isComplete: false });
          },
          onNavigationDelta: (delta) => {
            if (params.abortSignal?.aborted) return;
            if (!delta) return;
            sentAnyNavigationDelta = true;
            this.sendNavigationChunk(params.messageId, { content: delta, isComplete: false });
            if (this.activeGeminiComputerUseRunId) {
              // Start overlay on the first navigation delta (which only happens after first tool call)
              // so log events don't get ignored due to missing runId.
              ensureOverlayStarted()
                .then(() => {
                  const pretty = this.formatComputerUseNavigationForOverlay(delta);
                  for (const line of pretty) {
                    this.sendOverlayEvent({ type: "log", runId: params.messageId, text: line }).catch(
                      () => undefined
                    );
                  }
                })
                .catch(() => undefined);
            }
          },
          onLog: this.debugStream
            ? (event) => {
                try {
                  console.log("[GEMINI_CU]", event);
                } catch {
                  // ignore
                }
              }
            : undefined,
        },
      });
    } catch (e) {
      // Treat abort as a normal cancel. Also prune any dangling functionCall turns.
      if (params.abortSignal?.aborted || this.isAbortError(e)) {
        if (Array.isArray(this.geminiComputerUseContents)) {
          this.geminiComputerUseContents = this.pruneDanglingGeminiFunctionCalls(this.geminiComputerUseContents);
        }
        return;
      }
      throw e;
    } finally {
      try {
        if (this.activeGeminiComputerUseRunId && overlayStarted) {
          await this.clearHighlight(params.messageId);
          this.stopHighlightTracking();
          await this.sendOverlayEvent({ type: "end", runId: params.messageId });
        }
      } catch {
        // ignore
      }
      this.activeGeminiComputerUseRunId = null;
    }

    this.sendReasoningChunk(params.messageId, { content: "", isComplete: true });
    if (sentAnyNavigationDelta) {
      this.sendNavigationChunk(params.messageId, { content: "", isComplete: true });
    }
    this.sendStreamChunk(params.messageId, { content: "", isComplete: true });
  }

  private async streamResponse(
    messages: CoreMessage[],
    messageId: string,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (this.isGeminiComputerUseModel()) {
      const userMessage = messages
        .slice()
        .reverse()
        .find((m) => m.role === "user");

      const userPrompt =
        userMessage && typeof userMessage.content === "string"
          ? userMessage.content
          : Array.isArray(userMessage?.content)
            ? userMessage.content
                .map((p: any) => (p && typeof p.text === "string" ? p.text : ""))
                .join("\n")
            : "";

      const tab = await this.getActiveTabOrThrow();
      let pageText: string | null = null;
      try {
        pageText = await tab.getTabText();
      } catch {
        pageText = null;
      }

      const systemInstruction = this.buildSystemPrompt(tab.url, pageText);

      await this.geminiComputerUseLoop({
        messageId,
        userPrompt: userPrompt || "",
        systemInstruction,
        abortSignal,
      });
      return;
    }

    const model = this.model;
    if (!model) {
      throw new Error("Model not initialized");
    }

    try {
      const temperatureEnabled =
        process.env.AI_TEMPERATURE_ENABLED === "true" ||
        process.env.AI_TEMPERATURE_ENABLED === "1";

      const envReasoningSummary = process.env.AI_REASONING_SUMMARY;

      const reasoningSummary =
        typeof envReasoningSummary === "string" && envReasoningSummary.length > 0
          ? envReasoningSummary
          : undefined;

      const envReasoningEffort = process.env.AI_REASONING_EFFORT;
      const reasoningEffort:
        | "none"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | undefined =
        envReasoningEffort === "none" ||
        envReasoningEffort === "minimal" ||
        envReasoningEffort === "low" ||
        envReasoningEffort === "medium" ||
        envReasoningEffort === "high" ||
        envReasoningEffort === "xhigh"
          ? envReasoningEffort
          : undefined;

      const reasoningSummaryValue: "auto" | "detailed" | undefined =
        reasoningSummary === "auto" || reasoningSummary === "detailed"
          ? reasoningSummary
          : undefined;

      const shouldRequestReasoningSummary =
        this.provider === "openai" && typeof reasoningSummaryValue === "string";

      const requestReasoningSummary =
        shouldRequestReasoningSummary && !this.openaiReasoningSummaryUnsupported;

      if (requestReasoningSummary) {
        console.log(
          `[AI_SDK] requesting OpenAI reasoningSummary=${reasoningSummary} for model=${this.modelName}`
        );
      }

      const run = async (opts: { includeProviderReasoningSummary: boolean }) => {
        const providerOptions =
          opts.includeProviderReasoningSummary && reasoningSummaryValue
            ? {
                openai: {
                  reasoningSummary: reasoningSummaryValue,
                  ...(reasoningEffort
                    ? { reasoningEffort }
                    : { reasoningEffort: "high" as const }),
                },
              }
            : undefined;

        const tools = this.getTools() as any;

        const result = await streamText({
          model,
          messages,
          tools,
          ...(temperatureEnabled ? { temperature: DEFAULT_TEMPERATURE } : {}),
          ...(providerOptions ? { providerOptions } : {}),
          maxRetries: 3,
          abortSignal,
        });

        await this.processFullStream(result.fullStream, messageId, {
          shouldRequestReasoningSummary: opts.includeProviderReasoningSummary,
          reasoningSummary:
            opts.includeProviderReasoningSummary && reasoningSummaryValue
              ? reasoningSummaryValue
              : null,
        });
      };

      try {
        await run({ includeProviderReasoningSummary: requestReasoningSummary });
      } catch (error) {
        if (abortSignal?.aborted) {
          return;
        }
        const errorMessage =
          error instanceof Error ? error.message : String(error ?? "");

        const anyError = error as any;
        const errorParam: unknown =
          anyError?.data?.error?.param ??
          anyError?.cause?.data?.error?.param ??
          anyError?.responseBody?.error?.param;
        const errorCode: unknown =
          anyError?.data?.error?.code ??
          anyError?.cause?.data?.error?.code ??
          anyError?.responseBody?.error?.code;
        const statusCode: unknown = anyError?.statusCode ?? anyError?.cause?.statusCode;

        const isReasoningSummaryParam =
          typeof errorParam === "string" && errorParam === "reasoning.summary";
        const isUnsupportedValue =
          typeof errorCode === "string" && errorCode === "unsupported_value";
        const isBadRequest = statusCode === 400;

        const looksLikeOrgVerificationGate =
          this.provider === "openai" &&
          requestReasoningSummary &&
          (isReasoningSummaryParam || isUnsupportedValue || isBadRequest) &&
          (errorMessage
            .toLowerCase()
            .includes("organization must be verified") ||
            isReasoningSummaryParam ||
            isUnsupportedValue);

        if (looksLikeOrgVerificationGate) {
          this.openaiReasoningSummaryUnsupported = true;
          console.warn(
            "[AI_SDK] OpenAI reasoning summaries are not available (org not verified). Falling back to text-only response."
          );

          await run({ includeProviderReasoningSummary: false });
          return;
        }

        throw error;
      }
    } catch (error) {
      throw error; // Re-throw to be handled by the caller
    }
  }

  private async processFullStream(
    fullStream: AsyncIterable<any>,
    messageId: string,
    debugContext?: {
      shouldRequestReasoningSummary: boolean;
      reasoningSummary: string | null;
    }
  ): Promise<void> {
    let accumulatedText = "";
    let accumulatedReasoning = "";
    let receivedAnyReasoning = false;
    let sentReasoningComplete = false;
    const typeCounts: Record<string, number> = {};

    // Create a placeholder assistant message
    const assistantMessage: CoreMessage = {
      role: "assistant",
      content: "",
    };

    // Keep track of the index for updates
    const messageIndex = this.messages.length;
    this.messages.push(assistantMessage);

    for await (const part of fullStream) {
      const partType =
        part && typeof part === "object" && typeof part.type === "string"
          ? part.type
          : typeof part;
      typeCounts[partType] = (typeCounts[partType] ?? 0) + 1;

      if (this.debugStream) {
        try {
          const safePart =
            part && typeof part === "object"
              ? {
                  type: part.type,
                  keys: Object.keys(part),
                }
              : { type: typeof part };
          console.log("[AI_SDK fullStream part]", safePart);
        } catch {
          // ignore debug logging errors
        }
      }

      switch (part.type) {
        case "reasoning-start": {
          if (this.debugStream) {
            try {
              console.log("[AI_SDK reasoning-start]", part);
            } catch {
              // ignore debug logging errors
            }
          }
          break;
        }

        case "tool-call": {
          if (this.debugStream) {
            try {
              console.log("[AI_SDK tool-call]", part);
            } catch {
              // ignore debug logging errors
            }
          }
          break;
        }

        case "tool-result": {
          if (this.debugStream) {
            try {
              console.log("[AI_SDK tool-result]", part);
            } catch {
              // ignore debug logging errors
            }
          }
          break;
        }

        case "reasoning": {
          // GPT-5 reasoning summaries are streamed as `reasoning` parts.
          const delta =
            typeof part.textDelta === "string"
              ? part.textDelta
              : typeof part.text === "string"
                ? part.text
                : "";

          if (!delta) break;

          receivedAnyReasoning = true;
          accumulatedReasoning += delta;

          if (this.debugStream) {
            console.log("[AI_SDK reasoning delta]", delta);
          }

          this.sendReasoningChunk(messageId, {
            content: delta,
            isComplete: false,
          });
          break;
        }

        case "reasoning-end": {
          if (this.debugStream) {
            try {
              console.log("[AI_SDK reasoning-end]", part);
            } catch {
              // ignore debug logging errors
            }
          }

          // Mark reasoning complete as soon as the provider indicates it.
          // This allows the UI to auto-collapse reasoning while the assistant text may
          // still be streaming.
          if (!sentReasoningComplete) {
            this.sendReasoningChunk(messageId, {
              content: "",
              isComplete: true,
            });
            sentReasoningComplete = true;
          }
          break;
        }

        case "text-delta": {
          const delta =
            typeof part.textDelta === "string"
              ? part.textDelta
              : typeof part.text === "string"
                ? part.text
                : "";

          if (!delta) break;

          accumulatedText += delta;

          if (this.debugStream) {
            console.log("[AI_SDK text delta]", delta);
          }

          this.messages[messageIndex] = {
            role: "assistant",
            content: accumulatedText,
          };
          this.sendMessagesToRenderer();

          this.sendStreamChunk(messageId, {
            content: delta,
            isComplete: false,
          });
          break;
        }

        case "reasoning-delta": {
          const delta =
            typeof part.textDelta === "string"
              ? part.textDelta
              : typeof part.text === "string"
                ? part.text
                : typeof part.reasoningDelta === "string"
                  ? part.reasoningDelta
                  : typeof part.reasoning === "string"
                    ? part.reasoning
                    : typeof part.reasoningText === "string"
                      ? part.reasoningText
                      : "";

          if (!delta) break;

          receivedAnyReasoning = true;
          accumulatedReasoning += delta;

          if (this.debugStream) {
            console.log("[AI_SDK reasoning-delta]", delta);
          }

          this.sendReasoningChunk(messageId, {
            content: delta,
            isComplete: false,
          });
          break;
        }

        case "finish-step": {
          if (
            this.debugStream &&
            debugContext?.shouldRequestReasoningSummary &&
            !receivedAnyReasoning &&
            part &&
            typeof part === "object"
          ) {
            try {
              console.log(
                "[AI_SDK finish-step providerMetadata]",
                (part as any).providerMetadata
              );
            } catch {
              // ignore debug logging errors
            }
          }
          break;
        }

        case "error": {
          const errorText =
            typeof part.error === "string"
              ? part.error
              : part.error instanceof Error
                ? part.error.message
                : "An error occurred while streaming.";
          this.sendErrorMessage(messageId, errorText);
          break;
        }

        case "finish": {
          // Final update with complete content
          this.messages[messageIndex] = {
            role: "assistant",
            content: accumulatedText,
          };
          this.sendMessagesToRenderer();

          this.sendStreamChunk(messageId, {
            content: accumulatedText,
            isComplete: true,
          });

          // Mark reasoning complete without re-sending the full accumulated reasoning.
          // (The UI appends deltas; sending the full text again would duplicate it.)
          // If we already received a dedicated `reasoning-end` event, don't send another
          // completion signal.
          if (!sentReasoningComplete) {
            if (accumulatedReasoning.length === 0) {
              // Fallback: if provider reasoning summaries are unavailable, try to extract a
              // high-level "Reasoning:" section from the assistant text.
              const match = accumulatedText.match(
                /(?:^|\n)\s*Reasoning\s*\(.*?\)\s*:\s*([\s\S]*?)(?:\n\s*Answer\s*:|$)/i
              );

              if (match && typeof match[1] === "string" && match[1].trim().length > 0) {
                this.sendReasoningChunk(messageId, {
                  content: match[1].trim(),
                  isComplete: true,
                });
              } else {
                this.sendReasoningChunk(messageId, {
                  content: "",
                  isComplete: true,
                });
              }
            } else {
              this.sendReasoningChunk(messageId, {
                content: "",
                isComplete: true,
              });
            }

            sentReasoningComplete = true;
          }

          if (debugContext?.shouldRequestReasoningSummary && !receivedAnyReasoning) {
            console.warn(
              `[AI_SDK] reasoningSummary was requested (${debugContext.reasoningSummary}) but no reasoning stream parts were received. ` +
                `model=${this.modelName} provider=${this.provider} messageId=${messageId} typeCounts=${JSON.stringify(
                  typeCounts
                )}`
            );
          } else if (this.debugStream) {
            console.log(
              `[AI_SDK] stream finished model=${this.modelName} provider=${this.provider} messageId=${messageId} typeCounts=${JSON.stringify(
                typeCounts
              )}`
            );
          }

          break;
        }
      }
    }

    if (this.debugStream) {
      console.log(
        `[AI_SDK] stream ended model=${this.modelName} provider=${this.provider} messageId=${messageId} typeCounts=${JSON.stringify(
          typeCounts
        )}`
      );
    }
  }

  private handleStreamError(error: unknown, messageId: string): void {
    console.error("Error streaming from LLM:", error);

    // If Gemini rejects an image input, clear CU history so we don't get stuck in a loop.
    if (this.isGeminiInputImageError(error)) {
      this.geminiComputerUseContents = [];
    }

    const errorMessage = this.getErrorMessage(error);
    this.sendErrorMessage(messageId, errorMessage);
  }

  private getErrorMessage(error: unknown): string {
    if (!(error instanceof Error)) {
      return "An unexpected error occurred. Please try again.";
    }

    const message = error.message.toLowerCase();

    if (message.includes("unable to process input image")) {
      return "I couldn't process the page screenshot. Please try again (or refresh the page) and retry.";
    }

    if (message.includes("401") || message.includes("unauthorized")) {
      return "Authentication error: Please check your API key in the .env file.";
    }

    if (message.includes("429") || message.includes("rate limit")) {
      return "Rate limit exceeded. Please try again in a few moments.";
    }

    if (
      message.includes("network") ||
      message.includes("fetch") ||
      message.includes("econnrefused")
    ) {
      return "Network error: Please check your internet connection.";
    }

    if (message.includes("timeout")) {
      return "Request timeout: The service took too long to respond. Please try again.";
    }

    return "Sorry, I encountered an error while processing your request. Please try again.";
  }

  private sendErrorMessage(messageId: string, errorMessage: string): void {
    this.sendStreamChunk(messageId, {
      content: errorMessage,
      isComplete: true,
    });

    this.sendReasoningChunk(messageId, {
      content: "",
      isComplete: true,
    });
  }

  private sendStreamChunk(messageId: string, chunk: StreamChunk): void {
    this.webContents.send("chat-response", {
      messageId,
      content: chunk.content ?? "",
      isComplete: chunk.isComplete,
    });
  }

  private sendReasoningChunk(messageId: string, chunk: ReasoningChunk): void {
    this.webContents.send("chat-reasoning", {
      messageId,
      content: chunk.content ?? "",
      isComplete: chunk.isComplete,
    });
  }

  private sendNavigationChunk(messageId: string, chunk: NavigationChunk): void {
    this.webContents.send("chat-navigation", {
      messageId,
      content: chunk.content ?? "",
      isComplete: chunk.isComplete,
    });
  }

  private normalizeGeminiContents(input: any[]): any[] {
    const out: any[] = [];

    for (const item of input) {
      if (!item || typeof item !== "object") continue;

      const roleRaw = (item as any).role;
      const role = typeof roleRaw === "string" ? roleRaw : "user";

      if (Array.isArray((item as any).parts)) {
        out.push({ role, parts: (item as any).parts });
        continue;
      }

      // Convert legacy { role, content } shape into { role, parts }
      const content = (item as any).content;
      if (typeof content === "string" && content.length > 0) {
        out.push({ role, parts: [{ text: content }] });
        continue;
      }

      // Convert legacy CoreMessage-like { role, content: [{type:'text',text}, ...] }
      if (Array.isArray(content)) {
        const parts: any[] = [];
        for (const c of content) {
          if (!c || typeof c !== "object") continue;
          if ((c as any).type === "text" && typeof (c as any).text === "string") {
            parts.push({ text: (c as any).text });
          }
        }
        if (parts.length > 0) {
          out.push({ role, parts });
        }
      }
    }

    return out;
  }

  private sanitizeGeminiComputerUseContents(contents: any[]): any[] {
    try {
      this.assertValidGeminiComputerUseContents(contents);
      return contents;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e ?? "");
      console.error("[GEMINI_CU] Invalid contents history; resetting.", message);
      return [];
    }
  }

  private assertValidGeminiComputerUseContents(contents: any[]): void {
    if (!Array.isArray(contents)) {
      throw new Error("Gemini contents must be an array");
    }

    for (const [idx, item] of contents.entries()) {
      if (!item || typeof item !== "object") {
        throw new Error(`Invalid content at index ${idx}: not an object`);
      }

      const role = (item as any).role;
      if (typeof role !== "string") {
        throw new Error(`Invalid content at index ${idx}: missing role`);
      }

      const parts = (item as any).parts;
      if (!Array.isArray(parts)) {
        throw new Error(`Invalid content at index ${idx}: missing parts[]`);
      }

      // Invariant: for computer-use runs, user turns are either:
      //  - prompt turn: (text part(s)) + optional screenshot
      //  - tool-result turn: (functionResponse part(s)) + optional screenshot
      // but never both in the same Content.
      if (role === "user") {
        let textParts = 0;
        let functionResponseParts = 0;

        for (const p of parts) {
          if (!p || typeof p !== "object") continue;

          if (typeof (p as any).text === "string" && (p as any).text.length > 0) {
            textParts += 1;
          }

          if (typeof (p as any).functionResponse === "object" && (p as any).functionResponse) {
            functionResponseParts += 1;
          }
        }

        if (textParts > 0 && functionResponseParts > 0) {
          throw new Error(
            `Invalid user content at index ${idx}: contains both text and functionResponse parts`
          );
        }
      }
    }
  }

  private formatComputerUseNavigationForOverlay(delta: string): string[] {
    this.geminiComputerUseNavigationOverlayBuffer += delta;
    const parts = this.geminiComputerUseNavigationOverlayBuffer.split(/\r?\n/);
    const completeLines = parts.slice(0, -1);
    this.geminiComputerUseNavigationOverlayBuffer = parts[parts.length - 1] ?? "";

    const prettyLines: string[] = [];

    for (const rawLine of completeLines) {
      const line = rawLine.trim();
      if (!line) continue;

      const cleaned = line.replace(/^Computer Use\s*:\s*/i, "").trim();

      const stepMatch = cleaned.match(/\bstep\s+(\d+)\s*\/\s*(\d+)\b/i);
      if (stepMatch) {
        continue;
      }

      if (/\bdone\b/i.test(cleaned) && /no more actions/i.test(cleaned)) {
        prettyLines.push("Navigation complete");
        continue;
      }

      const jsonStart = cleaned.indexOf("{");
      const actionPart = (jsonStart >= 0 ? cleaned.slice(0, jsonStart) : cleaned).trim();
      const jsonPart = jsonStart >= 0 ? cleaned.slice(jsonStart).trim() : "";

      let parsedArgs: any = null;
      if (jsonPart) {
        try {
          parsedArgs = JSON.parse(jsonPart);
        } catch {
          parsedArgs = null;
        }
      }

      const lowerAction = actionPart.toLowerCase();

      let pretty = "";
      if (lowerAction.includes("type_text")) {
        const text = parsedArgs && typeof parsedArgs.text === "string" ? parsedArgs.text : "";
        const enter = parsedArgs && typeof parsedArgs.enter === "boolean" ? parsedArgs.enter : false;
        const safeText = text.length > 0 ? ` “${text}”` : "";
        pretty = enter ? `Submitting${safeText}` : `Typing${safeText}`;
      } else if (lowerAction.includes("search")) {
        pretty = "Searching";
      } else if (lowerAction.includes("click")) {
        pretty = "Clicking element";
      } else if (lowerAction.includes("scroll")) {
        pretty = "Scrolling";
      } else if (
        lowerAction.includes("navigate") ||
        lowerAction.includes("open_url") ||
        lowerAction.includes("openurl")
      ) {
        pretty = "Opening page";
      } else if (lowerAction.includes("wait")) {
        pretty = "Waiting";
      } else if (lowerAction.includes("key") || lowerAction.includes("keypress")) {
        pretty = "Pressing keys";
      } else {
        pretty = "Continuing";
      }

      prettyLines.push(pretty);
    }

    return prettyLines;
  }
}
