// Parses the Comprehensive Rules text into rule-level chunks and indexes them
// in an in-memory SQLite FTS5 table (node:sqlite, no native dependency).

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface RuleDoc {
  /** "702.19c", "702.19", or "G:Trample" for glossary entries. */
  id: string;
  /** Group the doc belongs to: "702.19" for "702.19c"; same as id for glossary. */
  group: string;
  /** Group title when the group heading is a title ("Trample"), else "". */
  title: string;
  /** Three-digit section heading ("702. Keyword Abilities"). */
  section: string;
  text: string;
  kind: "rule" | "glossary";
}

export interface RulesIndex {
  docs: Map<string, RuleDoc>;
  /** Doc ids per group, in document order. */
  groups: Map<string, string[]>;
  /** Group ids per three-digit section ("606"), in document order. */
  sections: Map<string, string[]>;
  /** Lower-cased titles and glossary terms -> the group or glossary id they name. */
  terms: Map<string, string>;
  db: DatabaseSync;
  effectiveDate: string;
}

const SECTION_RE = /^(\d{3})\. (.+)$/; // "702. Keyword Abilities"
const RULE_RE = /^(\d{3}\.\d+)\. (.*)$/; // "702.19. Trample" / "100.1. These Magic rules..."
const SUBRULE_RE = /^(\d{3}\.\d+[a-z])\.? (.*)$/; // "702.19a Trample is..."

// A group heading counts as a title when it's short and isn't a sentence.
function looksLikeTitle(text: string): boolean {
  return text.length <= 60 && !/[.:]$/.test(text);
}

export function parseRules(raw: string): { docs: RuleDoc[]; effectiveDate: string } {
  const lines = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const effectiveDate = raw.match(/effective as of ([A-Z][a-z]+ \d{1,2}, \d{4})/)?.[1] ?? "";

  // The table of contents repeats "100. General", "Glossary" and "Credits";
  // the real body starts at the second occurrence of each.
  const nth = (pred: (l: string) => boolean, n: number) => {
    let seen = 0;
    for (let i = 0; i < lines.length; i++) if (pred(lines[i].trim()) && ++seen === n) return i;
    return -1;
  };
  const bodyStart = nth((l) => l === "100. General", 2);
  const glossaryStart = nth((l) => l === "Glossary", 2);
  const creditsStart = nth((l) => l === "Credits", 2);
  if (bodyStart < 0 || glossaryStart < 0) throw new Error("Unrecognized rules.txt layout");

  const docs: RuleDoc[] = [];
  let section = "";
  let groupTitle = "";
  let current: RuleDoc | null = null;

  for (let i = bodyStart; i < glossaryStart; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(SUBRULE_RE))) {
      current = { id: m[1], group: m[1].slice(0, -1), title: groupTitle, section, text: m[2], kind: "rule" };
      docs.push(current);
    } else if ((m = line.match(RULE_RE))) {
      groupTitle = looksLikeTitle(m[2]) ? m[2] : "";
      current = { id: m[1], group: m[1], title: groupTitle, section, text: m[2], kind: "rule" };
      docs.push(current);
    } else if ((m = line.match(SECTION_RE))) {
      section = `${m[1]}. ${m[2]}`;
      groupTitle = "";
      current = null;
    } else if (current) {
      // "Example:" lines and other continuations belong to the previous rule.
      current.text += "\n" + line;
    }
  }

  // Glossary: blank-line separated blocks, first line is the term.
  const end = creditsStart > glossaryStart ? creditsStart : lines.length;
  let block: string[] = [];
  const flush = () => {
    if (block.length >= 2) {
      const term = block[0];
      docs.push({ id: `G:${term}`, group: `G:${term}`, title: term, section: "Glossary", text: block.slice(1).join("\n"), kind: "glossary" });
    }
    block = [];
  };
  for (let i = glossaryStart + 1; i < end; i++) {
    const line = lines[i].trim();
    if (line) block.push(line);
    else flush();
  }
  flush();

  return { docs, effectiveDate };
}

// Titles that are too generic to treat as a strong signal when they appear in a question.
const GENERIC_TITLES = new Set(["general", "summary", "other", "cards", "players", "objects", "numbers"]);

export function buildIndex(rulesPath: string): RulesIndex {
  const { docs, effectiveDate } = parseRules(fs.readFileSync(rulesPath, "utf-8"));

  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE VIRTUAL TABLE rules_fts USING fts5(
    id UNINDEXED, title, section, text,
    tokenize = 'porter unicode61 remove_diacritics 2'
  )`);
  const insert = db.prepare("INSERT INTO rules_fts (id, title, section, text) VALUES (?, ?, ?, ?)");

  const docMap = new Map<string, RuleDoc>();
  const groups = new Map<string, string[]>();
  const sections = new Map<string, string[]>();
  const terms = new Map<string, string>();

  db.exec("BEGIN");
  for (const d of docs) {
    docMap.set(d.id, d);
    const g = groups.get(d.group) ?? [];
    g.push(d.id);
    groups.set(d.group, g);
    if (d.kind === "rule" && d.id === d.group) {
      const num = d.section.slice(0, 3);
      const s = sections.get(num) ?? [];
      s.push(d.group);
      sections.set(num, s);
    }
    insert.run(d.id, d.title, d.section.replace(/^\d+\. /, ""), d.text);

    if (d.title && d.id === d.group) {
      const key = d.title.toLowerCase();
      // Glossary single words need 5+ letters ("Deal", "Draw" are too common to be a signal).
      const minLen = d.kind === "glossary" && !key.includes(" ") ? 5 : 4;
      if (key.length >= minLen && !GENERIC_TITLES.has(key)) {
        // Rule titles win over glossary terms of the same name.
        if (d.kind === "rule" || !terms.has(key)) terms.set(key, d.id);
      }
    }
  }
  db.exec("COMMIT");

  return { docs: docMap, groups, sections, terms, db, effectiveDate };
}
