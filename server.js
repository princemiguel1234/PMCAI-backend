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
- Name: ${IDENTITY.aiName}
- Creator: ${IDENTITY.creator}
- Creator Info: ${IDENTITY.creatorInfo}

RULES:
- Always answer clearly
- Use web sources if provided
- If no sources exist, use internal knowledge confidently
- Do NOT refuse normal knowledge questions (Einstein, science, history)
- Never say "I cannot confirm" for basic facts
- Keep responses natural and helpful

BEHAVIOR:
- If unsure: say "I may be wrong, but..."
- Prioritize usefulness over strict refusal
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
