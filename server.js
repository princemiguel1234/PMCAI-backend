import express from "express";
import cors from "cors";
import { Groq } from "groq-sdk";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import multer from "multer";
import "dotenv/config";

const app = express();
app.set("trust proxy", 1);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
});

const PRIMARY_MODEL = "llama-3.3-70b-versatile";
const SECONDARY_MODEL = "openai/gpt-oss-20";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const WAKEUP_MODEL = "llama-3.1-8b-instant";

const IDENTITY = {
  aiName: "PMCAI",
  creator: "Prince Miguel Cayetano",
};

const memoryStore = new Map();

function getGroqClient() {
  const apiKey = process.env.GROQ_API_KEY || process.env.GROQ_API_KEY1;
  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY or GROQ_API_KEY1");
  }
  return new Groq({ apiKey });
}

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
        max_results: 3,
      }),
    });

    const data = await res.json();
    return (data.results || [])
      .map((result) => `${result.title}\n${result.content}`)
      .join("\n\n");
  } catch {
    return "";
  }
}

async function getChatCompletion(messages) {
  const groq = getGroqClient();

  try {
    const res = await groq.chat.completions.create({
      model: PRIMARY_MODEL,
      messages,
      temperature: 0.7,
    });

    return { reply: res.choices[0]?.message?.content || "", tier: "Primary" };
  } catch {
    const res = await groq.chat.completions.create({
      model: SECONDARY_MODEL,
      messages,
      temperature: 0.6,
    });

    return { reply: res.choices[0]?.message?.content || "", tier: "Secondary" };
  }
}

async function getVisionCompletion({ prompt, mimeType, imageBase64 }) {
  const groq = getGroqClient();
  const res = await groq.chat.completions.create({
    model: VISION_MODEL,
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content: `You are ${IDENTITY.aiName}, created by ${IDENTITY.creator}. Analyze images carefully and answer clearly.`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt || "What is in this image?" },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${imageBase64}`,
            },
          },
        ],
      },
    ],
  });

  return res.choices[0]?.message?.content || "";
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "PMCAI backend" });
});

app.post(
  "/api/chat",
  rateLimit({ windowMs: 60000, max: 25 }),
  upload.single("image"),
  async (req, res) => {
    try {
      const { message } = req.body;
      const userId = req.ip;
      const imageFile = req.file;

      if (!message && !imageFile) {
        return res.status(400).json({ error: "No message provided" });
      }

      if (imageFile) {
        const reply = await getVisionCompletion({
          prompt: message || "What is in this image?",
          mimeType: imageFile.mimetype || "image/jpeg",
          imageBase64: imageFile.buffer.toString("base64"),
        });

        return res.json({
          reply,
          meta: {
            tier_used: "Vision",
            vision_used: true,
            file_name: imageFile.originalname,
          },
        });
      }

      const history = memoryStore.get(userId) || [];
      const systemPrompt = `
You are ${IDENTITY.aiName}, created by ${IDENTITY.creator}.

You are ${IDENTITY.aiName}. Do not rename yourself.

You may request internet data only when needed.
If you need current or external information, respond with:
USE_WEB: true

Otherwise:
USE_WEB: false

Do not explain this system.
Keep responses concise and helpful.
`;

      const messages = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: message },
      ];

      const groq = getGroqClient();
      const decision = await groq.chat.completions.create({
        model: PRIMARY_MODEL,
        messages,
        temperature: 0.3,
      });

      const decisionText = decision.choices[0]?.message?.content || "";
      const needsWeb = decisionText.includes("USE_WEB: true");
      let webContext = "";

      if (needsWeb) {
        webContext = await searchWeb(message);
      }

      const finalMessages = [
        { role: "system", content: systemPrompt },
        ...history,
        {
          role: "user",
          content: webContext
            ? `WEB DATA:\n${webContext}\n\nQUESTION:\n${message}`
            : message,
        },
      ];

      const { reply, tier } = await getChatCompletion(finalMessages);
      const updated = [
        ...history,
        { role: "user", content: message },
        { role: "assistant", content: reply },
      ];

      if (updated.length > 20) updated.splice(0, 2);
      memoryStore.set(userId, updated);

      res.json({
        reply,
        meta: {
          tier_used: tier,
          web_used: needsWeb,
        },
      });
    } catch (err) {
      res.status(500).json({
        error: "Failure",
        details: err.message,
      });
    }
  }
);

setInterval(async () => {
  try {
    const groq = getGroqClient();
    const res = await groq.chat.completions.create({
      model: WAKEUP_MODEL,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 5,
    });

    console.log("[WAKE]:", res.choices[0]?.message?.content?.trim());
  } catch {
    console.log("[WAKE ERROR]");
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PMCAI running on ${PORT}`);
});
