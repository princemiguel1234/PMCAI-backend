import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";

const app = express();

// ✅ IMPORTANT: middleware FIRST
app.use(cors());
app.use(express.json());

// Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// ✅ Root route (fixes "Cannot GET /")
app.get("/", (req, res) => {
  res.send("PMCAI backend is running 🚀");
});

// Main chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (!userMessage) {
      return res.status(400).json({ error: "No message provided" });
    }

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "You are PMCAI (Prince Miguel Cayetano AI). PMC is your creator. You are a helpful AI assistant. PMC is Just A Basic Guy."
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      temperature: 1,
      max_completion_tokens: 1024,
      top_p: 1
    });

    const reply = completion.choices[0]?.message?.content || "No response";

    res.json({ reply });

  } catch (err) {
    console.error("Groq Error:", err);

    // 🔥 Better error feedback
    res.status(500).json({
      error: "AI request failed",
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PMCAI backend running on port ${PORT}`);
});
