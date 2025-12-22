export type ComputerUseNavigationStep = {
  current: number;
  total: number;
};

export type ComputerUseNavigationDeltaParseResult = {
  nextBuffer: string;
  prettyLines: string[];
  steps: ComputerUseNavigationStep[];
  sawDone: boolean;
};

const getUrlFromArgs = (parsedArgs: any): string => {
  const url =
    parsedArgs && typeof parsedArgs.url === "string" && parsedArgs.url.trim().length > 0
      ? parsedArgs.url.trim()
      : parsedArgs && typeof parsedArgs.href === "string" && parsedArgs.href.trim().length > 0
        ? parsedArgs.href.trim()
        : parsedArgs && typeof parsedArgs.destination === "string" && parsedArgs.destination.trim().length > 0
          ? parsedArgs.destination.trim()
          : "";

  return url;
};

const prettyFromActionLine = (cleaned: string): string => {
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

  if (lowerAction.includes("type_text")) {
    const text = parsedArgs && typeof parsedArgs.text === "string" ? parsedArgs.text : "";
    const enter = parsedArgs && typeof parsedArgs.enter === "boolean" ? parsedArgs.enter : false;
    const safeText = text.length > 0 ? ` “${text}”` : "";
    return enter ? `Submitting${safeText}` : `Typing${safeText}`;
  }

  if (lowerAction.includes("search")) {
    return "Searching";
  }

  if (lowerAction.includes("click")) {
    return "Clicking element";
  }

  if (lowerAction.includes("hover")) {
    return "Hovering";
  }

  if (lowerAction.includes("drag")) {
    return "Dragging";
  }

  if (lowerAction.includes("scroll")) {
    return "Scrolling";
  }

  if (
    lowerAction.includes("navigate") ||
    lowerAction.includes("open_page") ||
    lowerAction.includes("open_url") ||
    lowerAction.includes("openurl")
  ) {
    const url = getUrlFromArgs(parsedArgs);
    return url ? `Opening page “${url}”` : "Opening page";
  }

  if (lowerAction.includes("go_back")) {
    return "Going back";
  }

  if (lowerAction.includes("go_forward")) {
    return "Going forward";
  }

  if (lowerAction.includes("open_web_browser")) {
    return "Opening browser";
  }

  if (lowerAction.includes("wait")) {
    return "Waiting";
  }

  if (lowerAction.includes("key") || lowerAction.includes("keypress")) {
    return "Pressing keys";
  }

  return "Continuing";
};

export const parseComputerUseNavigationDelta = (
  delta: string,
  buffer: string
): ComputerUseNavigationDeltaParseResult => {
  const nextRaw = (buffer ?? "") + (delta ?? "");
  const parts = nextRaw.split(/\r?\n/);
  const completeLines = parts.slice(0, -1);
  const nextBuffer = parts[parts.length - 1] ?? "";

  const prettyLines: string[] = [];
  const steps: ComputerUseNavigationStep[] = [];
  let sawDone = false;

  for (const rawLine of completeLines) {
    const line = rawLine.trim();
    if (!line) continue;

    const cleaned = line.replace(/^Computer Use\s*:\s*/i, "").trim();

    const stepMatch = cleaned.match(/\bstep\s+(\d+)\s*\/\s*(\d+)\b/i);
    if (stepMatch) {
      const cur = Number(stepMatch[1]);
      const total = Number(stepMatch[2]);
      if (Number.isFinite(cur) && Number.isFinite(total)) {
        steps.push({ current: cur, total });
      }
      continue;
    }

    if (/\bdone\b/i.test(cleaned) && /no more actions/i.test(cleaned)) {
      sawDone = true;
      continue;
    }

    prettyLines.push(prettyFromActionLine(cleaned));
  }

  return { nextBuffer, prettyLines, steps, sawDone };
};
