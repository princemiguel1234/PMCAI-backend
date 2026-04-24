import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import "dotenv/config"; // ✅ Automatically loads .env variables if running locally

const app = express();

// ✅ CRITICAL FOR RENDER: Allows rate-limiter and req.ip to see the real user's IP
app.set("trust proxy", 1); 

const PING_URL = "https://pmcai-backend.onrender.com/ping";

// =======================
// 🔥 IDENTITY
// =======================
const IDENTITY = {
  aiName: "PMCAI",
  creator: "PMC (Prince Miguel Cayetano)",
  creatorInfo: "PMC is a normal dude",
};

const GROQ_MODEL = "llama-3.3-70b-versatile";

// =======================
// 🧠 MEMORY (25 LIMIT)
// =======================
const memoryStore = new Map();

function getMemory(id) {
  return memoryStore.get(id) || [];
}

function addMemory(id, user, assistant) {
  if (!memoryStore.has(id)) memoryStore.set(id, []);
  const mem = memoryStore.get(id);

  mem.push({ user, assistant });

  // Keep only the last 25 interactions
  while (mem.length > 25) mem.shift();
}

// =======================
// ⚙️ MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use(
  "/api/chat",
  rateLimit({
    windowMs: 60 * 1000,
    max: 25,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down." }
  })
);

// =======================
// 🔑 GROQ CLIENTS (SMART FALLBACK)
// =======================
function getGroqClients() {
  const keys = [
    process.env.GROQ_API_KEY1,
    process.env.GROQ_API_KEY2,
    process.env.GROQ_API_KEY3,
  ].filter(Boolean);

  if (keys.length === 0) {
    console.warn("⚠️ WARNING: No Groq API keys found in environment variables!");
  }

  return keys.map((apiKey) => new Groq({ apiKey }));
}

function shouldRetryGroqError(err) {
  const status = err?.status || err?.response?.status;
  return !status || [408, 429, 500, 502, 503, 504].includes(status);
}

async function groqChatWithFallback(params) {
  const clients = getGroqClients();
  if (!clients.length) throw new Error("No Groq API keys configured on server.");

  let lastError;

  for (const client of clients) {
    try {
      const res = await client.chat.completions.create(params);
      if (res?.choices?.length) return res;
    } catch (err) {
      lastError = err;
      if (!shouldRetryGroqError(err)) throw err;
      console.log(`Switching to backup Groq key due to error: ${err.status}`);
    }
  }

  throw lastError;
}

// =======================
// 🌐 WEB SEARCH
// =======================
async function searchWeb(query) {
  if (!process.env.TAVILY_API_KEY) {
    console.warn("⚠️ Tavily API key missing. Skipping web search.");
    return [];
  }

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
        include_answer: true,
      }),
    });

    if (!res.ok) return [];

    const data = await res.json();
    return (data.results || []).map((r) => ({
      title: r.title || "No title",
      url: r.url || "No URL",
      snippet: (r.content || "").slice(0, 180),
    }));
  } catch (err) {
    console.error("Search Error:", err.message);
    return [];
  }
}

// =======================
// 💬 CHAT DETECTOR
// =======================
function isChatOnlyMessage(msg = "") {
  return /^(hello|hi|hey|lol|what is your name|who are you|creator|owner|who made you)$/i.test(msg.trim());
}

// =======================
// 🏠 ROUTES
// =======================
app.get("/", (req, res) => {
  res.send("PMCAI RUNNING 🚀");
});

app.get("/ping", (req, res) => {
  res.send("pong");
});

// =======================
// 💬 CHAT ENDPOINT
// =======================
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = req.body.message?.trim();
    const userId = req.ip;

    if (!userMessage) {
      return res.status(400).json({ error: "No message provided" });
    }

    const lower = userMessage.toLowerCase();
    const chatOnly = isChatOnlyMessage(userMessage);

    // =======================
    // ⚡ SIMPLE CHAT MODE
    // =======================
    if (chatOnly) {
      let reply = "Hi! I'm PMCAI.";
      if (lower.includes("creator") || lower.includes("owner") || lower.includes("made you")) {
        reply = `I was created by ${IDENTITY.creator}. ${IDENTITY.creatorInfo}`;
      } else if (lower === "hello" || lower === "hi" || lower === "hey") {
        reply = "Hello! How can I help you today?";
      } else if (lower === "lol") {
        reply = "Haha! What's on your mind?";
      }
      return res.json({ reply, sources: [], verified: false });
    }

    // =======================
    // 🌐 WEB SEARCH
    // =======================
    let webResults = [];
    if (req.body.useWeb === true) {
      webResults = await searchWeb(userMessage);
    }

    const sourcesText = webResults.length
      ? "\n\nWeb Sources (Use these to help answer if relevant):\n" + webResults.map(r => `- ${r.title}: ${r.snippet} (${r.url})`).join("\n")
      : "";

    // =======================
    // 🧠 ASSEMBLE MESSAGES (NATIVE MEMORY)
    // =======================
    const systemPrompt = `You are ${IDENTITY.aiName}, an AI created by ${IDENTITY.creator}. 
Rules:
- Do not over-explain. Be accurate and direct.
- Base your answers on the provided Web Sources if available.`;

    const messages = [{ role: "system", content: systemPrompt }];

    // Inject native chat history
    const memory = getMemory(userId);
    for (const mem of memory) {
      messages.push({ role: "user", content: mem.user });
      messages.push({ role: "assistant", content: mem.assistant });
    }

    // Inject the current message + sources
    messages.push({ role: "user", content: `${userMessage}${sourcesText}` });

    // =======================
    // 🤖 GROQ CALL
    // =======================
    const completion = await groqChatWithFallback({
      model: GROQ_MODEL,
      messages: messages,
      temperature: 0.4,
      max_tokens: 800,
      top_p: 1,
    });

    let reply = completion.choices?.[0]?.message?.content || "I couldn't generate a response.";

    // =======================
    // 🛡️ FRONTEND FORMATTING (THINK TAGS)
    // =======================
    // If your frontend relies on <think> tags, we ensure they exist here.
    if (!reply.includes("<think>")) {
      reply = `<think>\nprocessed\n</think>\n\n${reply}`;
    }

    // =======================
    // 💾 SAVE MEMORY
    // =======================
    addMemory(userId, userMessage, reply);

    res.json({
      reply,
      sources: webResults,
      verified: webResults.length > 0,
    });
  } catch (err) {
    console.error("CHAT ERROR:", err.message);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// =======================
// 🔁 SELF PING (ANTI-SLEEP)
// =======================
setInterval(async () => {
  try {
    await fetch(PING_URL);
  } catch (err) {
    // Silently ignore ping errors to prevent console spam if offline
  }
}, 60000);

// =======================
// 🚀 START SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PMCAI RUNNING ON PORT ${PORT}`);
});
