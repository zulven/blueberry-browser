import { GoogleGenAI } from "@google/genai";
import { SI_SYSTEM_PROMPT } from "./SiPrompt";

export type SelfImprovementInstructionObject = {
  general: string[];
  perSite: Record<string, string[]>;
};

export type SelfImprovementGenerateParams = {
  prompt: string;
  apiKey: string;
  model?: string;
  temperature?: number;
};

export async function generateSelfImprovementObject(
  params: SelfImprovementGenerateParams
): Promise<SelfImprovementInstructionObject> {
  if (typeof params.apiKey !== "string" || params.apiKey.trim().length === 0) {
    throw new Error("Missing Google Generative AI API key");
  }
  if (typeof params.prompt !== "string") {
    throw new Error("Missing prompt");
  }

  const model =
    typeof params.model === "string" && params.model.length > 0
      ? params.model
      : "gemini-3-flash-preview";

  const temperature =
    typeof params.temperature === "number" && Number.isFinite(params.temperature)
      ? params.temperature
      : 0.2;

  const ai = new GoogleGenAI({ apiKey: params.apiKey });

  const responseJsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      general: {
        type: "array",
        items: { type: "string" },
      },
      perSite: {
        type: "object",
        additionalProperties: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    required: ["general", "perSite"],
  };

  const res: any = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [{ text: params.prompt }],
      },
    ],
    config: {
      systemInstruction: { parts: [{ text: SI_SYSTEM_PROMPT }] },
      temperature,
      responseMimeType: "application/json",
      responseJsonSchema,
    },
  } as any);

  const text =
    typeof res?.text === "string"
      ? res.text
      : typeof res?.response?.text === "function"
        ? res.response.text()
        : typeof res?.response?.text === "string"
          ? res.response.text
          : "";

  let parsed: any = null;
  try {
    parsed = JSON.parse(typeof text === "string" ? text : "");
  } catch {
    parsed = null;
  }

  const general = Array.isArray(parsed?.general)
    ? parsed.general.filter((s: any) => typeof s === "string")
    : [];
  const perSiteRaw = parsed?.perSite && typeof parsed.perSite === "object" ? parsed.perSite : {};
  const perSite: Record<string, string[]> = {};

  try {
    for (const [k, v] of Object.entries(perSiteRaw)) {
      if (typeof k !== "string" || k.trim().length === 0) continue;
      if (!Array.isArray(v)) continue;
      const arr = (v as any[]).filter((s) => typeof s === "string");
      perSite[k.trim()] = arr;
    }
  } catch {
    // ignore
  }

  return { general, perSite };
}

export async function generateSelfImprovementText(
  params: SelfImprovementGenerateParams
): Promise<string> {
  if (typeof params.apiKey !== "string" || params.apiKey.trim().length === 0) {
    throw new Error("Missing Google Generative AI API key");
  }
  if (typeof params.prompt !== "string") {
    throw new Error("Missing prompt");
  }

  const model = typeof params.model === "string" && params.model.length > 0
    ? params.model
    : "gemini-3-flash-preview";

  const temperature =
    typeof params.temperature === "number" && Number.isFinite(params.temperature)
      ? params.temperature
      : 0.7;

  const ai = new GoogleGenAI({ apiKey: params.apiKey });

  const res: any = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [{ text: params.prompt }],
      },
    ],
    config: {
      systemInstruction: { parts: [{ text: SI_SYSTEM_PROMPT }] },
      temperature,
    },
  } as any);

  const text =
    typeof res?.text === "string"
      ? res.text
      : typeof res?.response?.text === "function"
        ? res.response.text()
        : typeof res?.response?.text === "string"
          ? res.response.text
          : "";

  return typeof text === "string" ? text : "";
}
