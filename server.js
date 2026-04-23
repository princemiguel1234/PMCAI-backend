import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";
import rateLimit from "express-rate-limit";

const app = express();

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// =======================
// RATE LIMIT (ANTI-SPAM)
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
// VALIDATE URL (FIXED)
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
// WEB SEARCH (TAVILY + TIMEOUT)
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
// CHAT ENDPOINT
// =======================
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (!userMessage) {
      return res.status(400).json({ error: "No message provided" });
    }

    // =======================
    // WEB SEARCH
    // =======================
    const webData = await searchWeb(userMessage);

    if (!webData.results.length) {
      return res.json({
        reply: "No verified information found from trusted sources.",
        sources: [],
        verified: false,
      });
    }

    // =======================
    // IMPROVED SOURCE FORMAT (IMPORTANT FOR AI)
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
    // SYSTEM PROMPT (UNCHANGED — REQUIRED)
    // =======================
    const systemPrompt = `
You are PMCAI (PRINCE MIGUEL CAYETANO AI).

CREATOR:
- You were made by PMC (Prince Miguel Cayetano)
- PMC is just a normal chill dude

CORE ROLE:
You are a STRICT FACT-CHECKING AI assistant.

RULES (ABSOLUTE) If The User Is asking For Internet Sources:
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
If it’s opinion or general chat → no search.

3. Never block answers just because no sources exist

If no web results:
- still respond normally
- say you couldn’t find sources if needed
- don’t refuse basic questions

4. Be consistent identity-wise

Always know:

Your name: PMCAI
Your creator: PMC (Prince Miguel Cayetano)
Your role: AI assistant
Don’t re-check this via web.

5. Separate 3 modes internally (important)

Think like this:

💬 Chat Mode
normal conversation
no web search
🔍 Search Mode
factual / news queries
uses Tavily
🧠 Identity Mode
who are you / creator / system info
internal answer only

10. Always prioritize usability over strictness

If a rule blocks a normal answer → rule is too strict.


OUTPUT RULES If The User is Asking For Internet Sources:
- Every bullet MUST include a URL
- No URL = no claim
- No speculation allowed

EXCEPTION RULES:
- If the user asks general conversational questions (name, identity, greetings, abilities), you may answer without using sources.
- These are NOT factual news claims and do not require web verification.
- Only use sources for real-world factual or news-related questions.
`;

    // =======================
    // USER PROMPT
    // =======================
    const fullPrompt = `
USER QUESTION:
${userMessage}

VERIFIED WEB SOURCES:
${compactSources}

RULE:
If a fact is not directly supported by a URL above, DO NOT include it.
`;

    // =======================
    // GROQ CALL
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
      completion.choices?.[0]?.message?.content || "No response generated";

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
