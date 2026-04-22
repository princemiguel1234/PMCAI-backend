import express from "express";
import { Groq } from "groq-sdk";

const app = express();
app.use(express.json());

// Groq client (API key comes from Render environment variables)
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Main chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (!userMessage) {
      return res.status(400).json({ error: "No message provided" });
    }

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [
        {
          role: "system",
          content: "You are PMCAI, a helpful AI assistant."
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
    console.error(err);
    res.status(500).json({ error: "AI request failed" });
  }
});

// Start server (Render uses PORT automatically)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PMCAI backend running on port ${PORT}`);
});
