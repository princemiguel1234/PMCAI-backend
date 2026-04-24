import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();
app.set("trust proxy", 1);

// =======================
// ⚙️ CONFIGURATION
// =======================
const PRIMARY_MODEL = "llama-3.3-70b-versatile";
const SECONDARY_MODEL = "openai/gpt-oss-20"; 
const WAKEUP_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

const IDENTITY = {
  aiName: "PMCAI",
  creator: "Prince Miguel Cayetano"
};

// Memory store to keep track of conversations per User IP
const memoryStore = new Map();

// =======================
// 🌐 WEB SEARCH (TAVILY)
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
      body: JSON.stringify({ query, max_results: 3 }),
    });
    const data = await res.json();
    return (data.results || []).map(r => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n");
  } catch { return ""; }
}

// =======================
// 🧠 INTELLIGENCE TIERING (NO <THINK> TAGS)
// =======================
async function getChatCompletion(messages) {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY1 });

  try {
    // --- TRY PRIMARY MODEL ---
    console.log(`[Tier 1] Requesting Primary: ${PRIMARY_MODEL}`);
    const primary = await groq.chat.completions.create({
      model: PRIMARY_MODEL,
      messages,
      temperature: 0.7,
    });
    return { reply: primary.choices[0]?.message?.content, tier: "Primary" };

  } catch (err) {
    console.error(`[Tier 1 Error] Primary failed. Pivoting to Secondary...`);
    
    try {
      // --- FALLBACK TO SECONDARY ---
      const secondary = await groq.chat.completions.create({
        model: SECONDARY_MODEL,
        messages,
        temperature: 0.6,
      });
      return { reply: secondary.choices[0]?.message?.content, tier: "Secondary" };

    } catch (secErr) {
      console.error(`[Tier 2 Error] Secondary also failed.`);
      throw new Error("All intelligence tiers are currently offline.");
    }
  }
}

// =======================
// 💬 USER CHAT ENDPOINT
// =======================
app.use(cors());
app.use(express.json());

app.post("/api/chat", rateLimit({ windowMs: 60000, max: 25 }), async (req, res) => {
  try {
    const { message, useWeb } = req.body;
    const userId = req.ip;

    if (!message) return res.status(400).json({ error: "No message provided" });

    // 1. Get Conversation History
    const history = memoryStore.get(userId) || [];

    // 2. Fetch Internet Data if requested
    let webContext = "";
    if (useWeb) {
      webContext = await searchWeb(message);
    }

    // 3. Build System Instructions
    const systemPrompt = `You are ${IDENTITY.aiName}, a Normal AI created by ${IDENTITY.creator}. 
    Your tone is direct, helpful, and concise. Do not use reasoning tags or headers like "processed". 
    If internet data is provided, use it to ensure accuracy.${IDENTITY.creator} is a Normal Guy.`;

    // 4. Create Message Array
    const payload = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: webContext ? `INTERNET DATA:\n${webContext}\n\nUSER QUESTION:\n${message}` : message }
    ];

    // 5. Get AI Response (Clean)
    const { reply, tier } = await getChatCompletion(payload);

    // 6. Update Memory (Limit to last 10 interactions)
    const updatedHistory = [...history, { role: "user", content: message }, { role: "assistant", content: reply }];
    if (updatedHistory.length > 20) updatedHistory.splice(0, 2);
    memoryStore.set(userId, updatedHistory);

    // 7. Send Response to User
    res.json({ 
      reply, 
      sources: useWeb && webContext ? [webContext] : [],
      meta: { tier_used: tier }
    });

  } catch (err) {
    console.error("Endpoint Error:", err.message);
    res.status(500).json({ error: "Intelligence failure", details: err.message });
  }
});

// =======================
// ⏰ AUTO-WAKEUP (LLAMA 4 SCOUT)
// =======================
// Runs every 10 minutes. Terminal output only. 1-word limit.
setInterval(async () => {
  console.log("--- Executing LLaMA 4 Scout Heartbeat ---");
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY1 });
    const completion = await groq.chat.completions.create({
      model: WAKEUP_MODEL,
      messages: [{ role: "user", content: "Rebooting Server Dont say a sentence Just Say 1 Word" }],
      max_tokens: 5,
    });
    console.log(`[LLaMA 4 RESPONSE]: ${completion.choices[0]?.message?.content?.trim()}`);
  } catch (err) {
    console.log("[LLaMA 4 ERROR]: Heartbeat failed.");
  }
}, 10 * 60 * 1000);

// =======================
// 🚀 SERVER START
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PMCAI Backend Live on Port ${PORT}`);
  console.log(`Primary: ${PRIMARY_MODEL} | Fallback: ${SECONDARY_MODEL}`);
});
