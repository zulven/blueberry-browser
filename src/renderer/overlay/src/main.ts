type OverlayEvent =
  | { type: "start"; runId: string }
  | { type: "end"; runId: string }
  | { type: "log"; runId: string; text: string }
  | { type: "pointer"; runId: string; x: number; y: number; mode?: "pointer" | "text" }
  | { type: "highlight"; runId: string; rect: { x: number; y: number; width: number; height: number } }
  | { type: "highlight-point"; runId: string; x: number; y: number }
  | { type: "highlight-clear"; runId: string };

const root = document.getElementById("root") as HTMLDivElement;

const applyTheme = () => {
  try {
    const isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", Boolean(isDark));
  } catch {
    // ignore
  }
};

applyTheme();
try {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
} catch {
  // ignore
}

const container = document.createElement("div");
container.style.position = "relative";
container.style.width = "100%";
container.style.height = "100%";
container.style.pointerEvents = "none";
root.appendChild(container);

const styleEl = document.createElement("style");
styleEl.textContent = `
@keyframes bb_spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;
document.head.appendChild(styleEl);

// Full width gradient bar at bottom
const topBar = document.createElement("div");
topBar.style.position = "absolute";
topBar.style.left = "12px";
topBar.style.right = "12px";
topBar.style.bottom = "10px";
topBar.style.width = "auto";
topBar.style.height = "120px";
topBar.style.display = "flex";
topBar.style.flexDirection = "column";
topBar.style.justifyContent = "flex-end";
topBar.style.alignItems = "stretch";
topBar.style.padding = "0";
topBar.style.boxSizing = "border-box";
topBar.style.background = "transparent";
topBar.style.opacity = "0";
topBar.style.transform = "translateY(6px)";
topBar.style.transition =
  "opacity 160ms cubic-bezier(0.2,0.9,0.2,1), transform 160ms cubic-bezier(0.2,0.9,0.2,1)";
topBar.style.willChange = "opacity,transform";
container.appendChild(topBar);

const logWrap = document.createElement("div");
logWrap.style.width = "100%";
logWrap.style.margin = "0";
logWrap.style.display = "block";
logWrap.style.position = "relative";
logWrap.style.overflow = "hidden";
logWrap.style.boxSizing = "border-box";
logWrap.style.color = "rgba(255,255,255,0.96)";
logWrap.style.fontFamily =
  "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
logWrap.style.fontSize = "14px";
logWrap.style.fontWeight = "600";
logWrap.style.lineHeight = "18px";
logWrap.style.textShadow = "0 2px 14px rgba(0,0,0,0.95), 0 1px 3px rgba(0,0,0,0.85)";
logWrap.style.background = "rgb(var(--background) / 0.95)";
logWrap.style.backdropFilter = "blur(6px)";
logWrap.style.borderRadius = "14px";
logWrap.style.border = "1px solid rgba(255,255,255,0.10)";
logWrap.style.padding = "14px 18px";
logWrap.style.boxShadow = "0 -12px 30px rgba(0,0,0,0.55)";
topBar.appendChild(logWrap);

const leftScrim = document.createElement("div");
leftScrim.style.position = "absolute";
leftScrim.style.left = "0";
leftScrim.style.top = "0";
leftScrim.style.bottom = "0";
leftScrim.style.width = "176px";
leftScrim.style.pointerEvents = "none";
leftScrim.style.zIndex = "0";
leftScrim.style.background =
  "linear-gradient(to right, rgb(var(--background) / 1), rgb(var(--background) / 1) 24px, rgb(var(--background) / 0) 100%)";
logWrap.appendChild(leftScrim);

const rightScrim = document.createElement("div");
rightScrim.style.position = "absolute";
rightScrim.style.right = "0";
rightScrim.style.top = "0";
rightScrim.style.bottom = "0";
rightScrim.style.width = "176px";
rightScrim.style.pointerEvents = "none";
rightScrim.style.zIndex = "0";
rightScrim.style.background =
  "linear-gradient(to left, rgb(var(--background) / 1), rgb(var(--background) / 1) 24px, rgb(var(--background) / 0) 100%)";
logWrap.appendChild(rightScrim);

const logRow = document.createElement("div");
logRow.style.display = "flex";
logRow.style.alignItems = "center";
logRow.style.justifyContent = "center";
logRow.style.gap = "10px";
logRow.style.width = "100%";
logRow.style.boxSizing = "border-box";
logRow.style.position = "relative";
logRow.style.zIndex = "1";
logWrap.appendChild(logRow);

const spinner = document.createElement("div");
spinner.style.width = "14px";
spinner.style.height = "14px";
spinner.style.borderRadius = "999px";
spinner.style.border = "2px solid rgba(99, 102, 241, 0.35)";
spinner.style.borderTopColor = "rgba(99, 102, 241, 0.95)";
spinner.style.animation = "bb_spin 900ms linear infinite";
spinner.style.boxShadow = "0 0 0 2px rgba(0,0,0,0.25)";
logRow.appendChild(spinner);

const lineViewport = document.createElement("div");
lineViewport.style.position = "relative";
lineViewport.style.overflow = "hidden";
lineViewport.style.height = "18px";
lineViewport.style.width = "100%";
lineViewport.style.flex = "1";
lineViewport.style.minWidth = "0";
logRow.appendChild(lineViewport);

const makeLine = () => {
  const line = document.createElement("div");
  line.style.position = "absolute";
  line.style.left = "0";
  line.style.right = "0";
  line.style.bottom = "0";
  line.style.whiteSpace = "pre-wrap";
  line.style.textAlign = "center";
  line.style.willChange = "transform,opacity";
  return line;
};

let currentLine = makeLine();
currentLine.style.opacity = "0";
currentLine.style.transform = "translateY(0px)";
lineViewport.appendChild(currentLine);

let rolling = false;
let pendingText: string | null = null;

// Pointer
const pointer = document.createElement("div");
pointer.style.position = "absolute";
pointer.style.left = "0";
pointer.style.top = "0";
pointer.style.width = "0";
pointer.style.height = "0";
pointer.style.transform = "translate3d(-100px,-100px,0)";
pointer.style.transition = "transform 190ms cubic-bezier(0.2,0.9,0.2,1)";
pointer.style.willChange = "transform";
container.appendChild(pointer);

const dot = document.createElement("div");
dot.style.position = "absolute";
dot.style.left = "0";
dot.style.top = "0";
dot.style.width = "18px";
dot.style.height = "18px";
dot.style.transform = "translate(-2px,-2px)";
dot.style.borderRadius = "50%";
dot.style.background = "rgba(255,255,255,0.92)";
dot.style.boxShadow = "0 0 0 2px rgba(0,0,0,0.35), 0 8px 18px rgba(0,0,0,0.35)";
pointer.appendChild(dot);

const iBeam = document.createElement("div");
iBeam.style.position = "absolute";
iBeam.style.left = "8px";
iBeam.style.top = "-1px";
iBeam.style.width = "2px";
iBeam.style.height = "22px";
iBeam.style.borderRadius = "2px";
iBeam.style.background = "rgba(255,255,255,0.92)";
iBeam.style.boxShadow = "0 0 0 2px rgba(0,0,0,0.35), 0 8px 18px rgba(0,0,0,0.35)";
iBeam.style.display = "none";
pointer.appendChild(iBeam);

// Highlight rect
const highlight = document.createElement("div");
highlight.style.position = "absolute";
highlight.style.left = "0";
highlight.style.top = "0";
highlight.style.opacity = "0";
highlight.style.transform = "translate3d(-100px,-100px,0)";
highlight.style.width = "0";
highlight.style.height = "0";
highlight.style.borderRadius = "10px";
highlight.style.outline = "2px solid rgba(99, 102, 241, 0.95)";
highlight.style.boxShadow =
  "0 0 0 6px rgba(99,102,241,0.18), 0 20px 40px rgba(0,0,0,0.22)";
highlight.style.transition =
  "transform 190ms cubic-bezier(0.2,0.9,0.2,1), width 190ms cubic-bezier(0.2,0.9,0.2,1), height 190ms cubic-bezier(0.2,0.9,0.2,1), opacity 110ms ease";
highlight.style.willChange = "transform,width,height,opacity";
container.appendChild(highlight);

const state = {
  runId: null as string | null,
  visible: false,
  hideTimer: null as any,
  maxLines: 8,
};

const show = () => {
  if (state.visible) return;
  state.visible = true;
  topBar.style.opacity = "1";
  topBar.style.transform = "translateY(0px)";
};

const hideNow = () => {
  state.visible = false;
  topBar.style.opacity = "0";
  topBar.style.transform = "translateY(6px)";
  currentLine.textContent = "";
  currentLine.style.opacity = "0";
  currentLine.style.transform = "translateY(0px)";
  rolling = false;
  pendingText = null;
  pointer.style.transform = "translate3d(-100px,-100px,0)";
  highlight.style.opacity = "0";
  highlight.style.transform = "translate3d(-100px,-100px,0)";
  highlight.style.width = "0";
  highlight.style.height = "0";
  dot.style.display = "block";
  iBeam.style.display = "none";
};

const scheduleHide = () => {
  if (state.hideTimer) clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(() => hideNow(), 320);
};

const setStep = (text: string) => {
  const nextText = text.trimEnd();
  if (!nextText) return;

  const rollOffsetPx = 22;
  const rollTransition =
    "transform 860ms cubic-bezier(0.16, 1, 0.3, 1), opacity 520ms cubic-bezier(0.16, 1, 0.3, 1)";

  if (rolling) {
    pendingText = nextText;
    return;
  }

  // First line: roll in from below.
  if (!currentLine.textContent) {
    currentLine.textContent = nextText;
    currentLine.style.opacity = "0";
    currentLine.style.transform = `translateY(${rollOffsetPx}px)`;
    currentLine.style.transition = rollTransition;
    requestAnimationFrame(() => {
      currentLine.style.opacity = "1";
      currentLine.style.transform = "translateY(0px)";
    });
    return;
  }

  rolling = true;
  const outgoing = currentLine;
  const incoming = makeLine();
  incoming.textContent = nextText;
  incoming.style.opacity = "0";
  incoming.style.transform = `translateY(${rollOffsetPx}px)`;
  incoming.style.transition = rollTransition;
  outgoing.style.transition = rollTransition;
  lineViewport.appendChild(incoming);

  requestAnimationFrame(() => {
    outgoing.style.opacity = "0";
    outgoing.style.transform = `translateY(-${rollOffsetPx}px)`;
    incoming.style.opacity = "1";
    incoming.style.transform = "translateY(0px)";
  });

  setTimeout(() => {
    try {
      outgoing.remove();
    } catch {
      // ignore
    }
    currentLine = incoming;
    rolling = false;
    if (pendingText) {
      const p = pendingText;
      pendingText = null;
      setStep(p);
    }
  }, 920);
};

const setPointer = (x: number, y: number, mode: "pointer" | "text") => {
  dot.style.display = mode === "pointer" ? "block" : "none";
  iBeam.style.display = mode === "text" ? "block" : "none";
  pointer.style.transform = `translate3d(${x}px,${y}px,0)`;
};

const setHighlightRect = (rect: { x: number; y: number; width: number; height: number }) => {
  highlight.style.opacity = "1";
  highlight.style.width = `${rect.width}px`;
  highlight.style.height = `${rect.height}px`;
  highlight.style.transform = `translate3d(${rect.x}px,${rect.y}px,0)`;
};

const setHighlightPoint = (x: number, y: number) => {
  setHighlightRect({ x: x - 20, y: y - 20, width: 40, height: 40 });
};

const clearHighlight = () => {
  highlight.style.opacity = "0";
  highlight.style.transform = "translate3d(-100px,-100px,0)";
  highlight.style.width = "0";
  highlight.style.height = "0";
};

(window as any).__bbAgentOverlay = {
  onEvent: (ev: OverlayEvent) => {
    if (!ev || typeof ev !== "object") return false;

    if (ev.type === "start") {
      state.runId = ev.runId;
      return true;
    }

    if (state.runId && ev.runId !== state.runId) return false;

    if (ev.type === "end") {
      scheduleHide();
      return true;
    }

    show();

    if (ev.type === "log") {
      setStep(ev.text);
    } else if (ev.type === "pointer") {
      setPointer(ev.x, ev.y, ev.mode === "text" ? "text" : "pointer");
    } else if (ev.type === "highlight") {
      setHighlightRect(ev.rect);
    } else if (ev.type === "highlight-point") {
      setHighlightPoint(ev.x, ev.y);
    } else if (ev.type === "highlight-clear") {
      clearHighlight();
    }

    return true;
  },
};
