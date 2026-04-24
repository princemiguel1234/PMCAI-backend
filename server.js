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

const GROQ_MODEL = "qwen/qwen3-32b";

// =======================
// MEMORY (25 Q&A LIMIT)
// =======================
const memoryStore = new Map();

function getMemory(id) {
  return memoryStore.get(id) || [];
}

function addMemory(id, user, assistant) {
  if (!memoryStore.has(id)) memoryStore.set(id, []);

  const mem = memoryStore.get(id);

  mem.push({ user, assistant });

  // keep last 25 only
  if (mem.length > 25) {
    mem.splice(0, mem.length - 25);
  }
}

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use(
  "/api/chat",
  rateLimit({
    windowMs: 60 * 1000,
    max: 20,
  })
);

// =======================
// GROQ CLIENTS (FALLBACK)
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
  return !status || [401, 403, 408, 429, 500, 502, 503, 504].includes(status);
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
      snippet: (r.content || "").slice(0, 200),
    }));
  } catch {
    return [];
  }
}

// =======================
// CHAT DETECTOR
// =======================
function isChatOnlyMessage(msg = "") {
  return /^(hello|hi|hey|lol|what is your name|who are you|creator|who made you|owner)$/i.test(
    msg.trim().toLowerCase()
  );
}

// =======================
// ROOT
// =======================
app.get("/", (req, res) => {
  res.send("PMCAI RUNNING 🚀");
});

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
    // FORMAT MEMORY
    // =======================
    const memory = getMemory(userId)
      .map((m, i) => `Q${i + 1}: ${m.user}\nA${i + 1}: ${m.assistant}`)
      .join("\n");

    // =======================
    // SIMPLE CHAT MODE
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
    // WEB SEARCH
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
    // SYSTEM PROMPT (CLEAN + CONTROLLED THINK)
    // =======================
    const systemPrompt = `
You are PMCAI ( PRINCE MIGUEL CAYETANO AI ),
Your Creator Is PMC ( PRINCE MIGUEL CAYETANO ).
PMC is a Normal Male Person

When you use reasoning, you must wrap it inside <think> tags.

When reasoning is needed, include a <think> section.

Format:
<think>
1–3 very short sentences (brief reasoning only)
</think>

Rules:
- Use the <think> tag ONLY for internal reasoning
- Keep it concise (no long explanations)
- Do not include anything unrelated inside <think>

RULES:
- Keep <think> short and clean
- Do NOT output long reasoning
- Use web sources if provided
- Be accurate, direct, and helpful
`;

    const userPrompt = `
User: ${userMessage}

Memory:
${memory}

Web sources:
${sourcesText}
`;

    // =======================
    // GROQ CALL
    // =======================
    const completion = await groqChatWithFallback({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_completion_tokens: 900,
      top_p: 1,
    });

    let reply =
      completion.choices?.[0]?.message?.content ||
      "I couldn't generate a response.";

    // =======================
    // SAFETY NET
    // =======================
    if (!reply.includes("<think>")) {
      reply = `<think>\nprocessed\n</think>\n\n${reply}`;
    }

    // =======================
    // SAVE MEMORY
    // =======================
    addMemory(userId, userMessage, reply);

    res.json({
      reply,
      sources: webResults,
      verified: webResults.length > 0,
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
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PMCAI RUNNING ON PORT ${PORT}`);
});
