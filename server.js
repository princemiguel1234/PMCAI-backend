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

const MAX_HISTORY_MESSAGES = 14;
const MAX_MEMORY_MESSAGES = 20;
const MEMORY_TTL_MS = 6 * 60 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 12000;
const MAX_WEB_RESULTS = 5;
const WEB_QUERY_CHAR_LIMIT = 500;
const WEB_CONTEXT_CHAR_LIMIT = 5000;

const IDENTITY = {
  aiName: "PMCAI",
  creator: "Prince Miguel Cayetano",
};

const memoryStore = new Map();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

function isImageMimeType(mimeType = "") {
  return /^image\//i.test(mimeType);
}

function normalizeWhitespace(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeText(value, maxLength = 20000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .map((entry) => ({
      role: entry?.role,
      content: normalizeText(entry?.content, 12000),
    }))
    .filter((entry) => ["user", "assistant", "system"].includes(entry.role) && entry.content);
}

function parseHistoryInput(rawHistory) {
  if (Array.isArray(rawHistory)) {
    return normalizeHistory(rawHistory);
  }

  if (typeof rawHistory === "string" && rawHistory.trim()) {
    try {
      return normalizeHistory(JSON.parse(rawHistory));
    } catch {
      return [];
    }
  }

  return [];
}

function pruneExpiredMemory() {
  const cutoff = Date.now() - MEMORY_TTL_MS;

  for (const [key, entry] of memoryStore.entries()) {
    if (!entry?.updatedAt || entry.updatedAt < cutoff) {
      memoryStore.delete(key);
    }
  }
}

function buildConversationKey({ userId, conversationId }) {
  return `${userId}:${conversationId || "default"}`;
}

function getStoredHistory(key) {
  pruneExpiredMemory();
  const entry = memoryStore.get(key);
  if (!entry) return [];

  entry.updatedAt = Date.now();
  return normalizeHistory(entry.history).slice(-MAX_HISTORY_MESSAGES);
}

function saveStoredHistory(key, history) {
  memoryStore.set(key, {
    history: normalizeHistory(history).slice(-MAX_MEMORY_MESSAGES),
    updatedAt: Date.now(),
  });
}

function buildSystemPrompt(userSystemPrompt = "") {
  const parts = [
    `You are ${IDENTITY.aiName}, created by ${IDENTITY.creator}.`,
    `You are ${IDENTITY.aiName}. Do not rename yourself.`,
    "Keep responses concise, helpful, and honest.",
    "Use web data only when it is actually needed or when it is provided to you.",
    "If web data is missing or weak, say what you can without inventing facts or sources.",
  ];

  const cleanedUserPrompt = normalizeText(userSystemPrompt, 4000);
  if (cleanedUserPrompt) {
    parts.push(`Additional chat instructions:\n${cleanedUserPrompt}`);
  }

  return parts.join("\n\n");
}

function logChatTranscript({ ip, conversationId, userMessage, aiMessage }) {
  const label = conversationId ? `${ip}:${conversationId}` : ip;
  console.log(`( USER ${label} ) : ${userMessage || "[no text]"}`);
  console.log(`( PMCAI Response ) : ${aiMessage || "[empty response]"}`);
}

function getGroqApiEntries() {
  return [
    { label: "key1", value: process.env.GROQ_API_KEY1 },
    { label: "key2", value: process.env.GROQ_API_KEY2 },
    { label: "key3", value: process.env.GROQ_API_KEY3 },
    { label: "legacy", value: process.env.GROQ_API_KEY },
  ].filter((entry) => entry.value);
}

function getGroqClient(apiKey) {
  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY1, GROQ_API_KEY2, GROQ_API_KEY3, or GROQ_API_KEY");
  }

  return new Groq({ apiKey });
}

async function runGroqWithFallback(requestFactory, options = {}) {
  const entries = getGroqApiEntries();
  if (!entries.length) {
    throw new Error("Missing GROQ_API_KEY1, GROQ_API_KEY2, GROQ_API_KEY3, or GROQ_API_KEY");
  }

  let lastError = null;

  for (const entry of entries) {
    try {
      const groq = getGroqClient(entry.value);
      const result = await requestFactory(groq, entry);
      console.log(`[GROQ] Success via ${entry.label}`);
      return result;
    } catch (error) {
      lastError = error;
      console.log(`[GROQ] ${entry.label} failed: ${error.message}`);
    }
  }

  if (options.visionFallback) {
    const fallbackEntry = entries.find((entry) => entry.label === "key1") || entries[0];
    try {
      const groq = getGroqClient(fallbackEntry.value);
      const result = await options.visionFallback(groq, fallbackEntry);
      console.log(`[GROQ] Vision fallback succeeded via ${fallbackEntry.label}`);
      return result;
    } catch (fallbackError) {
      console.log(`[GROQ] Vision fallback failed via ${fallbackEntry.label}: ${fallbackError.message}`);
      throw new Error(`All API keys failed. Vision fallback also failed: ${fallbackError.message}`);
    }
  }

  throw lastError || new Error("All Groq API keys failed");
}

async function runDecisionCompletion(messages) {
  return runGroqWithFallback(
    async (groq) => {
      try {
        return await groq.chat.completions.create({
          model: WAKEUP_MODEL,
          messages,
          temperature: 0,
          max_tokens: 40,
        });
      } catch {
        return await groq.chat.completions.create({
          model: PRIMARY_MODEL,
          messages,
          temperature: 0,
          max_tokens: 40,
        });
      }
    },
    {
      visionFallback: (groq) => groq.chat.completions.create({
        model: SECONDARY_MODEL,
        messages,
        temperature: 0,
        max_tokens: 40,
      }),
    }
  );
}

function deriveSearchQuery(message = "") {
  const cleaned = normalizeText(message, 8000);
  if (!cleaned) return "";

  const userLines = [...cleaned.matchAll(/(?:^|\n)User:\s*(.+)/gim)];
  const lastUserLine = userLines.at(-1)?.[1];
  if (lastUserLine) {
    return normalizeWhitespace(lastUserLine).slice(0, WEB_QUERY_CHAR_LIMIT);
  }

  const explicitQuestion = cleaned.match(/QUESTION:\s*([\s\S]+)/i)?.[1];
  if (explicitQuestion) {
    return normalizeWhitespace(explicitQuestion).slice(0, WEB_QUERY_CHAR_LIMIT);
  }

  return normalizeWhitespace(cleaned).slice(0, WEB_QUERY_CHAR_LIMIT);
}

function shouldForceWebSearch(message = "") {
  const value = message.toLowerCase();

  return [
    /https?:\/\//i,
    /\b(search|look up|lookup|browse|web|internet|online)\b/i,
    /\b(latest|current|today|tonight|this week|recent|breaking|news|weather|forecast)\b/i,
    /\b(price|stock|market cap|exchange rate|score|standings|schedule|release date|version)\b/i,
    /\b(what happened|what is happening|who won|when is|where is|live update)\b/i,
  ].some((pattern) => pattern.test(value));
}

function parseUseWebDecision(rawDecision = "") {
  const text = rawDecision.trim();
  if (!text) return false;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return Boolean(parsed.use_web);
    } catch {
      // Fall through to tolerant parsing.
    }
  }

  if (/use_web\s*[:=]\s*true/i.test(text)) return true;
  if (/use_web\s*[:=]\s*false/i.test(text)) return false;
  if (/^\s*true\s*$/i.test(text)) return true;
  if (/^\s*false\s*$/i.test(text)) return false;

  return false;
}

async function shouldUseWeb({ message, history, systemPrompt }) {
  const searchQuery = deriveSearchQuery(message);
  if (!searchQuery) return false;

  if (shouldForceWebSearch(searchQuery)) {
    return true;
  }

  if (!process.env.TAVILY_API_KEY) {
    return false;
  }

  const recentHistory = normalizeHistory(history).slice(-4);
  const decisionMessages = [
    {
      role: "system",
      content: [
        "Decide whether the assistant needs live, current, or external web data to answer the latest user message well.",
        "Reply with JSON only.",
        'Use exactly this shape: {"use_web": true} or {"use_web": false}.',
      ].join(" "),
    },
    ...recentHistory,
    {
      role: "user",
      content: `Chat instructions:\n${normalizeText(systemPrompt, 2000) || "(none)"}\n\nLatest user message:\n${searchQuery}`,
    },
  ];

  try {
    const decision = await runDecisionCompletion(decisionMessages);
    const decisionText = decision.choices[0]?.message?.content || "";
    return parseUseWebDecision(decisionText);
  } catch (error) {
    console.log(`[WEB] decision failed: ${error.message}`);
    return false;
  }
}

function buildWebContext({ answer, results }) {
  const sections = [];

  if (answer) {
    sections.push(`WEB SUMMARY:\n${normalizeText(answer, 1200)}`);
  }

  if (results.length) {
    sections.push("WEB SOURCES:");
    for (const [index, result] of results.entries()) {
      sections.push(
        `${index + 1}. ${result.title}\nURL: ${result.url}\nSnippet: ${normalizeText(result.content, 700)}`
      );
    }
  }

  return sections.join("\n\n").slice(0, WEB_CONTEXT_CHAR_LIMIT);
}

async function searchWeb(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return {
      used: false,
      query,
      results: [],
      answer: "",
      contextText: "",
      error: "Missing TAVILY_API_KEY",
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        include_answer: true,
        include_raw_content: false,
        max_results: MAX_WEB_RESULTS,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Tavily ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const results = Array.isArray(data.results)
      ? data.results
          .map((result) => ({
            title: normalizeText(result.title, 200) || "Untitled source",
            url: normalizeText(result.url, 500),
            content: normalizeText(result.content, 900),
            score: typeof result.score === "number" ? result.score : null,
          }))
          .filter((result) => result.url || result.content)
      : [];

    const answer = normalizeText(data.answer, 1200);
    const contextText = buildWebContext({ answer, results });
    console.log(`[WEB] query="${query}" results=${results.length}`);

    return {
      used: Boolean(answer || results.length),
      query,
      answer,
      results,
      contextText,
      error: "",
    };
  } catch (error) {
    console.log(`[WEB] search failed: ${error.message}`);
    return {
      used: false,
      query,
      results: [],
      answer: "",
      contextText: "",
      error: error.message,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getChatCompletion(messages) {
  return runGroqWithFallback(
    async (groq) => {
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
    },
    {
      visionFallback: async (groq) => {
        const res = await groq.chat.completions.create({
          model: VISION_MODEL,
          messages,
          temperature: 0.6,
        });
        return { reply: res.choices[0]?.message?.content || "", tier: "Vision Fallback" };
      },
    }
  );
}

async function getVisionCompletion({ prompt, mimeType, imageBase64, systemPrompt = "" }) {
  return runGroqWithFallback(async (groq) => {
    const res = await groq.chat.completions.create({
      model: VISION_MODEL,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(systemPrompt),
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
  });
}

async function getTextReplyWithMemory({ message, userId, conversationId, systemPrompt, history }) {
  const cleanedMessage = normalizeText(message);
  const memoryKey = buildConversationKey({ userId, conversationId });
  const providedHistory = normalizeHistory(history).slice(-MAX_HISTORY_MESSAGES);
  const baseHistory = providedHistory.length ? providedHistory : getStoredHistory(memoryKey);
  const searchQuery = deriveSearchQuery(cleanedMessage);
  const needsWeb = await shouldUseWeb({
    message: cleanedMessage,
    history: baseHistory,
    systemPrompt,
  });

  const webSearch = needsWeb ? await searchWeb(searchQuery) : {
    used: false,
    query: searchQuery,
    results: [],
    answer: "",
    contextText: "",
    error: "",
  };

  const finalMessages = [
    {
      role: "system",
      content: [
        buildSystemPrompt(systemPrompt),
        webSearch.used
          ? "When WEB DATA is provided, use it carefully and prefer those sources over guesses."
          : "",
      ].filter(Boolean).join("\n\n"),
    },
    ...baseHistory,
    {
      role: "user",
      content: webSearch.contextText
        ? `WEB DATA:\n${webSearch.contextText}\n\nUSER QUESTION:\n${cleanedMessage}`
        : cleanedMessage,
    },
  ];

  const { reply, tier } = await getChatCompletion(finalMessages);
  const updatedHistory = [
    ...baseHistory,
    { role: "user", content: cleanedMessage },
    { role: "assistant", content: reply },
  ].slice(-MAX_MEMORY_MESSAGES);

  saveStoredHistory(memoryKey, updatedHistory);

  return {
    reply,
    meta: {
      tier_used: tier,
      web_requested: needsWeb,
      web_used: Boolean(webSearch.used),
      web_query: webSearch.query,
      web_results_count: webSearch.results.length,
      web_error: webSearch.error || undefined,
      sources: webSearch.results.slice(0, 3).map((result) => ({
        title: result.title,
        url: result.url,
      })),
      vision_used: false,
      conversation_id: conversationId || "default",
    },
  };
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "PMCAI backend" });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "PMCAI backend",
    aiName: IDENTITY.aiName,
    web_search_available: Boolean(process.env.TAVILY_API_KEY),
    uptime_seconds: Math.round(process.uptime()),
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    ok: true,
    aiName: IDENTITY.aiName,
    model: PRIMARY_MODEL,
    vision_model: VISION_MODEL,
    secondary_model: SECONDARY_MODEL,
    web_search_available: Boolean(process.env.TAVILY_API_KEY),
    image_upload_limit_mb: 8,
  });
});

app.post(
  "/api/chat",
  rateLimit({ windowMs: 60000, max: 25 }),
  upload.single("image"),
  async (req, res) => {
    try {
      const message = normalizeText(req.body?.message);
      const userId = req.ip;
      const imageFile = req.file;
      const conversationId = normalizeText(req.body?.conversationId, 120) || "default";
      const systemPrompt = normalizeText(req.body?.systemPrompt, 4000);
      const history = parseHistoryInput(req.body?.history);

      if (!message && !imageFile) {
        return res.status(400).json({ error: "No message provided" });
      }

      if (imageFile && isImageMimeType(imageFile.mimetype)) {
        try {
          const reply = await getVisionCompletion({
            prompt: message || "What is in this image?",
            mimeType: imageFile.mimetype || "image/jpeg",
            imageBase64: imageFile.buffer.toString("base64"),
            systemPrompt,
          });

          const assistantHistory = [
            ...history.slice(-MAX_HISTORY_MESSAGES),
            { role: "user", content: message || "What is in this image?" },
            { role: "assistant", content: reply },
          ];
          saveStoredHistory(buildConversationKey({ userId, conversationId }), assistantHistory);

          logChatTranscript({
            ip: userId,
            conversationId,
            userMessage: message || `[image] ${imageFile.originalname || "upload"}`,
            aiMessage: reply,
          });

          return res.json({
            reply,
            meta: {
              tier_used: "Vision",
              vision_used: true,
              file_name: imageFile.originalname,
              conversation_id: conversationId,
            },
          });
        } catch (visionError) {
          const fallbackPrompt = message
            || `The uploaded file "${imageFile.originalname || "image"}" could not be analyzed by the vision model. Respond helpfully without claiming to see the image.`;
          const fallback = await getTextReplyWithMemory({
            message: fallbackPrompt,
            userId,
            conversationId,
            systemPrompt,
            history,
          });

          logChatTranscript({
            ip: userId,
            conversationId,
            userMessage: message || `[image fallback] ${imageFile.originalname || "upload"}`,
            aiMessage: fallback.reply,
          });

          return res.json({
            ...fallback,
            meta: {
              ...fallback.meta,
              vision_used: false,
              vision_fallback: true,
              vision_error: visionError.message,
              file_name: imageFile.originalname,
            },
          });
        }
      }

      const textResponse = await getTextReplyWithMemory({
        message,
        userId,
        conversationId,
        systemPrompt,
        history,
      });

      logChatTranscript({
        ip: userId,
        conversationId,
        userMessage: message,
        aiMessage: textResponse.reply,
      });

      return res.json(textResponse);
    } catch (err) {
      return res.status(500).json({
        error: "Failure",
        details: err.message,
      });
    }
  }
);

app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "File too large",
      details: "Uploads are limited to 8 MB.",
    });
  }

  return next(err);
});

setInterval(async () => {
  pruneExpiredMemory();

  try {
    const res = await runGroqWithFallback(
      (groq) => groq.chat.completions.create({
        model: WAKEUP_MODEL,
        messages: [
          {
            role: "system",
            content: "Reply with 'ok' only.",
          },
          {
            role: "user",
            content: ".",
          },
        ],
        max_tokens: 5,
      }),
      {
        visionFallback: (groq) => groq.chat.completions.create({
          model: VISION_MODEL,
          messages: [
            {
              role: "system",
              content: "Reply with 'ok' only.",
            },
            {
              role: "user",
              content: ".",
            },
          ],
          max_tokens: 5,
        }),
      }
    );

    console.log("[WAKE]:", res.choices[0]?.message?.content?.trim());
  } catch {
    console.log("[WAKE ERROR]");
  }
}, 14 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PMCAI running on ${PORT}`);
});
