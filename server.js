import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";

const URL = "https://pmcai-backend.onrender.com/ping";

const app = express();

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// =======================
// RATE LIMIT
// =======================
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
});
app.use("/api/chat", limiter);

// =======================
// GROQ CLIENT
// =======================
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// =======================
// ROOT
// =======================
app.get("/", (req, res) => {
  res.send("PMCAI VERIFIED NEWS AI RUNNING 🚀");
});

// =======================
// BLOCK LIST
// =======================
const BLOCKED_DOMAINS = [
  "instagram.com",
  "tiktok.com",
  "facebook.com",
  "youtube.com",
  "reddit.com",
];

// =======================
// VALIDATE URL
// =======================
function isValidSource(url = "") {
  try {
    const hostname = new URL(url).hostname.replace("www.", "");
    return !BLOCKED_DOMAINS.some(
      (b) => hostname === b || hostname.endsWith("." + b)
    );
  } catch {
    return false;
  }
}

// =======================
// INTENT DETECTOR (IMPORTANT FIX)
// =======================
function isChatOnlyMessage(msg = "") {
  return /hello|hi|who are you|what is your name|creator|who made you|how are you/i.test(
    msg
  );
}

// =======================
// WEB SEARCH
// =======================
async function searchWeb(query) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        include_answer: false,
        max_results: 8,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await res.json();

    const cleaned = (data.results || [])
      .filter((r) => r.url && isValidSource(r.url))
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: (r.content || "").slice(0, 200),
      }));

    return { query, results: cleaned };
  } catch (err) {
    return { query, results: [], error: true };
  }
}

// =======================
// CHAT ENDPOINT
// =======================
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (!userMessage) {
      return res.status(400).json({ error: "No message provided" });
    }

    const chatOnly = isChatOnlyMessage(userMessage);

    // =======================
    // WEB SEARCH (ONLY IF NEEDED)
    // =======================
    let webData;

    if (chatOnly) {
      webData = { query: userMessage, results: [] };
    } else {
      webData = await searchWeb(userMessage);
    }

    // =======================
    // BLOCK ONLY REAL SEARCH QUERIES
    // =======================
    if (!webData.results.length && !chatOnly) {
      return res.json({
        reply: "No verified information found from trusted sources.",
        sources: [],
        verified: false,
      });
    }

    // =======================
    // FORMAT SOURCES
    // =======================
    const compactSources = webData.results
      .map(
        (r, i) => `
SOURCE ${i + 1}
TITLE: ${r.title}
URL: ${r.url}
SNIPPET: ${r.snippet}
`
      )
      .join("\n");

    // =======================
    // SYSTEM PROMPT (UNCHANGED AS REQUESTED)
    // =======================
    const systemPrompt = `
PMCAI SYSTEM INSTRUCTION (STRICT MODE)
IDENTITY
You are PMCAI (Prince Miguel Cayetano AI)
Created by: PMC (Prince Miguel Cayetano)
PMC is a normal, chill individual
CORE ROLE
You are a Cloud AI Assistant
Your priority is accuracy, consistency, and safe responses
HARD RULES (NON-NEGOTIABLE)
1. Web / Internet Usage Control
Do NOT use web searches by default
Only use internet access if the user explicitly requests real-time or web-based information
If no verified source is available, use internal knowledge carefully and avoid guessing
2. Source-Based Answers (STRICT MODE)

When the user requests internet-based or factual sourced information:

ONLY use provided or verified sources
DO NOT invent, assume, or hallucinate data
DO NOT generate news, updates, or facts without valid URLs
If no valid source exists → explicitly state that no verified source is available
Every supported claim MUST include a URL reference
Never mix unsourced information with sourced information
3. Repetition Control
Do NOT repeat identical answers across responses
Adapt answers based on the user’s latest question
Only repeat information if the user requests clarification or expansion
QUERY HANDLING RULES
You MUST answer normally without restriction for:
Identity questions (who you are, creator, etc.)
Greetings and casual conversation
Capability explanations
Simple informational chat
You MUST switch to STRICT MODE when the user asks:
News or current events
Real-world updates
Prices, live data, or time-sensitive info
“What happened” or investigative questions
Any request implying external verification
INTERNAL OPERATION MODES

You operate using 3 logical modes:

💬 Chat Mode
Normal conversation
No web required
🔍 Search Mode (STRICT CONTROLLED)
Only activated when user explicitly requests real-time info
Must use valid sources only
🧠 Identity Mode
Answers about PMCAI, creator, and system behavior
No web usage allowed
OUTPUT RULES (STRICT)
If using sources → every bullet or claim must include a valid URL
If no sources exist → explicitly say information cannot be verified
Never fabricate links or citations
Keep responses consistent, structured, and direct
FINAL PRINCIPLE
Prioritize accuracy over creativity
Prioritize user intent over unnecessary restrictions
Maintain strict separation between sourced and unsourced information
`;

    // =======================
    // USER PROMPT
    // =======================
    const fullPrompt = `
USER QUESTION:
${userMessage}

VERIFIED SOURCES:
${compactSources}
`;

    // =======================
    // GROQ CALL
    // =======================
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: fullPrompt },
      ],
      temperature: 0.2,
      max_completion_tokens: 900,
      top_p: 1,
    });

    const raw = completion.choices?.[0]?.message?.content;

    // =======================
    // CHAT MODE OVERRIDE (FIXED BEHAVIOR)
    // =======================
    if (chatOnly) {
      const lower = userMessage.toLowerCase();

      const directAnswer =
        lower.includes("creator") || lower.includes("made you")
          ? "I was created by PMC (Prince Miguel Cayetano)."
          : raw && raw.trim().length > 0
          ? raw
          : "Hi! I'm PMCAI.";

      return res.json({
        reply: directAnswer,
        sources: [],
        verified: false,
      });
    }

    // =======================
    // SAFE FALLBACK
    // =======================
    const reply =
      raw && raw.trim().length > 0
        ? raw
        : "I couldn’t generate a response for this request.";

    // =======================
    // RESPONSE
    // =======================
    res.json({
      reply,
      sources: webData.results,
      verified: true,
    });
  } catch (err) {
    console.error("PMCAI ERROR:", err);

    res.status(500).json({
      error: "Server error",
      details: err.message,
    });
  }
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PMCAI VERIFIED NEWS AI RUNNING ON PORT ${PORT}`);
});

setInterval(async () => {
  try {
    await fetch(URL, { method: "GET" });
    console.log("Self ping success");
  } catch (err) {
    console.log("Self ping failed");
  }
}, 60 * 1000);
