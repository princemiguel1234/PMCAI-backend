import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";

const app = express();
const PING_URL = "https://pmcai-backend.onrender.com/ping";

// =======================
// 🔥 HARD IDENTITY
// =======================
const IDENTITY = {
  aiName: "PMCAI",
  creator: "PMC (Prince Miguel Cayetano)",
  creatorInfo: "PMC is a normal dude",
};

const GROQ_MODEL = "qwen/qwen3-32b";

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
// GROQ FALLBACK KEYS
// =======================
function getGroqClients() {
  const keys = [
    process.env.GROQ_API_KEY1,
    process.env.GROQ_API_KEY2,
    process.env.GROQ_API_KEY3,
  ].filter(Boolean);

  return keys.map((apiKey) => new Groq({ apiKey }));
}

function shouldRetryGroqError(err) {
  const status = err?.status || err?.response?.status;
  if (!status) return true;
  if ([401, 403, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  return false;
}

async function groqChatWithFallback(params) {
  const clients = getGroqClients();

  if (!clients.length) throw new Error("No Groq API keys found");

  let lastError;

  for (const client of clients) {
    try {
      return await client.chat.completions.create(params);
    } catch (err) {
      lastError = err;
      if (!shouldRetryGroqError(err)) throw err;
    }
  }

  throw lastError;
}

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
        max_results: 7,
        include_answer: true,
      }),
    });

    const data = await res.json();

    return (data.results || []).map((r) => ({
      title: r.title || "No title",
      url: r.url || "No URL",
      snippet: (r.content || "").slice(0, 220),
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

    addMemory(userId, `User: ${userMessage}`);
    const memory = getMemory(userId).join("\n");

    if (chatOnly) {
      let reply = "Hi! I'm PMCAI.";

      if (lower.includes("creator") || lower.includes("owner") || lower.includes("made you")) {
        reply = `I was created by ${IDENTITY.creator}. ${IDENTITY.creatorInfo}`;
      } else if (lower === "hello" || lower === "hi") {
        reply = "Hello!";
      } else if (lower === "lol") {
        reply = "lol";
      }

      return res.json({ reply, sources: [], verified: false });
    }

    let webResults = [];

    if (req.body.useWeb === true) {
      webResults = await searchWeb(userMessage);
    }

    const hasWeb = webResults.length > 0;

    const sourcesText = hasWeb
      ? webResults.map((r, i) => `
SOURCE ${i + 1}
TITLE: ${r.title}
URL: ${r.url}
SNIPPET: ${r.snippet}
`).join("\n")
      : "No web sources provided.";

    const systemPrompt = `
You are PMCAI.

HARD IDENTITY:
Name: ${IDENTITY.aiName}
Creator: ${IDENTITY.creator}
Creator Info: ${IDENTITY.creatorInfo}

🌐 INTERNET RULES:
If SOURCES exist → use them as truth.
If NONE → offline mode only.

🚨 NEVER fabricate information.
`;

    const fullPrompt = `
USER QUESTION:
${userMessage}

MODE: ${hasWeb ? "INTERNET" : "OFFLINE"}

MEMORY:
${memory}

WEB SOURCES:
${sourcesText}
`;

    const completion = await groqChatWithFallback({
      model: GROQ_MODEL,
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

    addMemory(userId, `PMCAI: ${reply}`);

    res.json({
      reply,
      sources: webResults,
      verified: hasWeb,
    });
  } catch (err) {
    console.error(err);

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
// START
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PMCAI RUNNING ON PORT ${PORT}`);
});
