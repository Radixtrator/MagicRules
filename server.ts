import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Database setup
  let db: any = null;
  const dbPath = path.join(process.cwd(), "cards.sqlite");
  
  function getDb() {
    if (!db && fs.existsSync(dbPath)) {
      try {
        db = new Database(dbPath, { readonly: true });
        console.log("Connected to cards.sqlite");
      } catch (err) {
        console.error("Failed to connect to cards.sqlite:", err);
      }
    }
    return db;
  }

  // Rules text setup
  let rulesText = "";
  const rulesPath = path.join(process.cwd(), "rules.txt");
  
  function getRules() {
    if (!rulesText && fs.existsSync(rulesPath)) {
      try {
        rulesText = fs.readFileSync(rulesPath, "utf-8");
        console.log("Loaded rules.txt");
      } catch (err) {
        console.error("Failed to load rules.txt:", err);
      }
    }
    return rulesText;
  }

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "ok", 
      dbExists: true, // Now using Scryfall API
      rulesExists: fs.existsSync(rulesPath)
    });
  });

  app.post("/api/query-cards", async (req, res) => {
    const { query } = req.body;
    // Extract potential card name from query (simple heuristic)
    // If the user uses [[Card Name]], use that, otherwise take first few words
    const cardNameMatch = query.match(/\[\[(.*?)\]\]/);
    const cardName = cardNameMatch ? cardNameMatch[1] : query.split(' ').slice(0, 3).join(' ');
    
    try {
      const scryfallRes = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(cardName)}`);
      if (scryfallRes.ok) {
        const card: any = await scryfallRes.json();
        res.json([{
          name: card.name,
          text: card.oracle_text,
          type: card.type_line,
          cost: card.mana_cost
        }]);
      } else {
        res.json([]);
      }
    } catch (err: any) {
      console.error("Scryfall error:", err);
      res.status(500).json({ error: "Failed to fetch from Scryfall" });
    }
  });

  app.post("/api/search-rules", (req, res) => {
    const { query } = req.body;
    const rules = getRules();
    if (!rules) {
      return res.status(404).json({ error: "Rules file not found. Please upload rules.txt to the root directory." });
    }

    // Simple keyword search for relevant sections
    const keywords = query.toLowerCase().split(/\s+/).filter((k: string) => k.length > 3);
    const sections = rules.split(/\n\n+/);
    const results = sections.filter(section => {
      const lowerSection = section.toLowerCase();
      return keywords.some((k: string) => lowerSection.includes(k));
    }).slice(0, 10); // Return top 10 relevant sections

    res.json({ results });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
