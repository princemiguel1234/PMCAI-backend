import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";
import fetch from "node-fetch";

const app = express();

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json());

// =======================
// GROQ CLIENT (AI MODEL)
// =======================
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// =======================
// ROOT
// =======================
app.get("/", (req, res) => {
  res.send("PMCAI backend is running 🚀");
});

// =======================
// 🌐 DUCKDUCKGO SEARCH (FREE INTERNET)
// =======================
async function searchWeb(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
      query
    )}&format=json&no_html=1&skip_disambig=1`;

    const res = await fetch(url);
    const data = await res.json();

    let results = [];

    // Main instant answer
    if (data.AbstractText) {
      results.push(`Summary: ${data.AbstractText}`);
    }

    if (data.Answer) {
      results.push(`Answer: ${data.Answer}`);
    }

    if (data.Heading) {
      results.push(`Topic: ${data.Heading}`);
    }

    // Related topics
    if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      data.RelatedTopics.slice(0, 4).forEach((item) => {
        if (item.Text) {
          results.push(`Related: ${item.Text}`);
        }
      });
    }

    if (results.length === 0) {
      return "No direct web data found. Use general knowledge.";
    }

    return results.join("\n");
  } catch (err) {
    console.error("Search error:", err);
    return "Web search failed. Use general knowledge.";
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
    // INTERNET CONTEXT
    // =======================
    const webData = await searchWeb(userMessage);

    const fullPrompt = `
USER QUESTION:
${userMessage}

WEB DATA:
${webData}
`;

    // =======================
    // AI REQUEST (GPT-OSS 20B)
    // =======================
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [
        {
          role: "system",
          content: `
You are PMCAI, an AI assistant created by Prince Miguel Cayetano.

Rules:
- Use WEB DATA when provided
- Summarize it naturally (DO NOT copy raw text)
- If web data is weak, use your own knowledge
- Be clear, accurate, and helpful
`
        },
        {
          role: "user",
          content: fullPrompt
        }
      ],
      temperature: 0.7,
      max_completion_tokens: 1024,
      top_p: 1
    });

    const reply =
      completion.choices?.[0]?.message?.content || "No response generated";

    res.json({ reply });
  } catch (err) {
    console.error("Backend Error:", err);

    res.status(500).json({
      error: "AI request failed",
      details: err.message
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
