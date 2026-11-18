/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ExternalLink, Loader2, Search } from "lucide-react";

interface RuleDoc {
  id: string;
  text: string;
}
interface RuleGroup {
  group: string;
  title: string;
  section: string;
  kind: "rule" | "glossary";
  reasons: string[];
  docs: RuleDoc[];
}
interface Card {
  name: string;
  manaCost: string;
  typeLine: string;
  oracleText: string;
  rulings: { date: string; text: string }[];
  scryfallUri: string;
}
interface Entry {
  id: number;
  question: string;
  status: "searching" | "answering" | "done";
  answer: string;
  error?: string;
  cached?: boolean;
  rules: RuleGroup[];
  cards: Card[];
  notFound: string[];
  open: string[];
}
interface Health {
  rules: number;
  effectiveDate: string;
  llm: boolean;
}

const EXAMPLES = [
  "How does trample interact with deathtouch?",
  "In what order do the layers apply?",
  "What happens if all targets of a spell become illegal?",
  "Can [[Lightning Bolt]] target a planeswalker?",
];

const RULE_REF = /\b\d{3}\.\d+[a-z]?\b/;

function loadPref(): boolean {
  try {
    return localStorage.getItem("aiAnswer") !== "off";
  } catch {
    return true;
  }
}

export default function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [aiAnswer, setAiAnswer] = useState(loadPref);
  const nextId = useRef(1);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
    inputRef.current?.focus();
  }, []);

  const busy = entries.some((e) => e.status !== "done");
  const canAnswer = aiAnswer && health?.llm !== false;

  const update = (id: number, fn: (e: Entry) => Entry) =>
    setEntries((list) => list.map((e) => (e.id === id ? fn(e) : e)));

  async function ask(question: string) {
    question = question.trim();
    if (!question || busy) return;
    const id = nextId.current++;
    setEntries((list) => [
      { id, question, status: "searching", answer: "", rules: [], cards: [], notFound: [], open: [] },
      ...list,
    ]);
    setInput("");

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, answer: canAnswer }),
      });
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === "context") {
            update(id, (e) => ({
              ...e,
              status: canAnswer ? "answering" : "done",
              rules: ev.rules,
              cards: ev.cards,
              notFound: ev.notFound,
              // Without an AI answer, show the top rule straight away.
              open: canAnswer ? [] : ev.rules.slice(0, 1).map((g: RuleGroup) => g.group),
            }));
          } else if (ev.type === "delta") {
            update(id, (e) => ({ ...e, answer: e.answer + ev.text }));
          } else if (ev.type === "error") {
            update(id, (e) => ({ ...e, error: ev.message }));
          } else if (ev.type === "done") {
            update(id, (e) => ({ ...e, cached: ev.cached }));
          }
        }
      }
    } catch (err) {
      update(id, (e) => ({ ...e, error: err instanceof Error ? err.message : "Request failed" }));
    } finally {
      update(id, (e) => ({ ...e, status: "done" }));
    }
  }

  // Opens a cited rule in an entry's sources, fetching it if retrieval didn't include it.
  async function openRule(entry: Entry, ref: string) {
    const found = entry.rules.find((g) => g.group === ref || g.docs.some((d) => d.id === ref));
    // After React renders the opened rule (setTimeout also runs in background tabs, unlike rAF).
    const scroll = (group: string) =>
      setTimeout(
        () => document.getElementById(`src-${entry.id}-${group}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
        50,
      );
    if (found) {
      update(entry.id, (e) => ({ ...e, open: e.open.includes(found.group) ? e.open : [...e.open, found.group] }));
      return scroll(found.group);
    }
    const res = await fetch(`/api/rule/${encodeURIComponent(ref)}`);
    if (!res.ok) return;
    const g = await res.json();
    const group: RuleGroup = { ...g, kind: "rule", reasons: ["cited in answer"] };
    update(entry.id, (e) => ({ ...e, rules: [...e.rules, group], open: [...e.open, group.group] }));
    scroll(group.group);
  }

  function setPref(v: boolean) {
    setAiAnswer(v);
    try {
      localStorage.setItem("aiAnswer", v ? "on" : "off");
    } catch {
      /* preference just won't persist */
    }
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <header className="sticky top-0 z-10 border-b border-stone-200 bg-stone-50/90 backdrop-blur dark:border-stone-800 dark:bg-stone-950/90">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h1 className="text-lg font-semibold tracking-tight">MTG Rules Oracle</h1>
            <span className="text-xs text-stone-500">
              {health ? `Comprehensive Rules · ${health.effectiveDate}` : ""}
            </span>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              ask(input);
            }}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              maxLength={1000}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  ask(input);
                }
              }}
              placeholder="Ask about a rule or a card…"
              className="min-h-11 flex-1 resize-none rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-base outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:focus:border-stone-400"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              aria-label="Ask"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-stone-900 text-white disabled:opacity-30 dark:bg-stone-100 dark:text-stone-900"
            >
              {busy ? <Loader2 size={18} className="animate-spin" /> : <Search size={18} />}
            </button>
          </form>
          <label className="mt-2 flex w-fit items-center gap-2 text-xs text-stone-600 dark:text-stone-400">
            <input
              type="checkbox"
              checked={canAnswer}
              disabled={health?.llm === false}
              onChange={(e) => setPref(e.target.checked)}
            />
            {health?.llm === false ? "AI answers unavailable (no API key): showing rules only" : "Write an AI answer (off = matching rules only, instant and free)"}
          </label>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {entries.length === 0 && (
          <div className="space-y-3 py-10 text-center">
            <p className="text-sm text-stone-500">Try one of these:</p>
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((q) => (
                <button
                  key={q}
                  onClick={() => ask(q)}
                  className="rounded-full border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((entry) => (
          <article key={entry.id} className="space-y-4 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
            <h2 className="font-medium">{entry.question}</h2>

            {entry.status === "searching" && <Pending label="Searching the rules…" />}
            {entry.status === "answering" && !entry.answer && <Pending label="Writing answer…" />}
            {entry.answer && (
              <div className="space-y-2 leading-relaxed">
                <Formatted text={entry.answer} onRule={(r) => openRule(entry, r)} />
                {entry.cached && <p className="text-xs text-stone-500">Cached answer</p>}
              </div>
            )}
            {entry.error && <p className="text-sm text-amber-700 dark:text-amber-400">{entry.error}</p>}
            {entry.notFound.length > 0 && (
              <p className="text-sm text-amber-700 dark:text-amber-400">Card not found: {entry.notFound.join(", ")}</p>
            )}

            {entry.cards.map((c) => (
              <CardPanel key={c.name} card={c} />
            ))}

            {entry.rules.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">Rules found</h3>
                <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                  {entry.rules.map((g) => {
                    const open = entry.open.includes(g.group);
                    return (
                      <li key={g.group} id={`src-${entry.id}-${g.group}`}>
                        <button
                          onClick={() =>
                            update(entry.id, (e) => ({
                              ...e,
                              open: open ? e.open.filter((x) => x !== g.group) : [...e.open, g.group],
                            }))
                          }
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-stone-50 dark:hover:bg-stone-800/50"
                        >
                          <span className="shrink-0 font-mono text-xs text-stone-500">
                            {g.kind === "glossary" ? "Glossary" : g.group}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{groupLabel(g)}</span>
                          <ChevronDown size={16} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
                        </button>
                        {open && (
                          <div className="space-y-2 px-3 pb-3 text-sm leading-relaxed">
                            {g.docs.map((d) => (
                              <RuleText key={d.id} doc={d} glossary={g.kind === "glossary"} onRule={(r) => openRule(entry, r)} />
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </article>
        ))}
      </main>
    </div>
  );
}

function groupLabel(g: RuleGroup) {
  if (g.title) return g.title;
  const first = g.docs[0]?.text ?? "";
  return first.length > 80 ? first.slice(0, 80) + "…" : first;
}

function Pending({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-stone-500">
      <Loader2 size={14} className="animate-spin" /> {label}
    </p>
  );
}

// Rule numbers become links; **bold** is bolded. Nothing else is interpreted.
function Inline({ text, onRule }: { text: string; onRule: (ref: string) => void }) {
  const parts = text.split(new RegExp(`(\\*\\*[^*]+\\*\\*|${RULE_REF.source})`, "g"));
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (RULE_REF.test(p) && p.match(RULE_REF)![0] === p)
          return (
            <button
              key={i}
              onClick={() => onRule(p)}
              className="font-mono text-[0.9em] text-sky-700 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-sky-400"
            >
              {p}
            </button>
          );
        return p;
      })}
    </>
  );
}

function Formatted({ text, onRule }: { text: string; onRule: (ref: string) => void }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*] /.test(l)))
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((l, j) => (
                <li key={j}>
                  <Inline text={l.replace(/^\s*[-*] /, "")} onRule={onRule} />
                </li>
              ))}
            </ul>
          );
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {j > 0 && <br />}
                <Inline text={l} onRule={onRule} />
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}

function RuleText({ doc, glossary, onRule }: { doc: RuleDoc; glossary: boolean; onRule: (ref: string) => void }) {
  const [main, ...rest] = doc.text.split("\n");
  return (
    <div>
      <p>
        {!glossary && <span className="mr-1.5 font-mono text-xs text-stone-500">{doc.id}</span>}
        <Inline text={main} onRule={onRule} />
      </p>
      {rest.map((l, i) => (
        <p key={i} className={l.startsWith("Example:") ? "mt-1 border-l-2 border-stone-200 pl-2 text-stone-600 italic dark:border-stone-700 dark:text-stone-400" : ""}>
          <Inline text={l} onRule={onRule} />
        </p>
      ))}
    </div>
  );
}

function CardPanel({ card }: { card: Card }) {
  const [showRulings, setShowRulings] = useState(false);
  return (
    <div className="rounded-lg border border-stone-200 p-3 text-sm dark:border-stone-800">
      <div className="flex items-baseline justify-between gap-2">
        <a href={card.scryfallUri} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-medium hover:underline">
          {card.name} <ExternalLink size={12} />
        </a>
        <span className="font-mono text-xs text-stone-500">{card.manaCost}</span>
      </div>
      <p className="text-xs text-stone-500">{card.typeLine}</p>
      <p className="mt-2 whitespace-pre-line">{card.oracleText}</p>
      {card.rulings.length > 0 && (
        <div className="mt-2">
          <button onClick={() => setShowRulings(!showRulings)} className="text-xs text-sky-700 hover:underline dark:text-sky-400">
            {showRulings ? "Hide" : "Show"} {card.rulings.length} official ruling{card.rulings.length > 1 ? "s" : ""}
          </button>
          {showRulings && (
            <ul className="mt-2 space-y-2">
              {card.rulings.map((r, i) => (
                <li key={i} className="text-stone-700 dark:text-stone-300">
                  <span className="mr-1.5 font-mono text-xs text-stone-500">{r.date}</span>
                  {r.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
