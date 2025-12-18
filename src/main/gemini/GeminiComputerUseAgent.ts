import { GoogleGenAI } from "@google/genai";

export type GeminiComputerUseAgentCallbacks = {
  captureScreenshot: () => Promise<{ data: string; width: number; height: number }>;
  executeAction: (action: { name: string; args?: Record<string, any> }) => Promise<{
    name: string;
    response: any;
  }>;
  onAssistantDelta: (delta: string) => void;
  onReasoningDelta: (delta: string) => void;
  onNavigationDelta: (delta: string) => void;
  onLog?: (event: any) => void;
};

export class GeminiComputerUseAgent {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async run(params: {
    model: string;
    userPrompt: string;
    systemInstruction: string;
    maxSteps: number;
    excludedPredefinedFunctions?: string[];
    callbacks: GeminiComputerUseAgentCallbacks;
    existingContents?: any[];
    skipInitialUserTurn?: boolean;
  }): Promise<void> {
    const excluded = Array.isArray(params.excludedPredefinedFunctions)
      ? params.excludedPredefinedFunctions
      : [];

    const callbacks = params.callbacks;

    const contents: any[] = Array.isArray(params.existingContents)
      ? params.existingContents
      : [];

    const shouldCreateInitialUserTurn =
      !params.skipInitialUserTurn && (!Array.isArray(params.existingContents) || contents.length === 0);

    if (shouldCreateInitialUserTurn) {
      const firstShot = await callbacks.captureScreenshot();
      contents.push({
        role: "user",
        parts: [
          { text: params.userPrompt },
          {
            inlineData: {
              mimeType: "image/png",
              data: firstShot.data,
            },
          },
        ],
      });
    }

    let finalText = "";
    let hasAnyAction = false;
    let bufferedNavigation = "";

    const emitNavigation = (text: string) => {
      if (!text) return;
      if (!hasAnyAction) {
        bufferedNavigation += text;
        return;
      }
      if (bufferedNavigation) {
        callbacks.onNavigationDelta(bufferedNavigation);
        bufferedNavigation = "";
      }
      callbacks.onNavigationDelta(text);
    };

    for (let step = 0; step < params.maxSteps; step++) {
      emitNavigation(`Computer Use: step ${step + 1}/${params.maxSteps}...\n`);

      const config: any = {
        systemInstruction: { parts: [{ text: params.systemInstruction }] },
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 1024,
        },
        tools: [
          {
            computerUse: {
              environment: "ENVIRONMENT_BROWSER",
              excludedPredefinedFunctions: excluded,
            },
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: "AUTO",
          },
        },
      };

      let lastJson: any = null;
      let streamedText = "";
      let streamedThoughts = "";

      const streamResult: any = await this.ai.models.generateContentStream({
        model: params.model,
        contents,
        config,
      } as any);

      const iterable: any = streamResult && (streamResult.stream ?? streamResult);

      for await (const chunk of iterable as any) {
        lastJson = chunk;

        const candidate =
          chunk && Array.isArray(chunk.candidates) && chunk.candidates.length > 0
            ? chunk.candidates[0]
            : null;
        const parts = candidate?.content?.parts;
        if (!Array.isArray(parts)) continue;

        // The SDK streams text as deltas in content.parts; forward them directly
        // to preserve whitespace and avoid double-delta reconstruction.
        for (const part of parts) {
          const text = part && typeof part.text === "string" ? part.text : "";
          if (!text) continue;
          if (part && part.thought === true) {
            streamedThoughts += text;
            callbacks.onReasoningDelta(text);
          } else {
            streamedText += text;
            callbacks.onAssistantDelta(text);
          }
        }
      }

      // If the stream API didn't yield the full response object, fall back to the last chunk.
      let json: any = lastJson ?? {};

      if (streamResult && typeof streamResult === "object" && "response" in streamResult) {
        try {
          const resolved =
            typeof (streamResult as any).response?.then === "function"
              ? await (streamResult as any).response
              : (streamResult as any).response;
          if (resolved) json = resolved;
        } catch {
          // ignore
        }
      }
      const candidate =
        json && Array.isArray(json.candidates) && json.candidates.length > 0
          ? json.candidates[0]
          : null;
      const parts = candidate?.content?.parts;

      if (candidate?.content) {
        contents.push(candidate.content);
      } else if (Array.isArray(parts)) {
        contents.push({ role: "model", parts });
      }

      const functionCalls: Array<{ name: string; args?: Record<string, any> }> = [];

      if (Array.isArray(parts)) {
        for (const p of parts) {
          const fc =
            p && typeof (p as any).functionCall === "object"
              ? (p as any).functionCall
              : p && typeof (p as any).function_call === "object"
                ? (p as any).function_call
              : null;

          if (fc && typeof fc.name === "string") {
            functionCalls.push({
              name: fc.name,
              args: typeof fc.args === "object" ? fc.args : {},
            });
          }
        }
      }

      if (callbacks.onLog) {
        callbacks.onLog({
          type: "candidate",
          step: step + 1,
          functionCalls: functionCalls.map((c) => c.name),
        });
      }

      finalText += streamedText;

      if (functionCalls.length === 0) {
        emitNavigation("Computer Use: done (no more actions).\n");
        return;
      }

      if (!hasAnyAction) {
        hasAnyAction = true;
        if (bufferedNavigation) {
          callbacks.onNavigationDelta(bufferedNavigation);
          bufferedNavigation = "";
        }
      }

      const executedResults: Array<{ name: string; response: any }> = [];

      for (const fc of functionCalls) {
        emitNavigation(
          `Computer Use: action ${fc.name} ${fc.args ? JSON.stringify(fc.args) : "{}"}\n`
        );

        const executed = await callbacks.executeAction(fc);
        executedResults.push(executed);
      }

      // Capture the new environment state once after all actions.
      const afterShot = await callbacks.captureScreenshot();
      const functionResponses: any[] = executedResults.map((executed) => ({
        functionResponse: {
          name: executed.name,
          response: executed.response,
          parts: [
            {
              inlineData: {
                mimeType: "image/png",
                data: afterShot.data,
              },
            },
          ],
        },
      }));

      contents.push({ role: "user", parts: functionResponses });
    }

    emitNavigation("Computer Use: stopped (max steps reached).\n");
  }
}
