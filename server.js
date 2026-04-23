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
  res.send("PMCAI VERIFIED BACKEND RUNNING 🚀");
});

// =======================
// TRUST FILTER (IMPORTANT)
// =======================
function isTrustedSource(url = "") {
  const badSources = [
    "instagram.com",
    "tiktok.com",
    "facebook.com",
    "reddit.com/r/",
    "youtube.com/shorts",
  ];

  return !badSources.some((b) => url.includes(b));
}

// =======================
// 🌐 TAVILY WEB SEARCH (CLEAN + FILTERED)
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
        include_raw_content: false,
        max_results: 8,
      }),
    });

    const data = await res.json();

    const filtered = (data.results || [])
      .filter((r) => r.url && isTrustedSource(r.url))
      .slice(0, 5)
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
      }));

    return {
      query,
      results: filtered,
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
// CHAT ENDPOINT
// =======================
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (!userMessage) {
      return res.status(400).json({ error: "No message provided" });
    }

    // =======================
    // GET REAL WEB DATA
    // =======================
    const webData = await searchWeb(userMessage);

    // =======================
    // STRICT SYSTEM RULES (ANTI-HALLUCINATION)
    // =======================
    const systemPrompt = `
You are PMCAI, a verified fact-based AI assistant.

CRITICAL RULES:
- ONLY use provided WEB RESULTS
- EVERY claim must match a URL in results
- DO NOT invent news, events, or updates
- If no valid sources exist → say "No verified information found"
- IGNORE social media-style content if present
- Summarize ONLY from trusted sources
- Be strict, factual, and concise
`;

    // =======================
    // GROUNDED PROMPT
    // =======================
    const fullPrompt = `
USER QUESTION:
${userMessage}

VERIFIED WEB RESULTS:
${JSON.stringify(webData, null, 2)}

INSTRUCTION:
- Only use results with URLs
- If results are empty, stop and say no verified info
`;

    // =======================
    // AI REQUEST
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
      temperature: 0.2, // 🔥 very strict = less hallucination
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
      error: "Server failure",
      details: err.message,
    });
  }
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PMCAI VERIFIED BACKEND RUNNING ON PORT ${PORT}`);
});
