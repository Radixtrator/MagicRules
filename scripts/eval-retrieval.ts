// Retrieval eval: does the right rule end up in the context we send the LLM?
// Usage: npm run eval            (RERANKER=<name> npm run eval to compare)
// Add a case whenever a real question gets a bad answer because of retrieval.

import path from "node:path";
import { buildIndex } from "../server/rules.ts";
import { retrieve } from "../server/retrieve.ts";
import { getReranker } from "../server/rerank.ts";

// expect: any of these groups (e.g. "702.19") or docs (e.g. "704.5f") counts as a hit.
const CASES: { q: string; expect: string[]; terms?: string[] }[] = [
  { q: "How does trample interact with deathtouch?", expect: ["702.2c", "702.19b"] },
  { q: "What happens when a creature has 0 toughness?", expect: ["704.5f"] },
  { q: "In what order do the layers apply?", expect: ["613.1"] },
  { q: "Can I respond to a spell being cast?", expect: ["117.3", "117.7", "601.2"] },
  { q: "What happens if my commander would go to the graveyard?", expect: ["903.9"] },
  { q: "How does ward work?", expect: ["702.21"] },
  { q: "What is the legend rule?", expect: ["704.5j"] },
  { q: "What happens to a token when it leaves the battlefield?", expect: ["111.7", "111.8", "704.5d"] },
  { q: "Do I lose if I have to draw from an empty library?", expect: ["704.5b", "121.4"] },
  { q: "When does a creature with first strike deal damage?", expect: ["702.7", "510.4"] },
  { q: "What does 702.19c say?", expect: ["702.19c"] },
  { q: "Can I target my own creature with hexproof?", expect: ["702.11"] },
  { q: "How does the mulligan work?", expect: ["103.5"] },
  { q: "Two replacement effects apply to the same event, who chooses the order?", expect: ["616.1"] },
  { q: "How does a spell resolve?", expect: ["608.2"] },
  { q: "What is the mana value of a split card?", expect: ["709.4", "202.3"] },
  { q: "Can I cast a sorcery during my opponent's turn?", expect: ["307.1"] },
  { q: "What are the steps of the combat phase?", expect: ["506.1"] },
  { q: "In multiplayer, what happens to a player's permanents when they leave the game?", expect: ["800.4a"] },
  { q: "What is summoning sickness?", expect: ["302.6"] },
  { q: "Does a creature with lifelink gain me life when it deals combat damage?", expect: ["702.15"] },
  { q: "Can I activate a planeswalker loyalty ability twice in one turn?", expect: ["606.3"] },
  { q: "What happens if all targets of a spell become illegal?", expect: ["608.2b"] },
  { q: "My blocker died before damage, does the attacker deal damage to me?", expect: ["509.1h", "506.4", "702.19e", "510.1c"] },
  { q: "Is this creature affected?", expect: ["702.19"], terms: ["Trample"] },
];

const index = buildIndex(path.join(process.cwd(), "rules.txt"));
const reranker = getReranker();
let hits = 0;
let rrSum = 0;
const t0 = performance.now();

for (const c of CASES) {
  const groups = await retrieve(index, c.q, { reranker, extraTerms: c.terms });
  const rank = groups.findIndex((g) =>
    c.expect.some((e) => g.group === e || g.docs.some((d) => d.id === e)),
  );
  if (rank >= 0) {
    hits++;
    rrSum += 1 / (rank + 1);
  }
  const mark = rank >= 0 ? `ok #${rank + 1}` : "MISS ";
  console.log(`${mark.padEnd(6)} ${c.q}`);
  if (rank !== 0) console.log(`         got: ${groups.map((g) => g.group).join(", ")}`);
}

const ms = (performance.now() - t0) / CASES.length;
console.log(
  `\nreranker=${reranker.name}  recall@10 ${hits}/${CASES.length}  MRR ${(rrSum / CASES.length).toFixed(3)}  ${ms.toFixed(1)} ms/query`,
);
