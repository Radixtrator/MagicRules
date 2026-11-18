// Hybrid lexical retrieval over the rules index:
//   1. explicit rule numbers in the question ("702.19c") are always included
//   2. rule titles / glossary terms named in the question ("deathtouch"),
//      following glossary "See rule ..." pointers
//   3. BM25 full-text search (FTS5, porter stemming)
//   4. full-text hits inside a section the question names ("state-based actions")
// Lists 2-4 are fused with weighted reciprocal-rank fusion, optionally reranked,
// then trimmed to a character budget for the LLM prompt.

import type { RuleDoc, RulesIndex } from "./rules.ts";
import type { Reranker } from "./rerank.ts";

export interface Candidate {
  group: string;
  title: string;
  section: string;
  kind: "rule" | "glossary";
  score: number;
  reasons: string[];
  /** Doc ids inside the group that matched the full-text query, best first. */
  hits: string[];
}

export interface RetrievedGroup {
  /** "702.19", a whole small section like "606", or "G:Term" for glossary. */
  group: string;
  title: string;
  section: string;
  kind: "rule" | "glossary";
  reasons: string[];
  docs: Pick<RuleDoc, "id" | "text">[];
}

export interface RetrieveOptions {
  /** Extra exact terms to look up, e.g. keywords from cards named in the question. */
  extraTerms?: string[];
  /** Rule ids to include, e.g. how a transformed card's characteristics work. */
  extraRules?: string[];
  /** Section titles to treat as named in the question, e.g. "double-faced cards" for a transforming card. */
  extraSections?: string[];
  reranker?: Reranker;
  /** Max rule groups (glossary entries are capped separately). */
  maxGroups?: number;
  maxGlossary?: number;
  maxChars?: number;
}

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could do does doing did for from has have how i if in into is it its " +
    "me my of on or so than that the their them then there these they this to was were what when where which " +
    "while who why will with would you your yes no not just about after before also any some only other " +
    "happen happens happened work works interact interaction interactions question rule rules mtg magic get gets " +
    "let lets say says said way still each another same use using used thing things"
  ).split(" "),
);

const RRF_K = 10;
// Terms appearing in more docs than this are too generic to be a strong signal.
const MAX_TERM_DF = 150;
// Sections at most this large are returned whole instead of one rule at a time.
const SMALL_SECTION_CHARS = 3000;
// Groups larger than this are trimmed to their heading plus matching subrules.
const BIG_GROUP_CHARS = 2500;

const RULE_REF_RE = /\b(\d{3}\.\d+[a-z]?)\b/g;
const SEE_RULE_RE = /rules? (\d{3})(?:\.(\d+[a-z]?))?\b/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const chars = (docs: { text: string }[]) => docs.reduce((n, d) => n + d.text.length, 0);

function tokenize(q: string): string[] {
  const words =
    q.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
  const out: string[] = [];
  for (const w of words) {
    const base = w.replace(/'s$/, "");
    // Short numbers matter in Magic ("0 toughness", "1 life"); short words don't.
    if ((base.length < 3 && !/^\d+$/.test(base)) || STOPWORDS.has(base) || out.includes(base)) continue;
    out.push(base);
  }
  return out;
}

interface Derived {
  terms: { term: string; id: string; re: RegExp; df: number }[];
  /** Multi-word section titles ("state-based actions") -> section number. */
  sectionTitles: [string, string][];
  sectionChars: Map<string, number>;
}
const derivedCache = new WeakMap<RulesIndex, Derived>();

function derived(index: RulesIndex): Derived {
  let d = derivedCache.get(index);
  if (d) return d;
  const dfStmt = index.db.prepare("SELECT count(*) AS n FROM rules_fts WHERE rules_fts MATCH ?");
  const terms = [...index.terms].map(([term, id]) => {
    let df = 0;
    try {
      df = Number((dfStmt.get(`text : "${term.replace(/"/g, '""')}"`) as { n: number }).n);
    } catch {
      /* terms with odd characters just get df 0 */
    }
    return { term, id, df, re: new RegExp(`(^|[^a-z0-9])${escapeRe(term)}(s|es|'s)?(?![a-z0-9])`, "i") };
  });
  const sectionTitles = new Map<string, string>();
  const sectionChars = new Map<string, number>();
  for (const [num, groups] of index.sections) {
    const first = index.docs.get(groups[0])!;
    const title = first.section.replace(/^\d+\. /, "").toLowerCase();
    if (title.includes(" ")) sectionTitles.set(title, num);
    let n = 0;
    for (const g of groups) for (const id of index.groups.get(g)!) n += index.docs.get(id)!.text.length;
    sectionChars.set(num, n);
  }
  d = { terms, sectionTitles: [...sectionTitles], sectionChars };
  derivedCache.set(index, d);
  return d;
}

const groupOf = (index: RulesIndex, id: string) => (index.groups.has(id) ? id : index.docs.get(id)?.group);

export async function retrieve(index: RulesIndex, question: string, opts: RetrieveOptions = {}) {
  const maxGroups = opts.maxGroups ?? 10;
  const maxGlossary = opts.maxGlossary ?? 3;
  const maxChars = opts.maxChars ?? 14000;
  const q = question.slice(0, 2000);
  const lowered = " " + q.toLowerCase() + " ";
  const { terms, sectionTitles, sectionChars } = derived(index);

  const cands = new Map<string, Candidate>();
  const bump = (group: string, weight: number, rank: number, reason: string) => {
    const first = index.docs.get(index.groups.get(group)?.[0] ?? "");
    if (!first) return;
    let c = cands.get(group);
    if (!c) {
      c = { group, title: first.title, section: first.section, kind: first.kind, score: 0, reasons: [], hits: [] };
      cands.set(group, c);
    }
    c.score += weight / (RRF_K + rank);
    if (!c.reasons.includes(reason)) c.reasons.push(reason);
  };

  // 1. Explicit rule numbers: always included, and the exact subrule is kept.
  const forced = new Set<string>();
  for (const m of q.matchAll(RULE_REF_RE)) {
    const g = groupOf(index, m[1]);
    if (!g) continue;
    forced.add(m[1]);
    bump(g, 100, forced.size - 1, "cited");
  }
  (opts.extraRules ?? []).forEach((id, i) => {
    const g = groupOf(index, id);
    if (!g) return;
    forced.add(id);
    bump(g, 3, i, "card type");
  });

  // 2. Titles and glossary terms named in the question (plus card keywords).
  const extra = new Set((opts.extraTerms ?? []).map((t) => t.toLowerCase()));
  const matched = terms
    .filter((t) => extra.has(t.term) || (t.df <= MAX_TERM_DF && t.re.test(lowered)))
    .sort((a, b) => b.term.length - a.term.length);
  const kept: typeof matched = [];
  for (const t of matched) {
    // "trample over planeswalkers" makes a separate "trample" match redundant.
    if (!extra.has(t.term) && kept.some((k) => k.term.includes(t.term))) continue;
    kept.push(t);
  }
  // Glossary entries mostly point elsewhere ("See rule 608.2b"): the target
  // rule is the strong signal, and the exact subrule it names is kept.
  const followGlossary = (doc: RuleDoc, weight: number, rank: number) => {
    for (const m of doc.text.matchAll(SEE_RULE_RE)) {
      if (m[2]) {
        const id = `${m[1]}.${m[2]}`;
        const g = groupOf(index, id);
        if (!g) continue;
        if (id !== g) forced.add(id);
        bump(g, weight, rank, `glossary "${doc.title}"`);
      } else {
        // Bare section ("See rule 613"): its first rule is usually the overview.
        const first = index.sections.get(m[1])?.[0];
        if (first) bump(first, weight * 0.67, rank, `glossary "${doc.title}"`);
      }
    }
  };
  kept.forEach((t, rank) => {
    const doc = index.docs.get(t.id)!;
    if (doc.kind === "rule") {
      bump(t.id, 3, rank, `names "${t.term}"`);
    } else {
      bump(t.id, 1, rank, `names "${t.term}"`);
      followGlossary(doc, 3, rank);
    }
  });

  // 3. BM25 full text.
  const tokens = tokenize(q);
  const ftsRows = tokens.length
    ? (index.db
        .prepare("SELECT id FROM rules_fts WHERE rules_fts MATCH ? ORDER BY bm25(rules_fts, 4.0, 0.5, 1.0) LIMIT 200")
        .all(tokens.map((t) => `"${t}"`).join(" OR ")) as { id: string }[])
    : [];
  const ftsGroups: string[] = [];
  for (const row of ftsRows) {
    const g = groupOf(index, row.id);
    if (g && !ftsGroups.includes(g)) ftsGroups.push(g);
  }
  ftsGroups.slice(0, 40).forEach((g, i) => bump(g, 1, i, "text match"));
  ftsGroups
    .filter((g) => g.startsWith("G:"))
    .slice(0, 5)
    .forEach((g) => followGlossary(index.docs.get(g)!, 1, ftsGroups.indexOf(g)));
  for (const row of ftsRows) {
    const c = cands.get(groupOf(index, row.id) ?? "");
    if (c && !c.hits.includes(row.id)) c.hits.push(row.id);
  }

  // 4. Full-text hits within a section the question names.
  const extraSections = (opts.extraSections ?? []).map((t) => t.toLowerCase());
  const named = new Set(
    sectionTitles.filter(([t]) => lowered.includes(t) || extraSections.includes(t)).map(([, num]) => num),
  );
  if (named.size) {
    ftsGroups
      .filter((g) => named.has(g.slice(0, 3)))
      .slice(0, 10)
      .forEach((g, i) => bump(g, 2, i, "in named section"));
  }

  let ranked = [...cands.values()].sort((a, b) => b.score - a.score).slice(0, 30);
  if (opts.reranker) ranked = await opts.reranker.rerank(q, ranked);

  // Budgeted context selection.
  const rules: RetrievedGroup[] = [];
  const glossary: RetrievedGroup[] = [];
  const usedSections = new Set<string>();
  let used = 0;
  for (const c of ranked) {
    if (c.kind === "glossary") {
      if (glossary.length < maxGlossary) {
        const d = index.docs.get(c.group)!;
        glossary.push({ ...c, docs: [{ id: d.id, text: d.text }] });
      }
      continue;
    }
    if (rules.length >= maxGroups) continue;
    const secNum = c.group.slice(0, 3);
    if (usedSections.has(secNum)) continue;

    let unit: RetrievedGroup;
    if ((sectionChars.get(secNum) ?? Infinity) <= SMALL_SECTION_CHARS) {
      // Small section: send all of it; neighbours are usually needed together.
      const ids = index.sections.get(secNum)!.flatMap((g) => index.groups.get(g)!);
      unit = {
        group: secNum,
        title: c.section.replace(/^\d+\. /, ""),
        section: c.section,
        kind: "rule",
        reasons: c.reasons,
        docs: ids.map((id) => ({ id, text: index.docs.get(id)!.text })),
      };
    } else {
      const ids = index.groups.get(c.group)!;
      let docs = ids.map((id) => index.docs.get(id)!);
      if (chars(docs) > BIG_GROUP_CHARS) {
        const keep = new Set([ids[0], ...c.hits.slice(0, 6), ...ids.filter((id) => forced.has(id))]);
        docs = docs.filter((d) => keep.has(d.id));
      }
      unit = { ...c, docs: docs.map((d) => ({ id: d.id, text: d.text })) };
    }

    const size = chars(unit.docs);
    if (used + size > maxChars) {
      if (rules.length > 0) continue;
      unit.docs = unit.docs.slice(0, 4); // always return something
    }
    used += chars(unit.docs);
    if (unit.group === secNum) usedSections.add(secNum);
    // A group already covered by an earlier whole-section unit is skipped above;
    // also avoid emitting the same group twice.
    if (rules.some((r) => r.group === unit.group)) continue;
    rules.push(unit);
  }
  return [...rules, ...glossary];
}

/** Formats retrieved groups for the LLM prompt. */
export function formatContext(groups: RetrievedGroup[]): string {
  return groups
    .map((g) => {
      if (g.kind === "glossary") return `[Glossary: ${g.title}]\n${g.docs[0].text}`;
      return g.docs.map((d) => `${d.id} ${d.text}`).join("\n");
    })
    .join("\n\n");
}
