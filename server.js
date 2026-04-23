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
// GROQ AI CLIENT
// =======================
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// =======================
// ROOT CHECK
// =======================
app.get("/", (req, res) => {
  res.send("PMCAI backend is running 🚀");
});

// =======================
// TIMEOUT HELPER (prevents hanging)
// =======================
function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout")), ms)
  );
}

// =======================
// 🌐 SIMPLE WEB SEARCH (DuckDuckGo Instant API)
// =======================
async function searchWeb(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
      query
    )}&format=json&no_html=1&skip_disambig=1`;

    const res = await Promise.race([
      fetch(url),
      timeout(5000),
    ]);

    const data = await res.json();

    // STRUCTURED OUTPUT (MUCH BETTER FOR AI)
    const result = {
      topic: data.Heading || null,
      summary: data.AbstractText || null,
      answer: data.Answer || null,
      related: [],
    };

    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      result.related = data.RelatedTopics
        .filter((t) => t.Text)
        .slice(0, 5)
        .map((t) => t.Text);
    }

    return result;
  } catch (err) {
    return {
      error: true,
      message: "Web search failed or unavailable",
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
    // GET WEB DATA
    // =======================
    const webData = await searchWeb(userMessage);

    // =======================
    // BUILD CLEAN PROMPT
    // =======================
    const fullPrompt = `
USER QUESTION:
${userMessage}

WEB CONTEXT (structured, may be empty or partial):
${JSON.stringify(webData, null, 2)}

INSTRUCTIONS:
- Use web context if useful
- If web context is weak, rely on reasoning
- Do NOT copy raw text
- Keep answer clear, helpful, and natural
`;

    // =======================
    // GROQ REQUEST
    // =======================
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [
        {
          role: "system",
          content: `
You are PMCAI, an AI assistant created by Prince Miguel Cayetano.

Rules:
- Be accurate and helpful
- Use web context when available
- If web data is missing, rely on reasoning
- Keep responses natural and structured
`,
        },
        {
          role: "user",
          content: fullPrompt,
        },
      ],
      temperature: 0.7,
      max_completion_tokens: 1024,
      top_p: 1,
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "No response generated";

    res.json({
      reply,
      webUsed: !webData.error,
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
