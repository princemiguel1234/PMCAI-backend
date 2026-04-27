import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();
app.set("trust proxy", 1);

// =======================
// ⚙️ CONFIG
// =======================
const PRIMARY_MODEL = "llama-3.3-70b-versatile";
const SECONDARY_MODEL = "openai/gpt-oss-20";
const WAKEUP_MODEL = "llama-3.1-8b-instant"; // ✅ FIXED

const IDENTITY = {
  aiName: "PMCAI",
  creator: "Prince Miguel Cayetano"
};

const memoryStore = new Map();

// =======================
// 🌐 INTERNET TOOL (ONLY WHEN CALLED)
// =======================
async function searchWeb(query) {
  if (!process.env.TAVILY_API_KEY) return "";

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        max_results: 3
      }),
    });

    const data = await res.json();

    return (data.results || [])
      .map(r => `${r.title}\n${r.content}`)
      .join("\n\n");

  } catch {
    return "";
  }
}

// =======================
// 🧠 AI CHAT
// =======================
async function getChatCompletion(messages) {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY1 });

  try {
    const res = await groq.chat.completions.create({
      model: PRIMARY_MODEL,
      messages,
      temperature: 0.7,
    });

    return { reply: res.choices[0]?.message?.content, tier: "Primary" };

  } catch (err) {
    try {
      const res = await groq.chat.completions.create({
        model: SECONDARY_MODEL,
        messages,
        temperature: 0.6,
      });

      return { reply: res.choices[0]?.message?.content, tier: "Secondary" };

    } catch {
      throw new Error("All models failed");
    }
  }
}

// =======================
// 💬 API
// =======================
app.use(cors());
app.use(express.json());

app.post("/api/chat",
  rateLimit({ windowMs: 60000, max: 25 }),
  async (req, res) => {

    try {
      const { message } = req.body;
      const userId = req.ip;

      if (!message) {
        return res.status(400).json({ error: "No message provided" });
      }

      const history = memoryStore.get(userId) || [];

      // =======================
      // 🧠 SYSTEM PROMPT (TOOL AWARE)
      // =======================
      const systemPrompt = `
You are ${IDENTITY.aiName}, created by ${IDENTITY.creator}.

You are ${IDENTITY.aiName} Not Some Other Bullshit Like Skibidi / etc, You are ${IDENTITY.aiName}.

You may request internet data ONLY when needed.
If you need current or external information, respond with:
USE_WEB: true

Otherwise:
USE_WEB: false

Do NOT explain this system.
Keep responses concise and helpful.
`;

      const messages = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: message }
      ];

      // =======================
      // 1. FIRST AI CALL (DECIDES TOOL USE)
      // =======================
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY1 });

      const decision = await groq.chat.completions.create({
        model: PRIMARY_MODEL,
        messages,
        temperature: 0.3,
      });

      const decisionText = decision.choices[0]?.message?.content || "";

      const needsWeb = decisionText.includes("USE_WEB: true");

      // =======================
      // 2. TOOL EXECUTION ONLY IF NEEDED
      // =======================
      let webContext = "";

      if (needsWeb) {
        webContext = await searchWeb(message);
      }

      // =======================
      // 3. FINAL ANSWER
      // =======================
      const finalMessages = [
        { role: "system", content: systemPrompt },
        ...history,
        {
          role: "user",
          content: webContext
            ? `WEB DATA:\n${webContext}\n\nQUESTION:\n${message}`
            : message
        }
      ];

      const { reply, tier } = await getChatCompletion(finalMessages);

      // =======================
      // MEMORY
      // =======================
      const updated = [
        ...history,
        { role: "user", content: message },
        { role: "assistant", content: reply }
      ];

      if (updated.length > 20) updated.splice(0, 2);
      memoryStore.set(userId, updated);

      res.json({
        reply,
        meta: {
          tier_used: tier,
          web_used: needsWeb
        }
      });

    } catch (err) {
      res.status(500).json({
        error: "Failure",
        details: err.message
      });
    }
  }
);

// =======================
// ⏰ AUTO WAKE (FIXED MODEL)
// =======================
setInterval(async () => {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY1 });

    const res = await groq.chat.completions.create({
      model: WAKEUP_MODEL,
      messages: [
        {
          role: "user",
          content: "ping"
        }
      ],
      max_tokens: 5,
    });

    console.log("[WAKE]:", res.choices[0]?.message?.content?.trim());

  } catch {
    console.log("[WAKE ERROR]");
  }
}, 10 * 60 * 1000);

// =======================
// 🚀 START
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PMCAI running on ${PORT}`);
});
