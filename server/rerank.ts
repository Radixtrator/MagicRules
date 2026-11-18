// Optional reranking step between candidate retrieval and context selection.
//
// Retrieval produces ~30 candidate rule groups cheaply (FTS + exact term
// matches). A reranker can reorder (or drop) them before the context budget is
// applied. This is the place to plug in a model such as a cross-encoder or a
// structured-decision model (e.g. TypeSafe's Jev): give it the question plus
// the candidates as choices and keep the ones it scores as relevant.
//
// Select with RERANKER=<name> in the environment. Run `npm run eval` before and
// after enabling one to check it actually helps.

import type { Candidate } from "./retrieve.ts";

export interface Reranker {
  name: string;
  rerank(question: string, candidates: Candidate[]): Promise<Candidate[]>;
}

const identity: Reranker = {
  name: "none",
  async rerank(_question, candidates) {
    return candidates;
  },
};

const registry: Record<string, Reranker> = {
  none: identity,
};

export function getReranker(name = process.env.RERANKER || "none"): Reranker {
  const r = registry[name];
  if (!r) {
    console.warn(`Unknown RERANKER "${name}", falling back to "none". Known: ${Object.keys(registry).join(", ")}`);
    return identity;
  }
  return r;
}
