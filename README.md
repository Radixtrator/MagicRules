# MTG Rules Oracle

Ask a Magic: The Gathering rules question. The app finds the relevant Comprehensive Rules (and any cards named as `[[Card Name]]`, with their official rulings) and has a small model write a short answer that cites rule numbers.

## Run locally

Requires Node.js 22.13+.

```bash
npm install
cp .env.example .env.local   # then set GEMINI_API_KEY
npm run dev                  # http://localhost:3000
```

Without `GEMINI_API_KEY`, the app still works in rules-only mode.

Production: `npm run build && npm start`.

## Deploy

The `Dockerfile` builds a self-contained image (frontend, rules index, card-name list) that listens on `$PORT`. To test it locally:

```bash
docker build -t mtg-rules-oracle .
docker run -p 8080:8080 -e GEMINI_API_KEY=... mtg-rules-oracle
```

On **Google Cloud Run**: Create service → *Continuously deploy from a repository* → pick this GitHub repo, build type *Dockerfile*. Then configure:

- Allow unauthenticated access.
- Min instances 0, max instances 2, 512 MiB of memory.
- Set `GEMINI_API_KEY` as a secret.

Every push to `main` then redeploys.

### Unraid (or any Docker host)

Every push to `main` publishes `ghcr.io/radixtrator/magicrules:latest` (see `.github/workflows/docker-publish.yml`). In Unraid, go to Docker → Add Container:

- **Repository:** `ghcr.io/radixtrator/magicrules:latest`
- **Port:** container `8080` → host `3000`
- **Variable:** `GEMINI_API_KEY`

To update, use Docker → Check for Updates.

## How it works

1. **Index (at startup, ~70 ms).** `rules.txt` is split into individual rules and glossary entries and loaded into an in-memory SQLite full-text index (`node:sqlite`, so there is no native dependency). See `server/rules.ts`.
2. **Retrieve (~5 ms, free).** `server/retrieve.ts` combines:
   - rule numbers cited in the question (`702.19c`),
   - rule titles and glossary terms the question names (`deathtouch`), following the glossary's "See rule …" pointers,
   - BM25 full-text ranking,
   - keywords of any `[[cards]]` in the question.

   The best ~10 rule groups (about 3k tokens) become the context.
3. **Cards.** `[[Card Name]]` is looked up on Scryfall with its official rulings and cached for 24 hours (`server/cards.ts`).
4. **Answer.** One streamed Gemini call runs on the server (`server/llm.ts`), so the API key never reaches the browser. Answers are cached per question, and each IP is limited to `ANSWER_LIMIT_PER_10MIN` answers.

Unchecking **Write an AI answer** in the UI skips the LLM call: only the matching rules are shown, instantly and at no cost.

## Retrieval quality

```bash
npm run eval
```

This runs `scripts/eval-retrieval.ts` and reports whether the right rule is in the context for a set of real questions (currently 24/25). Add a case whenever a bad answer turns out to be a retrieval miss.

To try a reranker (a cross-encoder, or a structured-decision model such as Jev), add it to `server/rerank.ts`. Then run `RERANKER=<name> npm run eval` and compare.

## Updating the rules

Download the latest Comprehensive Rules TXT from https://magic.wizards.com/rules, replace `rules.txt`, and run `npm run eval`.
