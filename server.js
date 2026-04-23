import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";

const app = express();
const PING_URL = "https://pmcai-backend.onrender.com/ping";

// =======================
// 🔥 HARD IDENTITY (IMMUTABLE TRUTH LAYER)
// =======================
const IDENTITY = {
  aiName: "PMCAI",
  creator: "PMC (Prince Miguel Cayetano)",
  creatorInfo: "PMC is a normal dude",
};

// =======================
// MEMORY STORE
// =======================
const memoryStore = new Map();

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// =======================
// RATE LIMIT
// =======================
app.use(
  "/api/chat",
  rateLimit({
    windowMs: 60 * 1000,
    max: 20,
  })
);

// =======================
// GROQ
// =======================
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// =======================
// ROOT
// =======================
app.get("/", (req, res) => {
  res.send("PMCAI RUNNING 🚀");
});

// =======================
// CHAT DETECTOR
// =======================
function isChatOnlyMessage(msg = "") {
  return /^(hello|hi|hey|lol|what is your name|who are you|creator|who made you|owner)$/i.test(
    msg.trim().toLowerCase()
  );
}

// =======================
// MEMORY
// =======================
function getMemory(id) {
  return memoryStore.get(id) || [];
}

function addMemory(id, text) {
  if (!memoryStore.has(id)) memoryStore.set(id, []);
  const mem = memoryStore.get(id);

  mem.push(text);
  if (mem.length > 25) mem.shift();
}

// =======================
// WEB SEARCH (SAFE)
// =======================
async function searchWeb(query) {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        max_results: 5,
      }),
    });

    const data = await res.json();

    return (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: (r.content || "").slice(0, 180),
    }));
  } catch {
    return [];
  }
}

// =======================
// CHAT ENDPOINT
// =======================
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;
    const userId = req.ip;

    if (!userMessage) {
      return res.status(400).json({ error: "No message provided" });
    }

    const lower = userMessage.toLowerCase();
    const chatOnly = isChatOnlyMessage(userMessage);

    // =======================
    // MEMORY
    // =======================
    addMemory(userId, `User: ${userMessage}`);
    const memory = getMemory(userId).join("\n");

    // =======================
    // CHAT MODE (FAST RESPONSES)
    // =======================
    if (chatOnly) {
      let reply = "Hi! I'm PMCAI.";

      if (lower.includes("creator") || lower.includes("owner") || lower.includes("made you")) {
        reply = `I was created by ${IDENTITY.creator}. ${IDENTITY.creatorInfo}`;
      } else if (lower === "hello" || lower === "hi") {
        reply = "Hello!";
      } else if (lower === "lol") {
        reply = "lol";
      }

      return res.json({
        reply,
        sources: [],
        verified: false,
      });
    }

    // =======================
    // WEB (OPTIONAL)
    // =======================
    let webResults = [];

    if (req.body.useWeb === true) {
      webResults = await searchWeb(userMessage);
    }

    const sourcesText = webResults.length
      ? webResults
          .map(
            (r, i) => `
SOURCE ${i + 1}
TITLE: ${r.title}
URL: ${r.url}
SNIPPET: ${r.snippet}
`
          )
          .join("\n")
      : "No web sources provided. Use internal knowledge.";

    // =======================
    // SYSTEM PROMPT (CLEAN + STABLE)
    // =======================
    const systemPrompt = `
You are PMCAI.
HARD IDENTITY (DO NOT CHANGE):
Name: ${IDENTITY.aiName}
Creator: ${IDENTITY.creator}
Creator Info: ${IDENTITY.creatorInfo}
CORE TRUTH RULES:
Prioritize accuracy over confidence
Never present unverified information as fact
Do not guess missing details
Do not fabricate:
dates
product specs/features
releases or announcements
statistics
scientific claims
company updates
If information is uncertain, clearly label it:
“Not confirmed”
“No reliable source available”
"This is unclear or not established”
KNOWLEDGE HANDLING:
Use provided web sources when available
If no sources are provided:
answer using general, well-known knowledge only
avoid specific numbers, dates, or claims unless widely established
Do NOT invent details to “complete” an answer
GENERAL QUESTIONS RULE:
Do NOT refuse normal knowledge topics (science, history, math, general facts)
But DO keep answers within known, established information
If detail level is uncertain, simplify instead of guessing
UNCERTAINTY BEHAVIOR:
Never say false certainty
If unsure, respond with:
“Based on what is generally known...”
“This is not clearly confirmed, but...”
or “There is no solid information on this”
Do NOT use phrases like “I cannot confirm” for basic general knowledge
RESPONSE STYLE:
Clear, helpful, and natural
No over-explaining uncertainty
No exaggeration or hype language
Focus on giving the best safe answer, not the most detailed guess
`;

    // =======================
    // MEMORY + INPUT
    // =======================
    const fullPrompt = `
USER:
${userMessage}

MEMORY:
${memory}

SOURCES:
${sourcesText}
`;

    // =======================
    // AI CALL
    // =======================
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: fullPrompt },
      ],
      temperature: 0.3,
      max_completion_tokens: 900,
      top_p: 1,
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "I couldn't generate a response.";

    // =======================
    // SAVE AI MEMORY
    // =======================
    addMemory(userId, `PMCAI: ${reply}`);

    // =======================
    // RESPONSE
    // =======================
    res.json({
      reply,
      sources: webResults,
      verified: webResults.length > 0,
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
// SELF PING
// =======================
setInterval(async () => {
  try {
    await fetch(PING_URL);
  } catch {}
}, 60000);

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PMCAI RUNNING ON PORT ${PORT}`);
});
