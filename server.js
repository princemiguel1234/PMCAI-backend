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
const USER_MODEL = "llama-3.3-70b-versatile"; 
const WAKEUP_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"; // Terminal Only

const IDENTITY = {
  aiName: "PMCAI",
  creator: "Prince Miguel Cayetano"
};

const memoryStore = new Map();

// =======================
// 🌐 WEB SEARCH
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
// 💬 USER CHAT (LLAMA 3.3)
// =======================
app.use(cors());
app.use(express.json());

app.post("/api/chat", async (req, res) => {
  try {
    const { message, useWeb } = req.body;
    const userId = req.ip;
    if (!message) return res.status(400).json({ error: "No message" });

    // 1. Get Memory
    const history = memoryStore.get(userId) || [];

    // 2. Internet Context
    let webContext = "";
    if (useWeb) webContext = await searchWeb(message);

    // 3. System Prompt
    const systemPrompt = `You are ${IDENTITY.aiName} by ${IDENTITY.creator}. Use provided internet data to be accurate. Be direct.`;

    // 4. Groq Call
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY1 });
    const completion = await groq.chat.completions.create({
      model: USER_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: `${message}\n\nInternet Data: ${webContext}` }
      ],
      temperature: 0.7,
    });

    const reply = completion.choices[0]?.message?.content;

    // 5. Update Memory (Only for User Model)
    const newHistory = [...history, { role: "user", content: message }, { role: "assistant", content: reply }];
    if (newHistory.length > 20) newHistory.splice(0, 2);
    memoryStore.set(userId, newHistory);

    // 6. Final Response (No <think> tags)
    res.json({ reply, sources: useWeb ? [webContext] : [] });

  } catch (err) {
    res.status(500).json({ error: "LLaMA 3 Error" });
  }
});

// =======================
// ⏰ AUTO-WAKEUP (LLAMA 4 SCOUT)
// =======================
// Runs every 10 minutes. Output is TERMINAL ONLY. No memory. No internet.
setInterval(async () => {
  console.log("--- Executing LLaMA 4 Scout Wakeup ---");
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY1 });
    const completion = await groq.chat.completions.create({
      model: WAKEUP_MODEL,
      messages: [
        { role: "user", content: "Rebooting Server Dont say a sentence Just Say 1 Word" }
      ],
      max_tokens: 10,
    });

    const terminalReply = completion.choices[0]?.message?.content?.trim();
    console.log(`[LLaMA 4 RESPONSE]: ${terminalReply}`);
  } catch (err) {
    console.log("[LLaMA 4 ERROR]: Wakeup model failed or key invalid.");
  }
}, 10 * 60 * 1000); // 10 Minutes

// =======================
// 🚀 SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PMCAI Online. LLaMA 3.3 for Users | LLaMA 4 Scout for Terminal.`);
});
