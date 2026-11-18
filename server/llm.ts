// Server-side answer generation with Gemini (the API key never reaches the browser).

import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export const MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const THINKING = (process.env.GEMINI_THINKING || "low").toUpperCase() as keyof typeof ThinkingLevel;

const SYSTEM = `You are an expert Magic: The Gathering rules adviser, answering like an experienced judge.
Answer the player's question using ONLY the Comprehensive Rules excerpts and card information provided.

- Start with the direct answer in one or two sentences.
- Then explain the reasoning briefly, citing rule numbers inline in parentheses, e.g. (702.19b). Only cite rule numbers that appear in the excerpts.
- When an official card ruling addresses the question directly, rely on it and say so.
- If the excerpts don't settle the question, say so plainly and name what is missing. Do not fill gaps from memory.
- Keep it under about 200 words. Plain text with short paragraphs; "- " bullet lists and **bold** are fine; no headings.`;

let client: GoogleGenAI | null = null;
export function llmAvailable() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export async function* streamAnswer(question: string, rulesContext: string, cardsContext: string, signal?: AbortSignal) {
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const prompt =
    `Comprehensive Rules excerpts:\n${rulesContext || "(none found)"}\n\n` +
    (cardsContext ? `Cards mentioned:\n${cardsContext}\n\n` : "") +
    `Question: ${question}`;

  const stream = await client.models.generateContentStream({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM,
      thinkingConfig: ThinkingLevel[THINKING] ? { thinkingLevel: ThinkingLevel[THINKING] } : undefined,
      maxOutputTokens: 2048,
      abortSignal: signal,
    },
  });

  let usage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined;
  for await (const chunk of stream) {
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    if (chunk.text) yield chunk.text;
  }
  if (usage) {
    console.log(
      `[llm] ${MODEL} in=${usage.promptTokenCount ?? 0} out=${usage.candidatesTokenCount ?? 0} thinking=${usage.thoughtsTokenCount ?? 0}`,
    );
  }
}
