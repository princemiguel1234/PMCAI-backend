import express from "express";
import cors from "cors";
import { Groq, toFile } from "groq-sdk";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import multer from "multer";
import "dotenv/config";

const app = express();
app.set("trust proxy", 1);

const PRIMARY_MODEL = "llama-3.3-70b-versatile";
const SECONDARY_MODEL = "openai/gpt-oss-120";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const WHISPER_MODEL = "whisper-large-v3-turbo";

const MAX_HISTORY_MESSAGES = 14;
const MAX_MEMORY_MESSAGES = 20;
const MEMORY_TTL_MS = 6 * 60 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 12000;
const GROQ_TIMEOUT_MS = 45000;
const TRANSCRIPTION_TIMEOUT_MS = 35000;
const MAX_WEB_RESULTS = 5;
const WEB_QUERY_CHAR_LIMIT = 500;
const WEB_CONTEXT_CHAR_LIMIT = 5000;
const IMAGE_UPLOAD_LIMIT_BYTES = 8 * 1024 * 1024;
const AUDIO_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const MAX_JSON_TEXT_LENGTH = 20000;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const ALLOWED_AUDIO_MIME_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp3",
  "audio/mpga",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/x-flac",
  "audio/m4a",
  "audio/x-m4a",
  "video/webm",
  "video/mp4",
]);

const IDENTITY = {
  aiName: "PMCAI",
  creator: "Prince Miguel Cayetano",
};

const memoryStore = new Map();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

const memoryStorage = multer.memoryStorage();
const imageUpload = multer({
  storage: memoryStorage,
  limits: {
    fileSize: IMAGE_UPLOAD_LIMIT_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (isImageMimeType(file?.mimetype)) {
      cb(null, true);
      return;
    }

    const error = new Error("Unsupported image type");
    error.code = "UNSUPPORTED_FILE_TYPE";
    error.statusCode = 415;
    cb(error);
  },
});
const audioUpload = multer({
  storage: memoryStorage,
  limits: {
    fileSize: AUDIO_UPLOAD_LIMIT_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (isAudioMimeType(file?.mimetype)) {
      cb(null, true);
      return;
    }

    const error = new Error("Unsupported audio type");
    error.code = "UNSUPPORTED_FILE_TYPE";
    error.statusCode = 415;
    cb(error);
  },
});

function isImageMimeType(mimeType = "") {
  return ALLOWED_IMAGE_MIME_TYPES.has(String(mimeType).toLowerCase());
}

function isAudioMimeType(mimeType = "") {
  return ALLOWED_AUDIO_MIME_TYPES.has(String(mimeType).split(";")[0].toLowerCase());
}

function normalizeWhitespace(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeText(value, maxLength = 20000) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .trim()
        .slice(0, maxLength)
    : "";
}

function safeJsonParse(value, fallback = null) {
  if (typeof value !== "string" || value.length > 1_000_000) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sanitizeFileName(value = "upload") {
  const base = String(value).split(/[\\/]/).pop() || "upload";
  return base.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "upload";
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

function compactHistory(history, maxMessages = MAX_MEMORY_MESSAGES) {
  const compacted = [];

  for (const entry of normalizeHistory(history)) {
    const previous = compacted[compacted.length - 1];
    if (previous && previous.role === entry.role && previous.content === entry.content) {
      continue;
    }
    compacted.push(entry);
  }

  return compacted.slice(-maxMessages);
}

function parseHistoryInput(rawHistory) {
  if (Array.isArray(rawHistory)) {
    return compactHistory(rawHistory, MAX_HISTORY_MESSAGES);
  }

  if (typeof rawHistory === "string" && rawHistory.trim()) {
    return compactHistory(safeJsonParse(rawHistory, []), MAX_HISTORY_MESSAGES);
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
  return compactHistory(entry.history, MAX_HISTORY_MESSAGES);
}

function saveStoredHistory(key, history) {
  const compacted = compactHistory(history, MAX_MEMORY_MESSAGES);
  if (!compacted.length) return;

  memoryStore.set(key, {
    history: compacted,
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
  console.log(`( USER ${ip} ) : ${userMessage || "[no text]"}`);
  console.log(`( AI Response ) : ${aiMessage || "[empty response]"}`);
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

  return new Groq({ apiKey, timeout: GROQ_TIMEOUT_MS });
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = "REQUEST_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function runGroqWithFallback(requestFactory, options = {}) {
  const label = options.label || "request";
  const timeoutMs = options.timeoutMs || GROQ_TIMEOUT_MS;
  const entries = getGroqApiEntries();
  if (!entries.length) {
    throw new Error("Missing GROQ_API_KEY1, GROQ_API_KEY2, GROQ_API_KEY3, or GROQ_API_KEY");
  }

  let lastError = null;

  for (const entry of entries) {
    try {
      const groq = getGroqClient(entry.value);
      const result = await withTimeout(
        Promise.resolve(requestFactory(groq, entry)),
        timeoutMs,
        `${label} via ${entry.label}`
      );
      console.log(`[GROQ] ${label} succeeded via ${entry.label}`);
      return result;
    } catch (error) {
      lastError = error;
      console.log(`[GROQ] ${label} failed via ${entry.label}: ${error.message}`);
    }
  }

  throw lastError || new Error(`All Groq API keys failed for ${label}`);
}

function buildSearchQuerySimple(message = "") {
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

function shouldUseWebSimple(message = "") {
  const value = normalizeText(message, 8000).toLowerCase();
  if (!value) return false;

  return [
    /https?:\/\//i,
    /\b(search|look up|lookup|browse|google|web|internet|online)\b/i,
    /\b(latest|current|currently|today|tonight|this week|this month|recent|breaking|news|weather|forecast|right now|live)\b/i,
    /\b(price|stock|market cap|exchange rate|score|standings|schedule|release date|version|changelog|update|status)\b/i,
    /\b(what happened|what is happening|who won|when is|where is|live update|as of)\b/i,
    /\b(202[5-9]|203\d)\b.*\b(news|update|latest|current|released?|announced?)\b/i,
  ].some((pattern) => pattern.test(value));
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
  const attempts = [
    { model: PRIMARY_MODEL, tier: "Primary", temperature: 0.7 },
    { model: SECONDARY_MODEL, tier: "Secondary", temperature: 0.6 },
    { model: VISION_MODEL, tier: "Vision Fallback", temperature: 0.6 },
  ];
  let lastError = null;

  for (const attempt of attempts) {
    try {
      const res = await runGroqWithFallback(
        (groq) => groq.chat.completions.create({
          model: attempt.model,
          messages,
          temperature: attempt.temperature,
        }),
        { label: `chat ${attempt.tier}` }
      );
      const reply = normalizeText(res.choices[0]?.message?.content || "", MAX_JSON_TEXT_LENGTH);
      if (!reply) {
        throw new Error(`${attempt.tier} returned an empty reply`);
      }
      return { reply, tier: attempt.tier };
    } catch (error) {
      lastError = error;
      console.log(`[GROQ] ${attempt.tier} exhausted: ${error.message}`);
    }
  }

  throw lastError || new Error("All chat models failed");
}

async function getVisionCompletion({ prompt, mimeType, imageBase64, systemPrompt = "" }) {
  const res = await runGroqWithFallback(
    (groq) => groq.chat.completions.create({
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
    }),
    { label: "vision" }
  );

  const reply = normalizeText(res.choices[0]?.message?.content || "", MAX_JSON_TEXT_LENGTH);
  if (!reply) throw new Error("Vision model returned an empty reply");
  return reply;
}

async function transcribeAudio({ audioFile, prompt = "" }) {
  const fileName = sanitizeFileName(audioFile.originalname || "pmcai-voice.webm");
  const file = await toFile(audioFile.buffer, fileName, {
    type: audioFile.mimetype || "audio/webm",
  });
  const transcript = await runGroqWithFallback(
    (groq) => groq.audio.transcriptions.create({
      file,
      model: WHISPER_MODEL,
      prompt: normalizeText(prompt, 1000) || undefined,
      response_format: "json",
      temperature: 0,
    }),
    { label: "voice transcription", timeoutMs: TRANSCRIPTION_TIMEOUT_MS }
  );
  const text = normalizeText(transcript?.text || "", MAX_JSON_TEXT_LENGTH);
  if (!text) throw new Error("Voice transcription returned empty text");
  return text;
}

async function getTextReplyWithMemory({ message, userId, conversationId, systemPrompt, history }) {
  const cleanedMessage = normalizeText(message);
  if (!cleanedMessage) throw new Error("No message provided");

  const memoryKey = buildConversationKey({ userId, conversationId });
  const providedHistory = compactHistory(history, MAX_HISTORY_MESSAGES);
  const baseHistory = providedHistory.length ? providedHistory : getStoredHistory(memoryKey);
  const searchQuery = buildSearchQuerySimple(cleanedMessage);
  const needsWeb = shouldUseWebSimple(cleanedMessage);
  console.log(`[WEB] simple detection requested=${needsWeb} query="${searchQuery}"`);

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
  ];

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
    transcription_model: WHISPER_MODEL,
    web_search_available: Boolean(process.env.TAVILY_API_KEY),
    voice_transcription_available: getGroqApiEntries().length > 0,
    image_upload_limit_mb: 8,
    audio_upload_limit_mb: 25,
  });
});

function sendApiError(res, status, error, details, code = "PMCAI_ERROR") {
  return res.status(status).json({
    ok: false,
    error,
    details: normalizeText(details || error, 800),
    code,
  });
}

app.post(
  "/api/transcribe",
  rateLimit({ windowMs: 60000, max: 30 }),
  audioUpload.single("audio"),
  async (req, res) => {
    try {
      const audioFile = req.file;
      if (!audioFile) {
        return sendApiError(res, 400, "No audio provided", "Attach an audio recording.", "NO_AUDIO");
      }
      if (!isAudioMimeType(audioFile.mimetype)) {
        return sendApiError(res, 415, "Unsupported audio type", audioFile.mimetype, "UNSUPPORTED_AUDIO");
      }

      console.log(`[VOICE] transcribing ${sanitizeFileName(audioFile.originalname)} type=${audioFile.mimetype} bytes=${audioFile.size}`);
      const text = await transcribeAudio({
        audioFile,
        prompt: normalizeText(req.body?.prompt, 1000),
      });
      console.log(`[VOICE] transcription complete chars=${text.length}`);

      return res.json({
        ok: true,
        text,
        meta: {
          model: WHISPER_MODEL,
          file_name: sanitizeFileName(audioFile.originalname),
        },
      });
    } catch (err) {
      console.log(`[ERROR] [VOICE] ${err.message}`);
      return sendApiError(res, 500, "Voice transcription failed", err.message, "VOICE_TRANSCRIPTION_FAILED");
    }
  }
);

app.post(
  "/api/chat",
  rateLimit({ windowMs: 60000, max: 25 }),
  imageUpload.single("image"),
  async (req, res) => {
    try {
      const message = normalizeText(req.body?.message);
      const userId = req.ip;
      const imageFile = req.file;
      const conversationId = normalizeText(req.body?.conversationId, 120) || "default";
      const systemPrompt = normalizeText(req.body?.systemPrompt, 4000);
      const history = parseHistoryInput(req.body?.history);

      if (!message && !imageFile) {
        return sendApiError(res, 400, "No message provided", "Type a message or attach an image.", "NO_MESSAGE");
      }

      if (imageFile && isImageMimeType(imageFile.mimetype)) {
        console.log(`[UPLOAD] image ${sanitizeFileName(imageFile.originalname)} type=${imageFile.mimetype} bytes=${imageFile.size}`);
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
            ok: true,
            reply,
            meta: {
              tier_used: "Vision",
              vision_used: true,
              file_name: sanitizeFileName(imageFile.originalname),
              conversation_id: conversationId,
            },
          });
        } catch (visionError) {
          console.log(`[ERROR] [UPLOAD] vision failed: ${visionError.message}`);
          const fallbackPrompt = message
            || `The uploaded file "${sanitizeFileName(imageFile.originalname) || "image"}" could not be analyzed by the vision model. Respond helpfully without claiming to see the image.`;
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
            ok: true,
            ...fallback,
            meta: {
              ...fallback.meta,
              vision_used: false,
              vision_fallback: true,
              vision_error: visionError.message,
              file_name: sanitizeFileName(imageFile.originalname),
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

      return res.json({ ok: true, ...textResponse });
    } catch (err) {
      console.log(`[ERROR] [API] ${err.message}`);
      return sendApiError(res, 500, "PMCAI request failed", err.message, "CHAT_FAILED");
    }
  }
);

app.use("/api", (_req, res) => {
  return sendApiError(res, 404, "API route not found", "The requested PMCAI API route does not exist.", "NOT_FOUND");
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return sendApiError(res, 400, "Invalid JSON payload", "The request body could not be parsed.", "BAD_JSON");
  }

  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return sendApiError(res, 413, "File too large", "Images are limited to 8 MB and audio is limited to 25 MB.", "FILE_TOO_LARGE");
  }

  if (err?.code === "UNSUPPORTED_FILE_TYPE") {
    return sendApiError(res, err.statusCode || 415, "Unsupported file type", err.message, "UNSUPPORTED_FILE_TYPE");
  }

  console.log(`[ERROR] [API] ${err.message}`);
  return sendApiError(res, err.statusCode || 500, "PMCAI backend error", err.message, "BACKEND_ERROR");
});

setInterval(() => {
  pruneExpiredMemory();
}, 14 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[API] PMCAI running on ${PORT}`);
});
