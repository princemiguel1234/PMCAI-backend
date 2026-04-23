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
  res.send("PMCAI backend is running 🚀");
});

// =======================
// 🌐 TAVILY WEB SEARCH ENGINE
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
        include_answer: true,
        include_raw_content: false,
        max_results: 5,
      }),
    });

    const data = await res.json();

    return {
      answer: data.answer || null,
      results: (data.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
      })),
    };
  } catch (err) {
    return {
      answer: null,
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
    // STRICT SYSTEM PROMPT
    // =======================
    const systemPrompt = `
You are PMCAI, an AI assistant created by Prince Miguel Cayetano.

CRITICAL RULES:
- Use ONLY provided WEB DATA for factual claims
- NEVER invent news, events, or dates
- If WEB DATA is empty, say "No verified information found"
- Summarize results clearly and naturally
- Always prefer accuracy over creativity
`;

    // =======================
    // FINAL PROMPT
    // =======================
    const fullPrompt = `
USER QUESTION:
${userMessage}

WEB DATA (REAL SEARCH RESULTS):
${JSON.stringify(webData, null, 2)}
`;

    // =======================
    // GROQ AI REQUEST
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
      temperature: 0.3,
      max_completion_tokens: 1024,
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
      webUsed: !webData.error,
      sources: webData.results || [],
    });
  } catch (err) {
    console.error("Backend Error:", err);

    res.status(500).json({
      error: "AI request failed",
      details: err.message,
    });
  }
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PMCAI backend running on port ${PORT}`);
});
