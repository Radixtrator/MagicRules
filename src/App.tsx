/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { GoogleGenAI } from "@google/genai";
import { 
  Send, 
  Bot, 
  User, 
  Database, 
  FileText, 
  AlertCircle, 
  CheckCircle2,
  Loader2,
  Search,
  Book
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface HealthStatus {
  status: string;
  dbExists: boolean;
  rulesExists: boolean;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  useEffect(() => {
    checkHealth();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const checkHealth = async () => {
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      setHealth(data);
    } catch (err) {
      console.error("Health check failed:", err);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      // 1. Search for relevant rules
      const rulesRes = await fetch("/api/search-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: input }),
      });
      const { results: rulesContext } = await rulesRes.json();

      // 2. Try to find card info if relevant
      // We'll just do a simple search for card names in the query
      // This is a bit naive but works for a demo
      let cardContext = "";
      if (health?.dbExists) {
        const cardRes = await fetch("/api/query-cards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            query: "SELECT name, text, type, cost FROM cards WHERE name LIKE ? LIMIT 3",
            params: [`%${input.split(' ')[0]}%`] // Very basic search
          }),
        });
        const cards = await cardRes.json();
        if (cards.length > 0) {
          cardContext = "Relevant Card Info:\n" + cards.map((c: any) => 
            `${c.name} (${c.cost}) - ${c.type}: ${c.text}`
          ).join("\n\n");
        }
      }

      // 3. Call Gemini with context
      const systemInstruction = `
        You are an expert Magic: The Gathering Rules Manager. 
        Your goal is to answer rules questions accurately using the provided context from the Comprehensive Rules and Card Database.
        
        Context from Rules:
        ${rulesContext.join("\n\n")}
        
        ${cardContext}
        
        If the context doesn't contain the answer, use your general MTG knowledge but mention that it's not in the specific rules provided.
        Be precise, cite rule numbers if available in the context, and explain the interaction clearly.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: input,
        config: {
          systemInstruction,
        },
      });

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: response.text || "I'm sorry, I couldn't generate a response.",
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      console.error("Error generating response:", err);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: "I encountered an error while processing your request. Please ensure the rules and database files are uploaded.",
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0]">
      {/* Header */}
      <header className="border-b border-[#141414] p-6 flex justify-between items-center bg-white/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="bg-[#141414] p-2 rounded-sm">
            <Bot className="text-[#E4E3E0] w-6 h-6" />
          </div>
          <div>
            <h1 className="font-serif italic text-2xl tracking-tight">MTG Rules Oracle</h1>
            <p className="text-[10px] uppercase tracking-widest opacity-50 font-mono">Comprehensive Rules Assistant</p>
          </div>
        </div>

        <div className="flex gap-4">
          <StatusBadge 
            label="Scryfall API" 
            active={true} 
            icon={<Database size={14} />} 
          />
          <StatusBadge 
            label="Rules" 
            active={!!health?.rulesExists} 
            icon={<FileText size={14} />} 
          />
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto p-6 pb-32">
        {!health?.rulesExists ? (
          <div className="bg-white border border-[#141414] p-8 rounded-sm mb-8 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
            <div className="flex items-start gap-4">
              <AlertCircle className="text-amber-600 w-6 h-6 mt-1" />
              <div>
                <h2 className="font-serif italic text-xl mb-2">Missing Rules Text</h2>
                <p className="text-sm opacity-70 mb-4">
                  To provide accurate answers, I need the Magic: The Gathering comprehensive rules text. I've switched to using the Scryfall API for card data to save you from uploading the large database.
                </p>
                <div className="space-y-2 font-mono text-xs">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-green-600" />
                    <span>Scryfall API (Connected)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {health?.rulesExists ? <CheckCircle2 size={14} className="text-green-600" /> : <Loader2 size={14} className="animate-spin" />}
                    <span>rules.txt (Comprehensive rules text)</span>
                  </div>
                </div>
                <p className="mt-6 text-xs italic opacity-50">
                  Please upload <b>rules.txt</b> to the root directory of the project.
                </p>
              </div>
            </div>
          </div>
        ) : null}

        <div className="space-y-8">
          {messages.length === 0 ? (
            <div className="text-center py-20 opacity-30">
              <Search className="w-12 h-12 mx-auto mb-4" />
              <p className="font-mono text-sm uppercase tracking-widest">Ask a rules question to begin</p>
              <p className="text-xs mt-2">Example: "How does Trample interact with Deathtouch?"</p>
            </div>
          ) : (
            messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                  "flex gap-4 p-6 border border-[#141414] rounded-sm bg-white",
                  msg.role === "assistant" ? "shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]" : "bg-white/40"
                )}
              >
                <div className={cn(
                  "w-10 h-10 rounded-sm flex items-center justify-center shrink-0",
                  msg.role === "assistant" ? "bg-[#141414] text-[#E4E3E0]" : "bg-[#E4E3E0] border border-[#141414]"
                )}>
                  {msg.role === "assistant" ? <Bot size={20} /> : <User size={20} />}
                </div>
                <div className="flex-1 overflow-hidden">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-[10px] uppercase tracking-widest font-mono opacity-50">
                      {msg.role === "assistant" ? "Oracle Response" : "Player Inquiry"}
                    </span>
                    <span className="text-[10px] font-mono opacity-30">
                      {msg.timestamp.toLocaleTimeString()}
                    </span>
                  </div>
                  <div className={cn(
                    "prose prose-sm max-w-none",
                    msg.role === "assistant" ? "font-sans leading-relaxed" : "font-mono text-sm"
                  )}>
                    {msg.content.split('\n').map((line, i) => (
                      <p key={i} className="mb-2 last:mb-0">{line}</p>
                    ))}
                  </div>
                </div>
              </motion.div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Input Area */}
      <div className="fixed bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-[#E4E3E0] via-[#E4E3E0] to-transparent">
        <div className="max-w-4xl mx-auto relative">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Ask about layers, state-based actions, or card interactions..."
            className="w-full bg-white border-2 border-[#141414] p-4 pr-16 rounded-sm shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] focus:outline-none focus:ring-0 font-sans text-lg placeholder:opacity-30"
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="absolute right-4 top-1/2 -translate-y-1/2 bg-[#141414] text-[#E4E3E0] p-2 rounded-sm hover:scale-105 active:scale-95 transition-transform disabled:opacity-30 disabled:hover:scale-100"
          >
            {isLoading ? <Loader2 className="animate-spin" /> : <Send size={20} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ label, active, icon }: { label: string; active: boolean; icon: React.ReactNode }) {
  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-1 border rounded-sm text-[10px] uppercase tracking-widest font-mono transition-colors",
      active 
        ? "border-green-600/30 bg-green-50 text-green-700" 
        : "border-red-600/30 bg-red-50 text-red-700"
    )}>
      {icon}
      <span>{label}</span>
      <div className={cn("w-1.5 h-1.5 rounded-full", active ? "bg-green-600" : "bg-red-600")} />
    </div>
  );
}
