import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";

const app = express();
const PING_URL = "https://pmcai-backend.onrender.com/ping";

// =======================
// 🔥 IDENTITY
// =======================
const IDENTITY = {
  aiName: "PMCAI",
  creator: "PMC (Prince Miguel Cayetano)",
  creatorInfo: "PMC is a normal dude",
};

// ✅ UPDATED MODEL
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

  // ✅ safer trim (avoids negative splice bugs)
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
    max: 25, // slightly increased
    standardHeaders: true,
    legacyHeaders: false,
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

  return keys.map((apiKey) => new Groq({ apiKey }));
}

function shouldRetryGroqError(err) {
  const status = err?.status || err?.response?.status;
  return !status || [408, 429, 500, 502, 503, 504].includes(status);
}

async function groqChatWithFallback(params) {
  const clients = getGroqClients();
  if (!clients.length) throw new Error("No Groq API keys found");

  let lastError;

  for (const client of clients) {
    try {
      const res = await client.chat.completions.create(params);
      if (res?.choices?.length) return res;
    } catch (err) {
      lastError = err;
      if (!shouldRetryGroqError(err)) throw err;
    }
  }

  throw lastError;
}

// =======================
// 🌐 WEB SEARCH
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
  } catch {
    return [];
  }
}

// =======================
// 💬 CHAT DETECTOR
// =======================
function isChatOnlyMessage(msg = "") {
  return /^(hello|hi|hey|lol|what is your name|who are you|creator|owner|who made you)$/i.test(
    msg.trim()
  );
}

// =======================
// 🏠 ROOT
// =======================
app.get("/", (req, res) => {
  res.send("PMCAI RUNNING 🚀");
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
    // 🧠 MEMORY FORMAT
    // =======================
    const memory = getMemory(userId)
      .map((m, i) => `Q${i + 1}: ${m.user}\nA${i + 1}: ${m.assistant}`)
      .join("\n");

    // =======================
    // ⚡ SIMPLE CHAT MODE
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
      ? webResults
          .map(
            (r) =>
              `TITLE: ${r.title}\nURL: ${r.url}\nSNIPPET: ${r.snippet}`
          )
          .join("\n\n")
      : "No web sources provided.";

    // =======================
    // 🧠 SYSTEM PROMPT (CLEAN)
    // =======================
    const systemPrompt = `
You are PMCAI created by ${IDENTITY.creator}.

Rules:
- Do not over-explain
- Be accurate and direct
- Use sources if provided
`;

    const userPrompt = `
User: ${userMessage}

Memory:
${memory || "None"}

Web Sources:
${sourcesText}
`;

    // =======================
    // 🤖 GROQ CALL
    // =======================
    const completion = await groqChatWithFallback({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens: 800, // ✅ FIXED PARAM
      top_p: 1,
    });

    let reply =
      completion.choices?.[0]?.message?.content ||
      "I couldn't generate a response.";

    // =======================
    // 🛡️ THINK SAFETY NET
    // =======================
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
    console.error("CHAT ERROR:", err);

    res.status(500).json({
      error: "Server error",
      details: err.message,
    });
  }
});

// =======================
// 🔁 SELF PING (ANTI-SLEEP)
// =======================
setInterval(async () => {
  try {
    await fetch(PING_URL);
  } catch {}
}, 60000);

// =======================
// 🚀 START SERVER
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PMCAI RUNNING ON PORT ${PORT}`);
});
