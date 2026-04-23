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
// TIMEOUT WRAPPER
// =======================
const timeout = (ms) =>
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout")), ms)
  );

// =======================
// 🌐 BETTER WEB ENGINE (DuckDuckGo + Wikipedia fallback)
// =======================
async function searchWeb(query) {
  try {
    // 1. DuckDuckGo Instant API
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(
      query
    )}&format=json&no_html=1&skip_disambig=1`;

    const ddgRes = await fetch(ddgUrl);
    const ddg = await ddgRes.json();

    let results = {
      query,
      sources: [],
    };

    // =======================
    // DDG DATA
    // =======================
    if (ddg.Heading) {
      results.sources.push({
        type: "topic",
        text: ddg.Heading,
      });
    }

    if (ddg.AbstractText) {
      results.sources.push({
        type: "summary",
        text: ddg.AbstractText,
      });
    }

    if (ddg.Answer) {
      results.sources.push({
        type: "answer",
        text: ddg.Answer,
      });
    }

    if (ddg.RelatedTopics?.length) {
      ddg.RelatedTopics.slice(0, 5).forEach((t) => {
        if (t.Text) {
          results.sources.push({
            type: "related",
            text: t.Text,
          });
        }
      });
    }

    // =======================
    // WIKIPEDIA FALLBACK (IMPORTANT IMPROVEMENT)
    // =======================
    if (!ddg.AbstractText) {
      const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
        query
      )}`;

      try {
        const wikiRes = await fetch(wikiUrl);
        const wiki = await wikiRes.json();

        if (wiki.extract) {
          results.sources.push({
            type: "wiki",
            text: wiki.extract,
          });
        }
      } catch (e) {
        // ignore wiki failure
      }
    }

    return results;
  } catch (err) {
    return {
      error: true,
      message: "Web search failed",
      sources: [],
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
    // STRICT ANTI-HALLUCINATION RULES
    // =======================
    const systemPrompt = `
You are PMCAI, an AI assistant created by Prince Miguel Cayetano.

CRITICAL RULES:
- ONLY use WEB SOURCES if they exist
- DO NOT invent news, dates, events, or products
- If no real data exists, say "No verified information found"
- NEVER create fake future events
- Summarize only real provided data
- Be concise and accurate
`;

    // =======================
    // CLEAN CONTEXT
    // =======================
    const fullPrompt = `
USER QUESTION:
${userMessage}

WEB SOURCES (use ONLY this, do not hallucinate):
${JSON.stringify(webData, null, 2)}
`;

    // =======================
    // GROQ REQUEST
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
      temperature: 0.4, // lower = less hallucination
      max_completion_tokens: 1024,
      top_p: 1,
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "No response generated";

    res.json({
      reply,
      hasWeb: !webData.error,
      sources: webData.sources || [],
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
