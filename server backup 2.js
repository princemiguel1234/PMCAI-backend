import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";

const app = express();

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json({ limit: "1mb" }));

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
// 🚫 BLOCK LIST (VERY IMPORTANT)
// =======================
const BLOCKED_DOMAINS = [
  "instagram.com",
  "tiktok.com",
  "facebook.com",
  "youtube.com/shorts",
  "reddit.com",
];

// =======================
// VALIDATE URL
// =======================
function isValidSource(url = "") {
  if (!url) return false;
  return !BLOCKED_DOMAINS.some((b) => url.includes(b));
}

// =======================
// 🌐 TAVILY SEARCH (STRICT MODE)
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
        max_results: 8,
      }),
    });

    const data = await res.json();

    const cleaned = (data.results || [])
      .filter((r) => r.url && isValidSource(r.url))
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
      }));

    return {
      query,
      results: cleaned,
    };
  } catch (err) {
    return {
      query,
      results: [],
      error: true,
    };
  }
}

// =======================
// 🧠 CHAT ENDPOINT
// =======================
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (!userMessage) {
      return res.status(400).json({ error: "No message provided" });
    }

    // =======================
    // GET WEB DATA
    // =======================
    const webData = await searchWeb(userMessage);

    // =======================
    // STRICT SYSTEM RULES
    // =======================
    const systemPrompt = `
You are PMCAI, a STRICT FACT-CHECKING AI.

RULES (MANDATORY):
- ONLY use provided WEB RESULTS
- EVERY fact MUST match a URL
- DO NOT invent news, events, or updates
- If results are empty → say "No verified information found"
- DO NOT use social media sources
- DO NOT guess or assume anything
- If unsure → reject the claim
`;

    // =======================
    // USER PROMPT
    // =======================
    const fullPrompt = `
USER QUESTION:
${userMessage}

VERIFIED WEB RESULTS (ONLY TRUST THESE):
${JSON.stringify(webData, null, 2)}

INSTRUCTIONS:
- If no URLs exist → STOP and say no verified info
- Do NOT create news-style formatting unless sources exist
`;

    // =======================
    // GROQ AI CALL
    // =======================
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: fullPrompt,
        },
      ],
      temperature: 0.2,
      max_completion_tokens: 900,
      top_p: 1,
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "No response generated";

    // =======================
    // RESPONSE
    // =======================
    res.json({
      reply,
      sources: webData.results,
      verified: webData.results.length > 0,
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
