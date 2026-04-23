import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";

const app = express();
const URL = "https://pmcai-backend.onrender.com/ping";

// =======================
// MEMORY STORE (SIMPLE BUT STABLE)
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
  res.send("PMCAI RUNNING 🚀");
});

// =======================
// BLOCKED DOMAINS
// =======================
const BLOCKED_DOMAINS = [
  "instagram.com",
  "tiktok.com",
  "facebook.com",
  "youtube.com",
  "reddit.com",
];

// =======================
// VALID SOURCE CHECK
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
// INTENT DETECTION (FIXED)
// =======================
function isChatOnlyMessage(msg = "") {
  return /^(hello|hi|hey|lol|what is your name|who are you|creator|who made you)$/i.test(
    msg.trim()
  );
}

// =======================
// MEMORY FUNCTIONS
// =======================
function getMemory(userId) {
  return memoryStore.get(userId) || [];
}

function addMemory(userId, msg) {
  if (!memoryStore.has(userId)) memoryStore.set(userId, []);
  memoryStore.get(userId).push(msg);

  // limit memory size (prevents spam RAM leak)
  if (memoryStore.get(userId).length > 20) {
    memoryStore.get(userId).shift();
  }
}

// =======================
// WEB SEARCH
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
        search_depth: "basic",
        include_answer: false,
        max_results: 6,
      }),
    });

    const data = await res.json();

    const results = (data.results || [])
      .filter((r) => r.url && isValidSource(r.url))
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: (r.content || "").slice(0, 180),
      }));

    return results;
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

    const chatOnly = isChatOnlyMessage(userMessage);

    // =======================
    // MEMORY UPDATE
    // =======================
    addMemory(userId, `User: ${userMessage}`);

    const memory = getMemory(userId).join("\n");

    // =======================
    // WEB ONLY WHEN NEEDED
    // =======================
    let webResults = [];

    if (!chatOnly && req.body.useWeb === true) {
      webResults = await searchWeb(userMessage);
    }

    // =======================
    // CHAT MODE FIX (NO GLITCH LOOP)
    // =======================
    if (chatOnly) {
      const lower = userMessage.toLowerCase();

      let reply = "Hi! I'm PMCAI.";

      if (lower.includes("creator") || lower.includes("made you")) {
        reply = "I was created by PMC (Prince Miguel Cayetano).";
      }

      if (lower === "hello" || lower === "hi") {
        reply = "Hello!";
      }

      if (lower === "lol") {
        reply = "lol";
      }

      return res.json({
        reply,
        sources: [],
        verified: false,
      });
    }

    // =======================
    // STRICT MODE: NO FAKE DATA
    // =======================
    if (!webResults.length && !chatOnly && req.body.useWeb === true) {
      return res.json({
        reply: "No verified information found from trusted sources.",
        sources: [],
        verified: false,
      });
    }

    // =======================
    // FORMAT SOURCES
    // =======================
    const sourcesText = webResults
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
    // SYSTEM PROMPT (CLEANED)
    // =======================
    const systemPrompt = `
You are PMCAI (Prince Miguel Cayetano AI).
You are a Cloud AI assistant.
Your Creator Is PMC (Prince Miguel Cayetano)
Your Creator Is Just a Chill Dude

RULES:
- Be accurate and consistent
- Do NOT invent facts
- Use provided sources when available
- If no source exists, say it cannot be verified
- Do not repeat identical answers unnecessarily
- Always stay helpful and direct

MODES:
Chat Mode: normal conversation
Search Mode: only when web data is provided
Identity Mode: questions about PMCAI or creator

PRIORITY:
Accuracy > Creativity > Guessing
`;

    // =======================
    // USER PROMPT
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
    await fetch(URL);
    console.log("Self ping success");
  } catch {
    console.log("Self ping failed");
  }
}, 60000);

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PMCAI RUNNING ON PORT ${PORT}`);
});
