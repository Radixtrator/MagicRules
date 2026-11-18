// Detects card names written in plain text ("if I transform sephiroth fabled soldier...")
// using Scryfall's catalog of every card name (~35k names, ~600 KB), cached on disk.

import fs from "node:fs";
import path from "node:path";
import type { RulesIndex } from "./rules.ts";

const CATALOG_URL = "https://api.scryfall.com/catalog/card-names";
const CACHE_FILE = path.join(process.cwd(), ".cache", "card-names.json");
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HEADERS = { "User-Agent": "MTGRulesOracle/1.0", Accept: "application/json" };

interface NameEntry {
  tokens: string[];
  /** Name to look up on Scryfall (a single face for double-faced cards). */
  name: string;
  /** Matched by the part before the comma ("Ragavan"). */
  short?: boolean;
}

let byFirstToken = new Map<string, NameEntry[]>();
let commonWords = new Set<string>();

/** Lowercase, strip accents and punctuation: "Sephiroth, Fabled SOLDIER" -> ["sephiroth","fabled","soldier"]. */
export function normalizeTokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function buildMatcher(names: string[]) {
  const map = new Map<string, NameEntry[]>();
  for (const full of names) {
    // Index each face of a double-faced / split card separately.
    for (const face of full.split(" // ")) {
      const tokens = normalizeTokens(face);
      if (!tokens.length) continue;
      const list = map.get(tokens[0]) ?? [];
      list.push({ tokens, name: face });
      map.set(tokens[0], list);
    }
  }
  // Short names for legends: "Ragavan" -> "Ragavan, Nimble Pilferer", only when
  // exactly one card uses that prefix and no card is named just that.
  const prefixes = new Map<string, string[]>();
  for (const full of names) {
    for (const face of full.split(" // ")) {
      const comma = face.indexOf(", ");
      if (comma > 0) {
        const key = normalizeTokens(face.slice(0, comma)).join(" ");
        prefixes.set(key, [...(prefixes.get(key) ?? []), face]);
      }
    }
  }
  for (const [key, faces] of prefixes) {
    const tokens = key.split(" ");
    const list = map.get(tokens[0]) ?? [];
    if (faces.length !== 1 || list.some((e) => e.tokens.join(" ") === key)) continue;
    list.push({ tokens, name: faces[0], short: true });
    map.set(tokens[0], list);
  }
  for (const list of map.values()) list.sort((a, b) => b.tokens.length - a.tokens.length);
  byFirstToken = map;
}

/**
 * Words that are everyday rules vocabulary ("island", "counter", "rest").
 * Card names made only of these need capitalization to count as a mention,
 * so "the rest of the turn" doesn't look up a card.
 */
export function setRulesVocabulary(index: RulesIndex) {
  const df = new Map<string, number>();
  for (const d of index.docs.values()) {
    for (const t of new Set(normalizeTokens(d.text))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  commonWords = new Set([...df].filter(([, n]) => n >= 8).map(([t]) => t));
}

/** Loads the name catalog from the disk cache, refreshing it from Scryfall weekly. */
export async function loadCardNames(): Promise<number> {
  let names: string[] | null = null;
  try {
    const stat = fs.statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs < MAX_AGE_MS) names = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    /* no cache yet */
  }
  if (!names) {
    try {
      const res = await fetch(CATALOG_URL, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Scryfall ${res.status}`);
      names = ((await res.json()) as { data: string[] }).data;
      try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(names));
      } catch {
        /* read-only filesystem (e.g. some hosts): keep the names in memory only */
      }
    } catch (err) {
      // Fall back to a stale cache if there is one; otherwise only [[Name]] works.
      try {
        names = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      } catch {
        console.warn("Card name catalog unavailable; only [[Card Name]] lookups will work.", err);
        return 0;
      }
    }
  }
  buildMatcher(names!);
  return names!.length;
}

/** Card names mentioned in plain text, longest match first, in question order. */
export function detectCardNames(question: string, max = 4): string[] {
  if (!byFirstToken.size) return [];
  // Keep the original words alongside normalized tokens to check capitalization.
  const words = question.replace(/\[\[[^\]]*\]\]/g, " ").match(/[\p{L}\p{N}'’]+/gu) ?? [];
  const toks: { norm: string; capital: boolean; sentenceStart: boolean }[] = [];
  let prevEnd = true;
  let pos = 0;
  const text = question;
  for (const w of words) {
    const idx = text.indexOf(w, pos);
    const between = text.slice(pos, idx);
    if (/[.!?]/.test(between)) prevEnd = true;
    pos = idx + w.length;
    for (const norm of normalizeTokens(w)) {
      toks.push({ norm, capital: /^\p{Lu}/u.test(w), sentenceStart: prevEnd });
      prevEnd = false;
    }
  }

  const found: string[] = [];
  for (let i = 0; i < toks.length && found.length < max; ) {
    const cands = byFirstToken.get(toks[i].norm) ?? [];
    const hit = cands.find(
      (c) => c.tokens.length <= toks.length - i && c.tokens.every((t, k) => toks[i + k].norm === t) && plausible(c, toks.slice(i, i + c.tokens.length)),
    );
    if (hit) {
      if (!found.includes(hit.name)) found.push(hit.name);
      i += hit.tokens.length;
    } else i++;
  }
  return found;
}

function plausible(c: NameEntry, span: { norm: string; capital: boolean; sentenceStart: boolean }[]) {
  const distinctive = c.tokens.some((t) => !commonWords.has(t) && !/^\d+$/.test(t));
  const capitalized = span.some((s) => s.capital && !s.sentenceStart);
  // A short legend name ("ragavan") is distinctive enough on its own; other one-word
  // names ("Counterspell") must be capitalized mid-sentence.
  if (c.tokens.length === 1) return distinctive && c.tokens[0].length >= 4 && (capitalized || !!c.short);
  return distinctive || capitalized;
}
