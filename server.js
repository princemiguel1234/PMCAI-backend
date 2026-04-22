import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";

const app = express();

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json());

// =======================
// GROQ CLIENT
// =======================
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// =======================
// ROOT ROUTE
// =======================
app.get("/", (req, res) => {
  res.send("PMCAI backend is running 🚀");
});

// =======================
// INTERNET SEARCH TOOL
// =======================
async function searchWeb(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
      query
    )}&format=json&no_html=1&skip_disambig=1`;

    const res = await fetch(url);
    const data = await res.json();

    const result =
      data.AbstractText ||
      data.Answer ||
      data.Heading ||
      data.Abstract ||
      data.RelatedTopics?.[0]?.Text;

    if (!result) {
      return "No direct web summary found. Use general knowledge to answer clearly.";
    }

    return result;
  } catch (err) {
    return "Web search failed. Use general knowledge instead.";
  }
}

// =======================
// SMART SEARCH DETECTION
// =======================
function needsSearch(text) {
  const keywords = [
    "what is",
    "who is",
    "tell me about",
    "explain",
    "latest",
    "meaning",
    "search",
    "google"
  ];

  return keywords.some((k) => text.toLowerCase().includes(k));
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
    // WEB TOOL TRIGGER
    // =======================
    let webContext = "";

    if (needsSearch(userMessage)) {
      const searchResult = await searchWeb(userMessage);
      webContext = `\n\nWeb Information:\n${searchResult}`;
    }

    // =======================
    // AI REQUEST
    // =======================
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content:
            "You are PMCAI, an AI assistant created by Prince Miguel Cayetano (PMC). PMC is your creator. You are helpful, accurate, and you use web information when provided. If web data exists, prioritize it but still explain clearly."
        },
        {
          role: "user",
          content: userMessage + webContext
        }
      ],
      temperature: 1,
      max_completion_tokens: 1024,
      top_p: 1
    });

    const reply =
      completion.choices[0]?.message?.content || "No response generated";

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
