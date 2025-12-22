import { WebContents, dialog } from "electron";
import { streamText, tool, type LanguageModel, type CoreMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { Window } from "./Window";
import { GeminiComputerUseAgent } from "./gemini/GeminiComputerUseAgent";
import { BERRY_DYNAMIC_PROMPT, getBerrySystemPrompt, setBerrySpecialInstructions } from "./gemini/CuPrompt";
import { generateSelfImprovementObject } from "./gemini/SelfImprovement";
import { parseComputerUseNavigationDelta } from "../shared/navigationPretty";
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

  private lastGeminiComputerUseFrameTransform: {
    cropWidthCss: number;
    cropHeightCss: number;
    offsetXCss: number;
    offsetYCss: number;
    viewportWidthCss: number;
    viewportHeightCss: number;
  } | null = null;

  private lastGeminiComputerUseFrameSmall: Buffer | null = null;

  private highlightTrackTimer: NodeJS.Timeout | null = null;
  private highlightTrackUrl: string | null = null;

  private selfImprovementPerSite: Record<string, string[]> = {};
  private selfImprovementInFlightCount = 0;

  private broadcastSelfImprovementLearning(active: boolean): void {
    try {
      const wc = this.window?.topBar?.view?.webContents;
      if (!wc) return;
      wc.send("self-improvement-learning", active);
    } catch {
      // ignore
    }
  }

  private bumpSelfImprovementLearning(delta: number): void {
    const prev = this.selfImprovementInFlightCount;
    const next = Math.max(0, prev + delta);
    this.selfImprovementInFlightCount = next;

    if (prev === 0 && next > 0) {
      this.broadcastSelfImprovementLearning(true);
    } else if (prev > 0 && next === 0) {
      this.broadcastSelfImprovementLearning(false);
    }
  }

  private normalizeSiteKey(raw: unknown): string {
    const input = typeof raw === "string" ? raw.trim() : "";
    if (!input) return "";

    let host = "";
    try {
      if (/^https?:\/\//i.test(input)) {
        host = new URL(input).hostname;
      } else {
        host = input;
      }
    } catch {
      host = input;
    }

    host = host.trim().toLowerCase();

    // If the model returned something like "youtube.com/@foo" or "youtube.com/",
    // keep only the hostname-ish portion.
    host = host.replace(/^[a-z]+:\/\//i, "");
    host = host.split("/")[0] ?? "";

    if (host.startsWith("www.")) host = host.slice(4);
    return host.trim();
  }

  private normalizeInstructionBullets(raw: unknown, limit: number): string[] {
    const arr = Array.isArray(raw) ? raw : [];
    const normalized = arr
      .map((b) => (typeof b === "string" ? b.trim() : ""))
      .filter((b) => b.length > 0)
      .map((b) => (b.startsWith("-") ? b.replace(/^[-\s]+/, "").trim() : b));

    const canonicalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const b of normalized) {
      const key = canonicalize(b);
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(b);
    }

    return deduped.slice(0, Math.max(0, limit));
  }

  private normalizePerSite(raw: unknown): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    if (!raw || typeof raw !== "object") return out;

    for (const [kRaw, vRaw] of Object.entries(raw as Record<string, unknown>)) {
      const key = this.normalizeSiteKey(kRaw);
      if (!key) continue;
      const bullets = this.normalizeInstructionBullets(vRaw, 12);
      if (bullets.length === 0) continue;
      out[key] = bullets;
    }

    const keys = Object.keys(out);
    if (keys.length <= 30) return out;

    const limited: Record<string, string[]> = {};
    for (const k of keys.slice(0, 30)) {
      limited[k] = out[k];
    }
    return limited;
  }

  private mergePerSiteInstructions(
    existing: Record<string, string[]>,
    incoming: Record<string, string[]>
  ): Record<string, string[]> {
    const out: Record<string, string[]> = {};

    // First, keep only valid non-empty existing entries.
    if (existing && typeof existing === "object") {
      for (const [kRaw, vRaw] of Object.entries(existing)) {
        const k = this.normalizeSiteKey(kRaw);
        if (!k) continue;
        const bullets = this.normalizeInstructionBullets(vRaw, 12);
        if (bullets.length === 0) continue;
        out[k] = bullets;
      }
    }

    for (const [kRaw, vRaw] of Object.entries(incoming && typeof incoming === "object" ? incoming : {})) {
      const k = this.normalizeSiteKey(kRaw);
      if (!k) continue;
      const bullets = this.normalizeInstructionBullets(vRaw, 12);
      if (bullets.length === 0) continue;
      out[k] = bullets;
    }

    const keys = Object.keys(out);
    if (keys.length <= 30) return out;

    const limited: Record<string, string[]> = {};
    for (const k of keys.slice(0, 30)) {
      limited[k] = out[k];
    }
    return limited;
  }

  private getCurrentGeneralInstructions(): string[] {
    const lines = typeof BERRY_DYNAMIC_PROMPT === "string" ? BERRY_DYNAMIC_PROMPT.split(/\r?\n/) : [];
    const bullets = lines
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.replace(/^[-\s]+/, "").trim());
    return this.normalizeInstructionBullets(bullets, 20);
  }

  private shouldRunSelfImprovement(): boolean {
    const raw = process.env.AI_SELF_IMPROVEMENT_ENABLED;
    return raw === "1" || raw === "true";
  }

  private formatGeminiCuConversationForSelfImprovement(contents: any[]): string {
    if (!Array.isArray(contents) || contents.length === 0) return "";

    const tail = contents.slice(-12);
    const lines: string[] = [];

    for (const item of tail) {
      const role = item && typeof item.role === "string" ? item.role : "unknown";
      const parts = item && Array.isArray(item.parts) ? item.parts : [];

      const partLines: string[] = [];
      for (const p of parts) {
        if (!p || typeof p !== "object") continue;

        if (typeof (p as any).text === "string" && (p as any).text.trim().length > 0) {
          partLines.push((p as any).text.trim());
          continue;
        }

        const fc =
          typeof (p as any).functionCall === "object"
            ? (p as any).functionCall
            : typeof (p as any).function_call === "object"
              ? (p as any).function_call
              : null;
        if (fc && typeof fc.name === "string") {
          const argsText = typeof fc.args === "object" && fc.args ? JSON.stringify(fc.args) : "{}";
          partLines.push(`[functionCall] ${fc.name} ${argsText}`);
          continue;
        }

        const fr = typeof (p as any).functionResponse === "object" ? (p as any).functionResponse : null;
        if (fr && typeof fr.name === "string") {
          const respText = typeof fr.response === "object" && fr.response ? JSON.stringify(fr.response) : "{}";
          partLines.push(`[functionResponse] ${fr.name} ${respText}`);
          continue;
        }
      }

      if (partLines.length === 0) continue;
      lines.push(`${role.toUpperCase()}: ${partLines.join("\n")}`);
    }

    return this.truncateText(lines.join("\n\n"), 3000);
  }

  private enqueueSelfImprovementFromComputerUseRun(params: {
    messageId: string;
    userPrompt: string;
    assistantText: string;
    navigationTranscript: string;
    executedActions: Array<{ name: string; args: any; url: string | null }>;
    durationMs: number;
    geminiContents?: any[] | null;
  }): void {
    if (!this.shouldRunSelfImprovement()) return;

    const apiKey = this.getApiKey();
    if (!apiKey) return;

    this.bumpSelfImprovementLearning(1);

    void (async () => {
      try {
        const transcriptLines: string[] = [];
        transcriptLines.push(`User: ${params.userPrompt}`);

        const currentState = {
          general: this.getCurrentGeneralInstructions(),
          perSite: this.selfImprovementPerSite,
        };
        transcriptLines.push("\nCURRENT_INSTRUCTIONS_JSON:\n" + JSON.stringify(currentState, null, 2));

        const convo =
          Array.isArray(params.geminiContents) && params.geminiContents.length > 0
            ? this.formatGeminiCuConversationForSelfImprovement(params.geminiContents)
            : "";
        if (convo.trim().length > 0) {
          transcriptLines.push("\nRecent CU conversation (text + tool calls, no images):\n" + convo);
        }

        if (params.navigationTranscript.trim().length > 0) {
          transcriptLines.push("\nNavigation log:\n" + this.truncateText(params.navigationTranscript, 2500));
        }

        if (params.executedActions.length > 0) {
          const actionLines = params.executedActions.slice(0, 60).map((a, idx) => {
            const argsText =
              a && typeof a.args === "object" && a.args
                ? JSON.stringify(a.args)
                : "{}";
            const urlText = typeof a.url === "string" && a.url.length > 0 ? ` @ ${a.url}` : "";
            return `${idx + 1}. ${a.name}${urlText} ${argsText}`;
          });
          transcriptLines.push("\nActions executed:\n" + actionLines.join("\n"));
        }

        if (params.assistantText.trim().length > 0) {
          transcriptLines.push(
            "\nAssistant thoughts/progress + final answer:\n" + this.truncateText(params.assistantText, 3500)
          );
        }

        transcriptLines.push(`\nMetadata: durationMs=${params.durationMs}`);

        const prompt =
          "You are analyzing a browser computer-use agent run. " +
          "Your job is to produce UPDATED navigation instructions that will help the agent perform better in future runs.\n\n" +
          "Focus on:\n" +
          "- Intent capture: how the agent interpreted the user, and how to better capture intent and ambiguity.\n" +
          "- User preferences: infer stable preferences (tone, level of detail, safety, interaction style) and how to satisfy them.\n" +
          "- Navigation: assess the agent's step choices and propose rules to improve accuracy and efficiency.\n\n" +
          "Output rules:\n" +
          "- Return ONLY JSON (no markdown).\n" +
          "- Start from CURRENT instructions: preserve existing and append new ones.\n" +
          "- Remove an existing instruction only if it clearly contradicts a new one.\n" +
          "- Keep rules short, imperative, and avoid coordinates/selectors.\n\n" +
          "Run transcript:\n" +
          transcriptLines.join("\n");

        const modelOverride = process.env.AI_SELF_IMPROVEMENT_MODEL;
        const obj = await generateSelfImprovementObject({
          apiKey,
          model:
            typeof modelOverride === "string" && modelOverride.trim().length > 0
              ? modelOverride.trim()
              : undefined,
          temperature: 0.2,
          prompt,
        });

        const general = this.normalizeInstructionBullets((obj as any)?.general, 20);
        const perSite = this.normalizePerSite((obj as any)?.perSite);
        if (general.length === 0 && Object.keys(perSite).length === 0) return;

        if (general.length > 0) {
          setBerrySpecialInstructions(general);
        }
        this.selfImprovementPerSite = this.mergePerSiteInstructions(this.selfImprovementPerSite, perSite);

        if (this.debugStream) {
          try {
            console.log(
              `[SELF_IMPROVEMENT] updated general=${general.length} perSite=${Object.keys(perSite).length} after run ${params.messageId}`
            );
          } catch {
            // ignore
          }
        }
      } catch (e) {
        if (this.debugStream) {
          try {
            const msg = e instanceof Error ? e.message : String(e ?? "");
            console.warn("[SELF_IMPROVEMENT] failed: " + msg);
          } catch {
            // ignore
          }
        }
      } finally {
        this.bumpSelfImprovementLearning(-1);
      }
    })();
  }

  private shouldLogModelInput(): boolean {
    const raw = process.env.AI_LOG_MODEL_INPUT;
    return raw === "1" || raw === "true";
  }

  private redactCoreMessagesForLogging(messages: CoreMessage[]): any[] {
    const redact = (value: any): any => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(redact);

      // AI SDK image parts: { type: 'image', image: 'data:...' }
      if (value.type === "image") {
        const image = typeof value.image === "string" ? value.image : null;
        return {
          ...value,
          image: image ? `[redacted image dataurl len=${image.length}]` : "[redacted image]",
        };
      }

      const out: any = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === "image" && typeof v === "string") {
          out[k] = `[redacted image dataurl len=${v.length}]`;
          continue;
        }
        out[k] = redact(v);
      }
      return out;
    };

    return messages.map((m) => ({
      role: (m as any).role,
      content: redact((m as any).content),
    }));
  }

  private redactGeminiContentsForLogging(contents: any[]): any[] {
    const redact = (value: any): any => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(redact);

      // Gemini image parts: { inlineData: { mimeType, data } }
      if (value.inlineData && typeof value.inlineData === "object") {
        const data = (value.inlineData as any).data;
        const dataLen = typeof data === "string" ? data.length : 0;
        return {
          ...value,
          inlineData: {
            ...(value.inlineData as any),
            data: dataLen > 0 ? `[redacted base64 len=${dataLen}]` : "[redacted base64]",
          },
        };
      }

      const out: any = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === "data" && typeof v === "string") {
          out[k] = `[redacted base64 len=${v.length}]`;
          continue;
        }
        out[k] = redact(v);
      }
      return out;
    };

    return Array.isArray(contents) ? contents.map(redact) : [];
  }

  private logModelInputNormal(messages: CoreMessage[]): void {
    if (!this.shouldLogModelInput()) return;
    try {
      console.log("[MODEL_INPUT] mode=normal provider=%s model=%s", this.provider, this.modelName);
      console.log(JSON.stringify(this.redactCoreMessagesForLogging(messages), null, 2));
    } catch {
      // ignore
    }
  }

  private logModelInputGeminiComputerUse(params: {
    systemInstruction: string;
    contents: any[];
    maxSteps: number;
    excludedPredefinedFunctions: string[];
  }): void {
    if (!this.shouldLogModelInput()) return;
    try {
      console.log("[MODEL_INPUT] mode=gemini_cu provider=%s model=%s", this.provider, this.modelName);
      console.log(
        JSON.stringify(
          {
            systemInstruction: params.systemInstruction,
            maxSteps: params.maxSteps,
            excludedPredefinedFunctions: params.excludedPredefinedFunctions,
            contents: this.redactGeminiContentsForLogging(params.contents),
          },
          null,
          2
        )
      );
    } catch {
      // ignore
    }
  }

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
        description: "Get the text content of the current page. If tabId is omitted, uses the active tab.",
        inputSchema: z.object({ tabId: z.string().optional() }),
        execute: async ({ tabId }) => {
          const tab = this.getTabByIdOrActive(tabId);
          if (!tab) return { text: "" };
          const text = await tab.getViewportText();
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

      // Gemini Computer Use does not use the normal system-message flow.
      // Build the system instruction once and go straight into the CU loop to avoid
      // calling buildSystemPrompt() twice per interaction.
      if (this.isGeminiComputerUseModel()) {
        const tab = await this.getActiveTabOrThrow();
        let pageText: string | null = null;
        try {
          pageText = await tab.getViewportText();
        } catch (error) {
          console.error("Failed to get viewport text (Gemini CU):", error);
          pageText = null;
        }

        const systemInstruction = this.buildComputerUseSystemInstruction({ url: tab.url, pageText });
        const userPrompt = this.buildComputerUseUserPrompt({
          url: tab.url,
          pageText,
          userMessage: request.message,
        });
        await this.geminiComputerUseLoop({
          messageId: request.messageId,
          userPrompt,
          systemInstruction,
          abortSignal: this.activeRunAbortController.signal,
        });
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
          pageText = await activeTab.getViewportText();
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
      "You are a Berry, a helpful AI assistant integrated into a the Blueberry web browser.",
      "You are able to autnomously navigate the browser and interact with webpages in order to fulfill the user's query when needed.",
      "You have detailed context about the browser that the user might not have.", 
      "The user only sees the webpages as they are. So NEVER mention details like coordinates (x=,y=) on a page, only refer to visual queues available to the user",
      "You think before you answer to understand the user full intent and evaluate if you can answer immediately or need to navigate the web/interact with pages.",
      "When navigation/interaction is necessary you plan your actions.",
      "If an interaction is risky (editing/deleting... on a non public site), if you are unsure or need the user to provide info/interact, alwyas prompt the user to intervene."
    ];

    if (url) {
      parts.push(`\nCurrent page URL: ${url}`);
    }

    if (pageText) {
      const truncatedText = this.truncateText(pageText, MAX_CONTEXT_LENGTH);
      parts.push(`\nPage text content (in viewport):\n${truncatedText}`);
    }

    parts.push(
      "\nPlease provide helpful, accurate responses. Use emojis only to emphasize/illustrate key concepts/words. Always evaluate/verify that you've accomplished the expected result when navigating.",

    );

    if (this.shouldLogModelInput()) {
      try {
        console.log("[SYSTEM_PROMPT]" + "\n" + parts.join("\n"));
      } catch {
        // ignore
      }
    }
    return parts.join("\n");
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + "...";
  }

  private buildComputerUseUserPrompt(params: {
    url: string | null;
    pageText: string | null;
    userMessage: string;
  }): string {
    return params.userMessage;
  }

  private buildComputerUseSystemInstruction(params: {
    url: string | null;
    pageText: string | null;
  }): string {
    return this.getBerrySystemInstructionWithPageContext(params);
  }

  private getBerrySystemInstructionWithPageContext(params: {
    url: string | null;
    pageText: string | null;
  }): string {
    const base = getBerrySystemPrompt();
    const parts: string[] = [];

    let siteBlock: string | null = null;
    if (params.url) {
      try {
        const host = new URL(params.url).hostname;
        const hostKey = this.normalizeSiteKey(host);
        const hostNoWww = hostKey;
        const siteBullets =
          (hostKey && this.selfImprovementPerSite[hostKey]) ||
          (hostNoWww && this.selfImprovementPerSite[hostNoWww]) ||
          null;

        if (Array.isArray(siteBullets) && siteBullets.length > 0) {
          siteBlock = `### SITE-SPECIFIC SPECIAL INSTRUCTIONS (${hostNoWww || hostKey})\n${siteBullets
            .slice(0, 12)
            .map((b) => `- ${b}`)
            .join("\n")}`;
        }
      } catch {
        // ignore
      }
    }

    if (siteBlock) {
      parts.push(siteBlock);
    }

    if (params.url) {
      parts.push(`Current page URL: ${params.url}`);
    }

    /*
    if (params.pageText) {
      const truncatedText = this.truncateText(params.pageText, MAX_CONTEXT_LENGTH);
      parts.push(`Page text content (in viewport):\n${truncatedText}`);
    }
    */

    if (parts.length === 0) return base;
    return base + "\n\n" + parts.join("\n\n");
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

    // Gemini CU usually returns coords in [0..1000], but some providers/variants may
    // emit fractional coords in [0..1]. Support both.
    const normalized = n >= 0 && n <= 1 ? n : n / 1000;
    return Math.max(0, Math.min(max, Math.round(normalized * max)));
  }

  private async getActiveTabOrThrow() {
    const tab = this.getTabByIdOrActive(null);
    if (!tab) throw new Error("No active tab available");
    return tab;
  }

  private async waitForDomReady(tab: any, opts?: { timeoutMs?: number; idleMs?: number }): Promise<void> {
    const timeoutMs =
      typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
        ? Math.max(250, Math.min(10_000, Math.round(opts.timeoutMs)))
        : 6500;
    const idleMs =
      typeof opts?.idleMs === "number" && Number.isFinite(opts.idleMs)
        ? Math.max(0, Math.min(1500, Math.round(opts.idleMs)))
        : 350;

    const settleMs = 250;

    const start = Date.now();
    let lastBusyAt = Date.now();

    const wc = tab?.webContents;
    const waitForStopLoading = async (maxWaitMs: number): Promise<void> => {
      if (!wc || typeof wc.isLoading !== "function") return;
      if (!wc.isLoading()) return;
      if (typeof wc.once !== "function" || typeof wc.removeListener !== "function") return;
      const waitMs = Math.max(0, Math.min(1500, Math.round(maxWaitMs)));
      if (waitMs <= 0) return;

      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try {
            wc.removeListener("did-stop-loading", finish);
            wc.removeListener("did-finish-load", finish);
            wc.removeListener("did-fail-load", finish);
          } catch {
            // ignore
          }
          resolve();
        };

        try {
          wc.once("did-stop-loading", finish);
          wc.once("did-finish-load", finish);
          wc.once("did-fail-load", finish);
        } catch {
          // ignore
        }

        setTimeout(finish, waitMs);
      });
    };

    while (Date.now() - start < timeoutMs) {
      try {
        if (this.activeRunAbortController?.signal?.aborted) return;
      } catch {
        // ignore
      }

      let isLoading = false;
      try {
        isLoading = Boolean(tab?.webContents?.isLoading?.());
      } catch {
        // ignore
      }

      if (isLoading) {
        try {
          await waitForStopLoading(timeoutMs - (Date.now() - start));
        } catch {
          // ignore
        }
      }

      let readyState: string | null = null;
      try {
        const rs = await tab.runJs("document.readyState");
        readyState = typeof rs === "string" ? rs : null;
      } catch {
        // If executeJavaScript is unavailable mid-navigation, treat as busy.
        readyState = null;
      }

      const domReady = readyState === "interactive" || readyState === "complete";
      const busy = isLoading || !domReady;

      if (busy) {
        lastBusyAt = Date.now();
      } else if (Date.now() - lastBusyAt >= idleMs) {
        await new Promise((r) => setTimeout(r, settleMs));
        let stillLoading = false;
        try {
          stillLoading = Boolean(tab?.webContents?.isLoading?.());
        } catch {
          stillLoading = false;
        }
        let stillReady = false;
        try {
          const rs2 = await tab.runJs("document.readyState");
          stillReady = rs2 === "interactive" || rs2 === "complete";
        } catch {
          stillReady = false;
        }
        if (!stillLoading && stillReady) return;
        lastBusyAt = Date.now();
      }

      await new Promise((r) => setTimeout(r, 75));
    }
  }

  private async captureStableTabScreenshot(tab: any, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<any> {
    const timeoutMs =
      typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
        ? Math.max(250, Math.min(10_000, Math.round(opts.timeoutMs)))
        : 2000;
    const intervalMs =
      typeof opts?.intervalMs === "number" && Number.isFinite(opts.intervalMs)
        ? Math.max(75, Math.min(1500, Math.round(opts.intervalMs)))
        : 250;

    const start = Date.now();
    let prevSmall: Buffer | null = null;
    let lastFull: any = null;

    const diffRatio = (a: Buffer, b: Buffer): number => {
      const len = Math.min(a.length, b.length);
      if (len <= 0) return 1;
      let sum = 0;
      let count = 0;
      const step = 16;
      for (let i = 0; i + 2 < len; i += step) {
        sum += Math.abs(a[i] - b[i]);
        sum += Math.abs(a[i + 1] - b[i + 1]);
        sum += Math.abs(a[i + 2] - b[i + 2]);
        count += 3;
      }
      if (count <= 0) return 1;
      return sum / (count * 255);
    };

    while (Date.now() - start < timeoutMs) {
      let img: any;
      try {
        img = await tab.screenshot();
      } catch {
        break;
      }

      lastFull = img;
      let smallBuf: Buffer | null = null;
      try {
        const small = img.resize({ width: 96, height: 60, quality: "good" });
        const bmp = small.toBitmap();
        smallBuf = Buffer.isBuffer(bmp) ? bmp : Buffer.from(bmp);
      } catch {
        return lastFull;
      }

      if (prevSmall) {
        const d = diffRatio(prevSmall, smallBuf);
        if (Number.isFinite(d) && d <= 0.018) {
          return lastFull;
        }
      }
      prevSmall = smallBuf;
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    return lastFull ?? (await tab.screenshot());
  }

  private computeSmallFrameSignature(image: any): Buffer | null {
    try {
      const small = image.resize({ width: 96, height: 60, quality: "good" });
      const bmp = small.toBitmap();
      return Buffer.isBuffer(bmp) ? bmp : Buffer.from(bmp);
    } catch {
      return null;
    }
  }

  private frameSignatureDiffRatio(a: Buffer, b: Buffer): number {
    const len = Math.min(a.length, b.length);
    if (len <= 0) return 1;
    let sum = 0;
    let count = 0;
    const step = 16;
    for (let i = 0; i + 2 < len; i += step) {
      sum += Math.abs(a[i] - b[i]);
      sum += Math.abs(a[i + 1] - b[i + 1]);
      sum += Math.abs(a[i + 2] - b[i + 2]);
      count += 3;
    }
    if (count <= 0) return 1;
    return sum / (count * 255);
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

        // Best-effort: avoid capturing half-loaded frames.
        try {
          await this.waitForDomReady(tab);
        } catch {
          // ignore
        }

        let viewportWidthCss = DEFAULT_COMPUTER_USE_SCREEN_WIDTH;
        let viewportHeightCss = DEFAULT_COMPUTER_USE_SCREEN_HEIGHT;
        let viewportDpr = 1;
        let viewportClientW = 0;
        let viewportClientH = 0;
        let viewportInnerW = 0;
        let viewportInnerH = 0;
        try {
          const viewport = await tab.runJs(
            "(() => ({ w: window.innerWidth || 1440, h: window.innerHeight || 900, cw: document.documentElement && document.documentElement.clientWidth ? document.documentElement.clientWidth : 0, ch: document.documentElement && document.documentElement.clientHeight ? document.documentElement.clientHeight : 0, dpr: window.devicePixelRatio || 1 }))()"
          );
          const vw = typeof (viewport as any)?.w === "number" ? (viewport as any).w : DEFAULT_COMPUTER_USE_SCREEN_WIDTH;
          const vh = typeof (viewport as any)?.h === "number" ? (viewport as any).h : DEFAULT_COMPUTER_USE_SCREEN_HEIGHT;
          const cw = typeof (viewport as any)?.cw === "number" ? (viewport as any).cw : 0;
          const ch = typeof (viewport as any)?.ch === "number" ? (viewport as any).ch : 0;
          const dpr = typeof (viewport as any)?.dpr === "number" ? (viewport as any).dpr : 1;

          viewportInnerW = Number.isFinite(vw) && vw > 0 ? vw : 0;
          viewportInnerH = Number.isFinite(vh) && vh > 0 ? vh : 0;
          viewportClientW = Number.isFinite(cw) && cw > 0 ? cw : 0;
          viewportClientH = Number.isFinite(ch) && ch > 0 ? ch : 0;
          viewportDpr = Number.isFinite(dpr) && dpr > 0.1 ? dpr : 1;

          viewportWidthCss = viewportInnerW || viewportClientW || DEFAULT_COMPUTER_USE_SCREEN_WIDTH;
          viewportHeightCss = viewportInnerH || viewportClientH || DEFAULT_COMPUTER_USE_SCREEN_HEIGHT;
        } catch {
          // ignore
        }

        const image = await this.captureStableTabScreenshot(tab, { timeoutMs: 2000, intervalMs: 250 });
        this.lastGeminiComputerUseFrameSmall = this.computeSmallFrameSignature(image);
        const size = image.getSize();
        const widthRaw = typeof size?.width === "number" ? size.width : DEFAULT_COMPUTER_USE_SCREEN_WIDTH;
        const heightRaw = typeof size?.height === "number" ? size.height : DEFAULT_COMPUTER_USE_SCREEN_HEIGHT;

        // Align the CSS-space mapping to the screenshot bitmap. window.innerWidth/clientWidth
        // can differ from the captured bitmap width (e.g. scrollbars/rounding), which causes
        // systematic coordinate offsets (often on X).
        if (Number.isFinite(viewportDpr) && viewportDpr > 0.1 && viewportDpr < 8 && widthRaw > 0 && heightRaw > 0) {
          const derivedW = Math.round(widthRaw / viewportDpr);
          const derivedH = Math.round(heightRaw / viewportDpr);
          if (Number.isFinite(derivedW) && derivedW > 0) viewportWidthCss = derivedW;
          if (Number.isFinite(derivedH) && derivedH > 0) viewportHeightCss = derivedH;
        }

        const targetAspect =
          widthRaw > 0 && heightRaw > 0
            ? widthRaw / heightRaw
            : DEFAULT_COMPUTER_USE_SCREEN_WIDTH / DEFAULT_COMPUTER_USE_SCREEN_HEIGHT;
        const currentAspect = targetAspect;
        let cropped = image;
        let width = widthRaw;
        let height = heightRaw;

        if (widthRaw > 0 && heightRaw > 0) {
          if (currentAspect > targetAspect) {
            const cropWidth = Math.max(1, Math.round(heightRaw * targetAspect));
            if (cropWidth < widthRaw) {
              cropped = image.crop({ x: 0, y: 0, width: cropWidth, height: heightRaw });
              width = cropWidth;
              height = heightRaw;
            }
          } else if (currentAspect < targetAspect) {
            const cropHeight = Math.max(1, Math.round(widthRaw / targetAspect));
            if (cropHeight < heightRaw) {
              cropped = image.crop({ x: 0, y: 0, width: widthRaw, height: cropHeight });
              width = widthRaw;
              height = cropHeight;
            }
          }
        }

        // Store a transform for mapping model coordinates back into the live viewport.
        // We crop from the top-left (trim right/bottom), so offsets are currently 0.
        const scaleX = widthRaw > 0 ? widthRaw / Math.max(1, viewportWidthCss) : 1;
        const scaleY = heightRaw > 0 ? heightRaw / Math.max(1, viewportHeightCss) : 1;
        const cropWidthCss = Math.max(1, Math.round(width / Math.max(0.0001, scaleX)));
        const cropHeightCss = Math.max(1, Math.round(height / Math.max(0.0001, scaleY)));

        this.lastGeminiComputerUseFrameTransform = {
          cropWidthCss,
          cropHeightCss,
          offsetXCss: 0,
          offsetYCss: 0,
          viewportWidthCss,
          viewportHeightCss,
        };

        const maxW = DEFAULT_COMPUTER_USE_SCREEN_WIDTH;
        const maxH = DEFAULT_COMPUTER_USE_SCREEN_HEIGHT;
        const scale = Math.min(1, maxW / Math.max(1, width), maxH / Math.max(1, height));

        const capped =
          scale < 1
            ? cropped.resize({
                width: Math.max(1, Math.round(width * scale)),
                height: Math.max(1, Math.round(height * scale)),
                quality: "best",
              })
            : cropped;

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

    const shouldAbortForFrameDrift = async (): Promise<boolean> => {
      const prev = this.lastGeminiComputerUseFrameSmall;
      if (!prev) return false;
      let img: any;
      try {
        img = await tab.screenshot();
      } catch {
        return false;
      }
      const cur = this.computeSmallFrameSignature(img);
      if (!cur) return false;
      const d = this.frameSignatureDiffRatio(prev, cur);
      return Number.isFinite(d) && d > 0.04;
    };

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

    const frame = this.lastGeminiComputerUseFrameTransform;
    const offsetX = frame && Number.isFinite(frame.offsetXCss) ? frame.offsetXCss : 0;
    const offsetY = frame && Number.isFinite(frame.offsetYCss) ? frame.offsetYCss : 0;

    // Prefer the stored frame transform (derived from the screenshot), but fall back to the
    // live viewport if they disagree (prevents systematic offsets from scrollbars/rounding).
    let maxX = w;
    let maxY = h;
    if (frame && Number.isFinite(frame.cropWidthCss) && Number.isFinite(frame.cropHeightCss)) {
      const fx = frame.cropWidthCss;
      const fy = frame.cropHeightCss;
      const dx = Math.abs(fx - w);
      const dy = Math.abs(fy - h);

      const xCloseEnough = dx <= 24 || (w > 0 && dx / w <= 0.08);
      const yCloseEnough = dy <= 24 || (h > 0 && dy / h <= 0.08);

      maxX = xCloseEnough ? fx : w;
      maxY = yCloseEnough ? fy : h;
    }

    const viewportMaxX = Math.max(0, Math.floor(w) - 1);
    const viewportMaxY = Math.max(0, Math.floor(h) - 1);
    const denormMaxX = Math.max(0, Math.floor(maxX) - 1);
    const denormMaxY = Math.max(0, Math.floor(maxY) - 1);

    const clampToViewportX = (v: number): number =>
      Number.isFinite(v) ? Math.max(0, Math.min(viewportMaxX, Math.round(v))) : 0;
    const clampToViewportY = (v: number): number =>
      Number.isFinite(v) ? Math.max(0, Math.min(viewportMaxY, Math.round(v))) : 0;

    const x = clampToViewportX(offsetX + this.denormalizeCoord(args.x, denormMaxX));
    const y = clampToViewportY(offsetY + this.denormalizeCoord(args.y, denormMaxY));
    const destX = clampToViewportX(offsetX + this.denormalizeCoord(args.destination_x, denormMaxX));
    const destY = clampToViewportY(offsetY + this.denormalizeCoord(args.destination_y, denormMaxY));

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
        case "open_page":
        case "open_url":
        case "openurl": {
          const rawUrl = (args as any).url ?? (args as any).href ?? (args as any).destination;
          const url = typeof rawUrl === "string" ? rawUrl : "";
          if (!url)
            return {
              name: action.name,
              response: { ok: false, error: "Missing url", url: tab.url },
            };
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
          await new Promise((r) => setTimeout(r, 2000));
          return { name: action.name, response: { ok: true, url: tab.url } };
        }
        case "wait": {
          const seconds = typeof (args as any).seconds === "number" ? (args as any).seconds : null;
          const msRaw = typeof (args as any).ms === "number" ? (args as any).ms : null;
          const ms =
            typeof msRaw === "number" && Number.isFinite(msRaw)
              ? Math.max(0, Math.min(60_000, Math.round(msRaw)))
              : typeof seconds === "number" && Number.isFinite(seconds)
                ? Math.max(0, Math.min(60_000, Math.round(seconds * 1000)))
                : 2000;
          await new Promise((r) => setTimeout(r, ms));
          return { name: action.name, response: { ok: true, waitedMs: ms, url: tab.url } };
        }
        case "click_at":
        case "hover_at": {
          try {
            await this.waitForDomReady(tab, { timeoutMs: 1200, idleMs: 250 });
          } catch {
            // ignore
          }

          if (await shouldAbortForFrameDrift()) {
            return { name: action.name, response: { ok: false, error: "Page changed; retry with a fresh screenshot.", url: tab.url } };
          }

          const clickX = x;
          const clickY = y;

          if (action.name === "hover_at") {
            if (this.activeGeminiComputerUseRunId) {
              await this.sendOverlayEvent({
                type: "pointer",
                runId: this.activeGeminiComputerUseRunId,
                mode: "pointer",
                x: clickX,
                y: clickY,
              });
              await this.startHighlightTracking(tab, clickX, clickY);
            }
            tab.webContents.sendInputEvent({ type: "mouseMove", x: clickX, y: clickY });
            return {
              name: action.name,
              response: { ok: true, x: clickX, y: clickY, type: "mousemove", url: tab.url },
            };
          }

          tab.webContents.sendInputEvent({ type: "mouseMove", x: clickX, y: clickY });
          tab.webContents.sendInputEvent({
            type: "mouseDown",
            x: clickX,
            y: clickY,
            button: "left",
            clickCount: 1,
          });
          tab.webContents.sendInputEvent({
            type: "mouseUp",
            x: clickX,
            y: clickY,
            button: "left",
            clickCount: 1,
          });
          if (this.activeGeminiComputerUseRunId) {
            await this.sendOverlayEvent({
              type: "pointer",
              runId: this.activeGeminiComputerUseRunId,
              mode: "pointer",
              x: clickX,
              y: clickY,
            });
            await this.startHighlightTracking(tab, clickX, clickY);
          }
          return {
            name: action.name,
            response: { ok: true, x: clickX, y: clickY, type: "click", url: tab.url },
          };
        }

        case "type_text_at": {
          const text = typeof args.text === "string" ? args.text : "";
          const pressEnter = Boolean(args.press_enter);
          const clearBefore =
            typeof args.clear_before_typing === "boolean" ? args.clear_before_typing : false;

          try {
            await this.waitForDomReady(tab, { timeoutMs: 1200, idleMs: 250 });
          } catch {
            // ignore
          }

          const clickX = x;
          const clickY = y;

          if (this.activeGeminiComputerUseRunId) {
            await this.sendOverlayEvent({
              type: "pointer",
              runId: this.activeGeminiComputerUseRunId,
              mode: "text",
              x: clickX,
              y: clickY,
            });
            await this.startHighlightTracking(tab, clickX, clickY);
          }

          // Focus the element by clicking, then type using real input events.
          tab.webContents.sendInputEvent({ type: "mouseMove", x: clickX, y: clickY });
          // Many complex apps (e.g. Google Sheets) require a double-click to enter edit mode.
          tab.webContents.sendInputEvent({
            type: "mouseDown",
            x: clickX,
            y: clickY,
            button: "left",
            clickCount: 2,
          });
          tab.webContents.sendInputEvent({
            type: "mouseUp",
            x: clickX,
            y: clickY,
            button: "left",
            clickCount: 2,
          });
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

          return { name: action.name, response: { ok: true, x: clickX, y: clickY, url: tab.url } };
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
          await new Promise((r) => setTimeout(r, 50));
          sendKey(key.length > 0 ? key : "Unidentified", modifiers);
          return { name: action.name, response: { ok: true, keys, url: tab.url } };
        }

        case "drag_and_drop": {
          try {
            await this.waitForDomReady(tab, { timeoutMs: 1200, idleMs: 250 });
          } catch {
            // ignore
          }

          if (await shouldAbortForFrameDrift()) {
            return { name: action.name, response: { ok: false, error: "Page changed; retry with a fresh screenshot.", url: tab.url } };
          }
          await new Promise((r) => setTimeout(r, 50));
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

    const excludedPredefinedFunctions = ["open_web_browser"];

    let messageIndex: number | null = null;
    let resetAssistantOnNextDelta = false;
    let sentAnyNavigationDelta = false;
    let overlayStarted = false;
    let overlayStartPromise: Promise<void> | null = null;

    const runStartedAt = Date.now();
    const assistantDrafts: string[] = [];
    let assistantDraftCurrent = "";
    let navigationTranscript = "";
    const executedActions: Array<{ name: string; args: any; url: string | null }> = [];

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

    this.logModelInputGeminiComputerUse({
      systemInstruction: params.systemInstruction,
      contents: this.geminiComputerUseContents,
      maxSteps,
      excludedPredefinedFunctions,
    });

    const ensureOverlayStarted = (): Promise<void> => {
      if (overlayStarted) return overlayStartPromise ?? Promise.resolve();
      overlayStarted = true;
      overlayStartPromise = this.sendOverlayEvent({ type: "start", runId: params.messageId }).catch(
        () => undefined
      );
      return overlayStartPromise;
    };

    try {
      let siStep = 0;
      await agent.run({
        model: this.modelName,
        userPrompt: params.userPrompt,
        systemInstruction: params.systemInstruction,
        getSystemInstruction: async () => {
          siStep += 1;
          const tab = await this.getActiveTabOrThrow();

          let pageText: string | null = null;
          try {
            pageText = await tab.getViewportText();
          } catch {
            pageText = null;
          }

          // Recompute on each step so per-site instructions update after navigation.
          const si = this.buildComputerUseSystemInstruction({
            url: typeof tab.url === "string" ? tab.url : null,
            pageText,
          });

          if (this.shouldLogModelInput()) {
            try {
              const marker = "### SITE-SPECIFIC SPECIAL INSTRUCTIONS";
              const hasSite = typeof si === "string" && si.includes(marker);
              const url = typeof tab.url === "string" ? tab.url : "";
              console.log(
                `[CU_STEP_SYSTEM_INSTRUCTION] step=${siStep} hasSiteSpecific=${hasSite} url=${url}`
              );
              if (hasSite) {
                const idx = si.indexOf(marker);
                const tail = idx >= 0 ? si.slice(idx) : "";
                console.log("[CU_STEP_SYSTEM_INSTRUCTION_SITE_BLOCK]\n" + tail);
              }
            } catch {
              // ignore
            }
          }

          return si;
        },
        maxSteps,
        excludedPredefinedFunctions,
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
            executedActions.push({
              name: typeof action?.name === "string" ? action.name : "unknown_action",
              args: action?.args,
              url: typeof currentUrl === "string" ? currentUrl : null,
            });
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

            const shouldResetUi = resetAssistantOnNextDelta;
            if (shouldResetUi) {
              resetAssistantOnNextDelta = false;
              if (assistantDraftCurrent.trim().length > 0) {
                assistantDrafts.push(assistantDraftCurrent);
              }
              assistantDraftCurrent = "";
            }

            assistantDraftCurrent += delta;
            const idx = ensureAssistantMessage();
            const current =
              typeof this.messages[idx]?.content === "string"
                ? (this.messages[idx].content as string)
                : "";

            if (shouldResetUi) {
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
            navigationTranscript += delta;
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
          await this.sendOverlayEvent({ type: "log", runId: params.messageId, text: "Navigation complete" });
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

    const allDrafts = [...assistantDrafts, assistantDraftCurrent].filter(
      (s) => typeof s === "string" && s.length > 0
    );
    const assistantTranscript = allDrafts
      .map((text, idx) => {
        const isFinal = idx === allDrafts.length - 1;
        return isFinal ? `FINAL ANSWER:\n${text}` : `THOUGHT ${idx + 1}:\n${text}`;
      })
      .join("\n\n");

    this.enqueueSelfImprovementFromComputerUseRun({
      messageId: params.messageId,
      userPrompt: params.userPrompt,
      assistantText: assistantTranscript,
      navigationTranscript,
      executedActions,
      durationMs: Math.max(0, Date.now() - runStartedAt),
      geminiContents: this.geminiComputerUseContents,
    });
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
        pageText = await tab.getViewportText();
      } catch {
        pageText = null;
      }

      const systemInstruction = this.buildComputerUseSystemInstruction({ url: tab.url, pageText });
      const prefixedUserPrompt = this.buildComputerUseUserPrompt({
        url: tab.url,
        pageText,
        userMessage: userPrompt || "",
      });

      await this.geminiComputerUseLoop({
        messageId,
        userPrompt: prefixedUserPrompt,
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

        this.logModelInputNormal(messages);

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
    const parsed = parseComputerUseNavigationDelta(delta, this.geminiComputerUseNavigationOverlayBuffer);
    this.geminiComputerUseNavigationOverlayBuffer = parsed.nextBuffer;
    return parsed.prettyLines;
  }
}
