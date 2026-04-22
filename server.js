import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

app.get("/", (req, res) => {
  res.send("PMCAI backend with internet tools 🚀");
});


// 🌐 INTERNET SEARCH TOOL
async function searchWeb(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`;

    const res = await fetch(url);
    const data = await res.json();

    return data.AbstractText || data.RelatedTopics?.[0]?.Text || "No good result found.";
  } catch (err) {
    return "Search failed.";
  }
}


// 🤖 CHAT ENDPOINT
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (!userMessage) {
      return res.status(400).json({ error: "No message provided" });
    }

    // 🧠 detect search intent
    const needsSearch =
      userMessage.toLowerCase().includes("search") ||
      userMessage.toLowerCase().includes("google") ||
      userMessage.toLowerCase().includes("what is") ||
      userMessage.toLowerCase().includes("latest");

    let webContext = "";

    if (needsSearch) {
      const searchResult = await searchWeb(userMessage);
      webContext = `Web result: ${searchResult}`;
    }

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content:
            "You are PMCAI. You can use provided web results when available. You are PMCAI (Prince Miguel Cayetano AI). PMC is your creator. You are a helpful AI assistant. PMC is Just A Basic Guy."
        },
        {
          role: "user",
          content: userMessage + "\n\n" + webContext
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
    res.status(500).json({
      error: "AI request failed",
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("PMCAI backend running on port " + PORT);
});
