import "./server/env.ts";
import express from "express";
import type { Request, Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { buildIndex } from "./server/rules.ts";
import { retrieve, formatContext } from "./server/retrieve.ts";
import { getReranker } from "./server/rerank.ts";
import { lookupCards, formatCards, cardHints } from "./server/cards.ts";
import { loadCardNames, setRulesVocabulary } from "./server/cardNames.ts";
import { llmAvailable, streamAnswer, MODEL } from "./server/llm.ts";

const PORT = Number(process.env.PORT) || 3000;
const MAX_QUESTION_CHARS = 1000;
// Generated answers per client IP per 10 minutes. Search-only requests are free and unlimited.
const ANSWER_LIMIT = Number(process.env.ANSWER_LIMIT_PER_10MIN) || 30;

const rulesPath = path.join(process.cwd(), "rules.txt");
if (!fs.existsSync(rulesPath)) {
  console.error("rules.txt not found. Download the Comprehensive Rules (TXT) from https://magic.wizards.com/rules");
  process.exit(1);
}
const t0 = performance.now();
const index = buildIndex(rulesPath);
const reranker = getReranker();
console.log(
  `Indexed ${index.docs.size} rules and glossary entries (effective ${index.effectiveDate}) in ${Math.round(performance.now() - t0)} ms; reranker=${reranker.name}`,
);
setRulesVocabulary(index);
// Fast from the disk cache; only the first run (or a weekly refresh) fetches from Scryfall.
const cardNameCount = await loadCardNames();
if (cardNameCount) console.log(`Loaded ${cardNameCount} card names for automatic card detection`);
if (!llmAvailable()) console.warn("GEMINI_API_KEY is not set: only rule search is available.");

// Small in-memory caches: repeated questions cost nothing.
const answerCache = new Map<string, string>();
const ANSWER_CACHE_MAX = 500;
const hits = new Map<string, number[]>();

function rateLimited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= ANSWER_LIMIT) return true;
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10000) hits.clear();
  return false;
}

// Tells the user why an answer failed without leaking provider details.
function llmErrorMessage(err: any): string {
  const status = Number(err?.status);
  const base = "The matching rules are shown below.";
  if (status === 401 || status === 403) return `The Gemini API key was rejected. ${base}`;
  if (status === 402) return `The Gemini account is out of credits (billing). ${base}`;
  if (status === 429) return `Gemini rate limit or quota reached; try again shortly. ${base}`;
  if (status >= 500) return `Gemini is having problems right now; try again shortly. ${base}`;
  return `Something went wrong generating the answer. ${base}`;
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ rules: index.docs.size, effectiveDate: index.effectiveDate, llm: llmAvailable(), model: MODEL });
});

app.get("/api/rule/:id", (req, res) => {
  const id = req.params.id;
  const group = index.groups.has(id) ? id : index.docs.get(id)?.group;
  if (!group) return res.status(404).json({ error: "Unknown rule" });
  const docs = index.groups.get(group)!.map((d) => index.docs.get(d)!);
  res.json({ group, title: docs[0].title, section: docs[0].section, docs: docs.map(({ id, text }) => ({ id, text })) });
});

// Streams newline-delimited JSON: one "context" event (rules + cards, sent as soon
// as retrieval finishes), then "delta" text events, then "done" or "error".
app.post("/api/ask", async (req: Request, res: Response) => {
  const question = String(req.body?.question ?? "").trim().slice(0, MAX_QUESTION_CHARS);
  const wantAnswer = req.body?.answer !== false;
  if (!question) return res.status(400).json({ error: "Empty question" });

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (event: object) => res.write(JSON.stringify(event) + "\n");
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    const { cards, notFound } = await lookupCards(question);
    const hints = cardHints(cards);
    const rules = await retrieve(index, question, { reranker, extraTerms: hints.terms, extraSections: hints.sections, extraRules: hints.rules });
    send({ type: "context", rules, cards, notFound, effectiveDate: index.effectiveDate });

    if (!wantAnswer) return send({ type: "done" });
    if (!llmAvailable()) return send({ type: "error", message: "No GEMINI_API_KEY configured; showing matching rules only." });

    const cacheKey = question.toLowerCase().replace(/\s+/g, " ");
    const cached = answerCache.get(cacheKey);
    if (cached) {
      send({ type: "delta", text: cached });
      return send({ type: "done", cached: true });
    }
    if (rateLimited(req.ip ?? "unknown")) {
      return send({ type: "error", message: "Answer limit reached for now. The matching rules are shown below." });
    }

    let full = "";
    for await (const text of streamAnswer(question, formatContext(rules), formatCards(cards), abort.signal)) {
      full += text;
      send({ type: "delta", text });
    }
    if (full) {
      if (answerCache.size >= ANSWER_CACHE_MAX) answerCache.delete(answerCache.keys().next().value!);
      answerCache.set(cacheKey, full);
    }
    send({ type: "done" });
  } catch (err: any) {
    if (!abort.signal.aborted) {
      console.error("ask failed:", err);
      send({ type: "error", message: llmErrorMessage(err) });
    }
  } finally {
    res.end();
  }
});

if (process.env.NODE_ENV !== "production") {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  const distPath = path.join(process.cwd(), "dist");
  app.use(express.static(distPath));
  app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
}

app.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://localhost:${PORT}`));
