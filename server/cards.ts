// Card lookup via Scryfall, with official rulings, for cards written as
// [[Card Name]] or mentioned by name in plain text (see cardNames.ts).
// Results are cached in memory so repeat questions don't hit the API.

import { detectCardNames } from "./cardNames.ts";

export interface CardInfo {
  name: string;
  manaCost: string;
  typeLine: string;
  oracleText: string;
  keywords: string[];
  /** Scryfall layout: "normal", "transform", "split", "adventure", ... */
  layout: string;
  rulings: { date: string; text: string }[];
  scryfallUri: string;
  imageUri?: string;
}

const API = "https://api.scryfall.com";
// Scryfall asks API clients to send a descriptive User-Agent and an Accept header.
const HEADERS = { "User-Agent": "MTGRulesOracle/1.0", Accept: "application/json" };
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1000;
const MAX_CARDS_PER_QUESTION = 4;

const cache = new Map<string, { at: number; card: CardInfo | null }>();

/** Card names written as [[Name]] in the question. */
export function extractCardNames(question: string): string[] {
  const names: string[] = [];
  for (const m of question.matchAll(/\[\[([^\[\]]{2,80})\]\]/g)) {
    const n = m[1].trim();
    if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
  }
  return names.slice(0, MAX_CARDS_PER_QUESTION);
}

async function getJson(url: string): Promise<any | null> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(5000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Scryfall ${res.status}`);
  return res.json();
}

async function fetchCard(name: string): Promise<CardInfo | null> {
  const card = await getJson(`${API}/cards/named?fuzzy=${encodeURIComponent(name)}`);
  if (!card) return null;
  const faces: any[] = card.card_faces ?? [];
  const oracleText =
    card.oracle_text ??
    faces
      .map((f) => `${f.name} ${f.mana_cost || "(no mana cost)"}\n${f.type_line ?? ""}\n${f.oracle_text ?? ""}`)
      .join("\n//\n");
  let rulings: CardInfo["rulings"] = [];
  try {
    const r = card.rulings_uri ? await getJson(card.rulings_uri) : null;
    rulings = (r?.data ?? []).map((x: any) => ({ date: x.published_at, text: x.comment }));
  } catch {
    /* card text is still useful without rulings */
  }
  return {
    name: card.name,
    manaCost: card.mana_cost ?? faces.map((f) => f.mana_cost).filter(Boolean).join(" // "),
    typeLine: card.type_line ?? "",
    oracleText,
    keywords: card.keywords ?? [],
    layout: card.layout ?? "normal",
    rulings,
    scryfallUri: card.scryfall_uri,
    imageUri: card.image_uris?.normal ?? faces[0]?.image_uris?.normal,
  };
}

export async function lookupCard(name: string): Promise<CardInfo | null> {
  const key = name.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.card;
  const card = await fetchCard(name);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), card });
  return card;
}

/** Looks up every card in the question; failures are reported, not thrown. */
export async function lookupCards(question: string) {
  const names = extractCardNames(question);
  for (const n of detectCardNames(question)) {
    if (names.length >= MAX_CARDS_PER_QUESTION) break;
    if (!names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
  }
  const results = await Promise.allSettled(names.map(lookupCard));
  const cards: CardInfo[] = [];
  const notFound: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) cards.push(r.value);
    else notFound.push(names[i]);
  });
  return { cards, notFound };
}

// Card layouts with their own rules section; naming the section steers retrieval there.
const LAYOUT_SECTIONS: Record<string, string> = {
  transform: "double-faced cards",
  modal_dfc: "double-faced cards",
  meld: "double-faced cards",
  reversible_card: "double-faced cards",
  split: "split cards",
  flip: "flip cards",
  leveler: "leveler cards",
  saga: "saga cards",
  adventure: "adventurer cards",
  class: "class cards",
  prototype: "prototype cards",
  case: "case cards",
};

// The rules saying which characteristics each kind of multi-part card has. These
// rarely share words with the question ("devotion of my transformed X"), so pin them.
const LAYOUT_RULES: Record<string, string[]> = {
  transform: ["712.8a", "712.8d", "712.8e"],
  modal_dfc: ["712.8a", "712.8f"],
  meld: ["712.8g"],
  split: ["709.3b", "709.4b"],
  flip: ["710.1c"],
  adventure: ["715.3b"],
  prototype: ["718.3b"],
};

/** Retrieval hints from the cards: keyword abilities, layout sections, and layout rules. */
export function cardHints(cards: CardInfo[]) {
  return {
    terms: cards.flatMap((c) => c.keywords),
    sections: [...new Set(cards.map((c) => LAYOUT_SECTIONS[c.layout]).filter(Boolean))],
    rules: [...new Set(cards.flatMap((c) => LAYOUT_RULES[c.layout] ?? []))],
  };
}

export function formatCards(cards: CardInfo[]): string {
  return cards
    .map((c) => {
      const rulings = c.rulings.length
        ? "\nOfficial rulings:\n" + c.rulings.map((r) => `- (${r.date}) ${r.text}`).join("\n")
        : "";
      return `${c.name} ${c.manaCost}\n${c.typeLine}\n${c.oracleText}${rulings}`;
    })
    .join("\n\n");
}
