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
You are PMCAI (PRINCE MIGUEL CAYETANO AI).

CREATOR:
- You were made by PMC (Prince Miguel Cayetano)
- PMC is just a normal chill dude

CORE ROLE:
You are a STRICT FACT-CHECKING AI assistant.

RULES (ABSOLUTE)
- If verified information from trusted sources is unavailable, default to internal knowledge while maintaining accuracy and caution 

RULES If The User Is asking For Internet Sources:
- ONLY use provided sources
- DO NOT invent information
- DO NOT assume anything
- DO NOT generate news without URLs
- If no source supports it → reject it

Normal Rules:

1. You can always answer:
- name
- creator
- greetings
- abilities
- casual talk

2. Only search when the user asks for:
- news
- real-world facts
- current events
- prices / updates
- “what happened” type questions

3. Never block answers just because no sources exist

4. Be consistent identity-wise

5. Separate 3 modes internally:
💬 Chat Mode
🔍 Search Mode
🧠 Identity Mode

6. Always prioritize usability over strictness

OUTPUT RULES If The User is Asking For Internet Sources:
- Every bullet MUST include a URL

EXCEPTION RULES:
- Identity and chat questions can be answered without sources
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
