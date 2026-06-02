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
const SECONDARY_MODEL = "openai/gpt-oss-120b";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const WHISPER_MODEL = "whisper-large-v3-turbo";
const MODEL_OPTIONS = {
  "PMCAI 0": {
    text: "openai/gpt-oss-20b",
    vision: VISION_MODEL,
    temperature: 0.1,
  },
  "PMCAI 1": {
    text: PRIMARY_MODEL,
    vision: VISION_MODEL,
    temperature: 0.2,
  },
  "PMCAI 2": {
    text: SECONDARY_MODEL,
    vision: VISION_MODEL,
    temperature: 0.3,
  },
};
const DEFAULT_MODEL_LABEL = "PMCAI 1";

const MAX_HISTORY_MESSAGES = 14;
const MAX_MEMORY_MESSAGES = 20;
const MEMORY_TTL_MS = 6 * 60 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 18000;
const GROQ_TIMEOUT_MS = 45000;
const TRANSCRIPTION_TIMEOUT_MS = 35000;
const MAX_WEB_RESULTS = 6;
const TAVILY_FETCH_RESULTS = 12;
const WEB_QUERY_CHAR_LIMIT = 420;
const WEB_CONTEXT_CHAR_LIMIT = 9000;
const WEB_SOURCE_SNIPPET_LIMIT = 1400;
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
  CreatorLooks: "An 11-year-old Filipino male with a rounded face, full cheeks, short dark textured hair, and dark almond-shaped eyes.",
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

function normalizeModelLabel(value = "") {
  return Object.prototype.hasOwnProperty.call(MODEL_OPTIONS, value) ? value : DEFAULT_MODEL_LABEL;
}

function getModelOption(value = "") {
  const label = normalizeModelLabel(value);
  return { label, ...MODEL_OPTIONS[label] };
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
    `${IDENTITY.creator} Looks Like an ${IDENTITY.CreatorLooks}.`,
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

const WEB_STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "any", "are", "around", "ask", "best", "but", "can",
  "could", "did", "does", "for", "from", "get", "give", "has", "have", "help", "how", "into",
  "latest", "like", "look", "make", "most", "near", "new", "news", "now", "online", "please",
  "recent", "search", "show", "tell", "than", "that", "the", "their", "them", "then", "there",
  "these", "this", "today", "use", "using", "was", "web", "were", "what", "when", "where",
  "which", "while", "who", "why", "with", "would", "you", "your",
]);

const DEFAULT_EXCLUDED_WEB_DOMAINS = [
  "pinterest.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "youtu.be",
  "quora.com",
  "answers.com",
  "slideshare.net",
];

const DISCUSSION_DOMAINS = [
  "reddit.com",
  "quora.com",
  "stackoverflow.com",
  "stackexchange.com",
  "medium.com",
  "substack.com",
  "github.com",
  "news.ycombinator.com",
];

const HIGH_QUALITY_DOMAINS = new Set([
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "bls.gov",
  "cdc.gov",
  "census.gov",
  "cnbc.com",
  "docs.tavily.com",
  "ecb.europa.eu",
  "federalreserve.gov",
  "ft.com",
  "imf.org",
  "nih.gov",
  "nvidia.com",
  "openai.com",
  "reuters.com",
  "sec.gov",
  "statista.com",
  "theguardian.com",
  "who.int",
  "worldbank.org",
]);

function extractUserSearchText(message = "") {
  const cleaned = normalizeText(message, 12000);
  if (!cleaned) return "";

  const userLines = [...cleaned.matchAll(/(?:^|\n)User:\s*(.+)/gim)];
  const lastUserLine = userLines.at(-1)?.[1];
  if (lastUserLine) return normalizeWhitespace(lastUserLine);

  const explicitQuestion = cleaned.match(/QUESTION:\s*([\s\S]+)/i)?.[1];
  if (explicitQuestion) return normalizeWhitespace(explicitQuestion);

  return normalizeWhitespace(cleaned);
}

function extractSiteDomains(query = "") {
  const includeDomains = [];
  const cleaned = String(query).replace(/\bsite:([a-z0-9.-]+\.[a-z]{2,})(?:\/[^\s]*)?/gi, (_match, domain) => {
    includeDomains.push(domain.toLowerCase().replace(/^www\./, ""));
    return " ";
  });

  return {
    query: normalizeWhitespace(cleaned),
    includeDomains: [...new Set(includeDomains)],
  };
}

function cleanSearchQuery(query = "") {
  return normalizeWhitespace(query)
    .replace(/^\s*(?:please\s+)?(?:search|look up|lookup|browse|google|find)\s+(?:the\s+)?(?:web|internet|online)?\s*(?:for|about)?\s*/i, "")
    .replace(/\b(?:use|search)\s+(?:the\s+)?web\b/gi, " ")
    .replace(/\b(?:current|latest|recent)\s+(?:info|information|data)\s+(?:on|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, WEB_QUERY_CHAR_LIMIT);
}

function tokenizeForSearch(value = "") {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9.\-\s]/g, " ")
    .split(/\s+/)
    .map((term) => term.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter((term) => term && (term.length >= 3 || /^\d{4}$/.test(term)) && !WEB_STOP_WORDS.has(term));
}

function detectSearchIntent(query = "") {
  const value = normalizeText(query, 8000).toLowerCase();
  const explicit = /https?:\/\//i.test(value)
    || /\b(search|look up|lookup|browse|google|web|internet|online)\b/i.test(value);
  const timeSensitive = /\b(latest|current|currently|today|tonight|yesterday|last night|tomorrow|this week|next week|this month|recent|breaking|right now|live|as of|newly|just announced)\b/i.test(value);
  const dataLookup = /\b(price|stock|share price|market cap|exchange rate|score|standings|schedule|release date|version|changelog|update|status|weather|forecast|who won|what happened|what is happening)\b/i.test(value)
    || /\b(202[5-9]|203\d)\b.*\b(news|update|latest|current|released?|announced?|version)\b/i.test(value);
  const finance = /\b(stock|share price|market cap|ticker|nasdaq|nyse|earnings|revenue|crypto|bitcoin|ethereum|exchange rate|forex|interest rate|cpi|inflation|bond yield)\b/i.test(value);
  const news = /\b(news|breaking|today|tonight|this week|current events|what happened|what is happening|live|election|war|conflict|storm|earthquake|who won|score|standings)\b/i.test(value);

  let timeRange = "";
  if (/\b(today|tonight|yesterday|last night|tomorrow|right now|live|breaking|currently|weather|forecast)\b/i.test(value)) timeRange = "day";
  else if (/\b(this week|next week|past week|recent|latest|newly|just announced)\b/i.test(value)) timeRange = "week";
  else if (/\b(this month|current|update|release|released|changelog|version)\b/i.test(value)) timeRange = "month";

  return {
    explicit,
    timeSensitive,
    dataLookup,
    topic: finance ? "finance" : (news ? "news" : "general"),
    timeRange,
  };
}

function buildSearchPlan(message = "") {
  const rawQuery = extractUserSearchText(message);
  const domainPlan = extractSiteDomains(rawQuery);
  const query = cleanSearchQuery(domainPlan.query) || normalizeWhitespace(rawQuery).slice(0, WEB_QUERY_CHAR_LIMIT);
  const intent = detectSearchIntent(rawQuery);
  const terms = [...new Set(tokenizeForSearch(query))];
  const includeDomains = domainPlan.includeDomains;

  return {
    rawQuery,
    query,
    terms,
    includeDomains,
    excludeDomains: getExcludedWebDomains(query, includeDomains),
    needsWeb: Boolean(query) && (intent.explicit || intent.timeSensitive || intent.dataLookup || includeDomains.length > 0),
    topic: intent.topic,
    timeRange: intent.timeRange,
    days: intent.timeRange === "day" ? 1 : (intent.timeRange === "week" ? 7 : (intent.timeRange === "month" ? 30 : undefined)),
  };
}

function buildSearchQuerySimple(message = "") {
  return buildSearchPlan(message).query;
}

function shouldUseWebSimple(message = "") {
  return buildSearchPlan(message).needsWeb;
}

function domainMatches(domain = "", target = "") {
  const cleanDomain = String(domain).toLowerCase().replace(/^www\./, "");
  const cleanTarget = String(target).toLowerCase().replace(/^www\./, "");
  return cleanDomain === cleanTarget || cleanDomain.endsWith(`.${cleanTarget}`);
}

function queryMentionsDomain(query = "", domain = "") {
  const lower = query.toLowerCase();
  const cleanDomain = domain.toLowerCase().replace(/^www\./, "");
  const base = cleanDomain.split(".")[0];
  return lower.includes(cleanDomain) || (base.length > 3 && lower.includes(base));
}

function getExcludedWebDomains(query = "", includeDomains = []) {
  if (includeDomains.length) return [];
  return DEFAULT_EXCLUDED_WEB_DOMAINS.filter((domain) => !queryMentionsDomain(query, domain));
}

function canonicalizeUrl(value = "") {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igshid$)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    return {
      url: parsed.toString(),
      domain: parsed.hostname,
      pathname: parsed.pathname,
    };
  } catch {
    return null;
  }
}

function normalizeSearchResult(result = {}) {
  const canonical = canonicalizeUrl(normalizeText(result.url, 800));
  if (!canonical) return null;

  const rawContent = typeof result.raw_content === "string"
    ? result.raw_content
    : (typeof result.rawContent === "string" ? result.rawContent : "");

  return {
    title: normalizeText(result.title, 220) || canonical.domain,
    url: canonical.url,
    domain: canonical.domain,
    pathname: canonical.pathname,
    content: normalizeText(result.content, 2600),
    rawContent: normalizeText(rawContent, 7000),
    publishedDate: normalizeText(result.published_date || result.publishedDate || "", 80),
    score: typeof result.score === "number" ? result.score : 0,
  };
}

function isNoisyResult(result, plan) {
  if (!result?.url) return true;
  if (plan.includeDomains.length && !plan.includeDomains.some((domain) => domainMatches(result.domain, domain))) return true;
  if (plan.excludeDomains.some((domain) => domainMatches(result.domain, domain))) return true;
  if (/\/(?:search|tag|tags|category|author)(?:\/|$)/i.test(result.pathname) && result.content.length < 500) return true;
  if (/\b(search results|tag archive|log in|sign up|subscribe to continue)\b/i.test(result.title) && result.content.length < 500) return true;
  if ((result.content + result.rawContent).length < 80) return true;
  return false;
}

function textTermOverlap(text = "", terms = []) {
  if (!terms.length) return 0;
  const lower = ` ${normalizeWhitespace(text).toLowerCase()} `;
  let matches = 0;
  for (const term of terms) {
    if (lower.includes(term)) matches += 1;
  }
  return matches / terms.length;
}

function sourceQualityScore(result, plan) {
  let score = 0;
  const domain = result.domain;
  const domainTokens = domain.split(/[.\-]/).filter((token) => token.length >= 4);
  const queryTerms = new Set(plan.terms);

  if (domain.endsWith(".gov")) score += 0.9;
  if (domain.endsWith(".edu")) score += 0.55;
  if (HIGH_QUALITY_DOMAINS.has(domain)) score += 0.45;
  if (/^(docs|developer|support|help)\./.test(domain) || /\/(?:docs|documentation|api|reference)(?:\/|$)/i.test(result.pathname)) score += 0.25;
  if (domainTokens.some((token) => queryTerms.has(token))) score += 0.35;
  if (DISCUSSION_DOMAINS.some((source) => domainMatches(domain, source)) && !queryMentionsDomain(plan.query, domain)) score -= 0.45;
  if (/\b(blog|opinion|sponsored|coupon|promo|affiliate|top \d+|best \d+)\b/i.test(`${result.title} ${result.pathname}`)) score -= 0.35;
  if (/\b(yahoo.com|msn.com|aol.com|flipboard.com)\b/i.test(domain)) score -= 0.25;

  return score;
}

function recencyScore(result, plan) {
  if (!plan.timeRange || !result.publishedDate) return 0;
  const timestamp = Date.parse(result.publishedDate);
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = (Date.now() - timestamp) / 86400000;
  if (ageDays <= 2) return 0.5;
  if (ageDays <= 7) return 0.35;
  if (ageDays <= 30) return 0.2;
  if (ageDays <= 365) return 0.05;
  return -0.25;
}

function rankSearchResult(result, plan) {
  const titleOverlap = textTermOverlap(result.title, plan.terms);
  const contentOverlap = textTermOverlap(`${result.content}\n${result.rawContent}`, plan.terms);
  const tavilyScore = Math.min(Math.max(result.score || 0, 0), 1);

  return tavilyScore * 1.2
    + titleOverlap * 2.4
    + contentOverlap * 2.8
    + sourceQualityScore(result, plan)
    + recencyScore(result, plan);
}

function splitEvidenceChunks(text = "") {
  const cleaned = normalizeText(text, 9000);
  if (!cleaned) return [];
  return cleaned
    .split(/\n{2,}|[.!?]\s+/)
    .map((chunk) => normalizeWhitespace(chunk))
    .filter((chunk) => chunk.length >= 70 && chunk.length <= 1600);
}

function buildEvidenceSnippet(result, terms) {
  const chunks = [
    ...splitEvidenceChunks(result.content),
    ...splitEvidenceChunks(result.rawContent),
  ];

  const selected = chunks
    .map((chunk) => ({
      chunk,
      score: textTermOverlap(chunk, terms) + Math.min(chunk.length / 1200, 0.25),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.chunk);

  const evidence = selected.length
    ? selected.join("\n")
    : normalizeText(result.content || result.rawContent, WEB_SOURCE_SNIPPET_LIMIT);

  return evidence.slice(0, WEB_SOURCE_SNIPPET_LIMIT);
}

function dedupeAndLimitResults(results, limit, plan) {
  const selected = [];
  const seenUrls = new Set();
  const seenTitles = new Set();
  const domainCounts = new Map();
  const maxPerDomain = plan.includeDomains.length ? 4 : 2;

  for (const result of results) {
    const titleKey = normalizeWhitespace(result.title).toLowerCase();
    if (seenUrls.has(result.url) || seenTitles.has(titleKey)) continue;
    const domainCount = domainCounts.get(result.domain) || 0;
    if (domainCount >= maxPerDomain) continue;

    selected.push(result);
    seenUrls.add(result.url);
    seenTitles.add(titleKey);
    domainCounts.set(result.domain, domainCount + 1);
    if (selected.length >= limit) return selected;
  }

  return selected;
}

function normalizeAndRankSearchResults(rawResults = [], plan) {
  const normalized = rawResults
    .map(normalizeSearchResult)
    .filter(Boolean);
  let candidates = normalized.filter((result) => !isNoisyResult(result, plan));
  if (candidates.length < 3 && normalized.length > candidates.length && plan.excludeDomains.length) {
    const relaxedPlan = { ...plan, excludeDomains: [] };
    candidates = normalized.filter((result) => !isNoisyResult(result, relaxedPlan));
  }

  const ranked = candidates
    .map((result) => ({
      ...result,
      relevance: rankSearchResult(result, plan),
      evidence: buildEvidenceSnippet(result, plan.terms),
    }))
    .sort((a, b) => b.relevance - a.relevance);

  return dedupeAndLimitResults(ranked, MAX_WEB_RESULTS, plan);
}

function buildWebContext({ answer, results, plan }) {
  const sections = [
    `SEARCH QUERY:\n${plan.query}`,
  ];

  if (answer) {
    sections.push(`TAVILY DRAFT ANSWER (cross-check against the sources below before using):\n${normalizeText(answer, 1400)}`);
  }

  if (results.length) {
    sections.push("RANKED WEB SOURCES:");
    for (const [index, result] of results.entries()) {
      sections.push([
        `[${index + 1}] ${result.title}`,
        `URL: ${result.url}`,
        `Domain: ${result.domain}`,
        result.publishedDate ? `Published/updated: ${result.publishedDate}` : "",
        `Local relevance: ${result.relevance.toFixed(2)}`,
        `Evidence:\n${normalizeText(result.evidence || result.content, WEB_SOURCE_SNIPPET_LIMIT)}`,
      ].filter(Boolean).join("\n"));
    }
  }

  return sections.join("\n\n").slice(0, WEB_CONTEXT_CHAR_LIMIT);
}

function buildTavilyRequestBody(apiKey, plan, modern = true) {
  const body = {
    api_key: apiKey,
    query: plan.query,
    topic: plan.topic,
    search_depth: "advanced",
    include_answer: modern ? "advanced" : true,
    include_raw_content: modern ? "markdown" : true,
    max_results: TAVILY_FETCH_RESULTS,
    exclude_domains: plan.excludeDomains,
  };

  if (modern) {
    body.auto_parameters = true;
    body.chunks_per_source = 3;
  }
  if (plan.includeDomains.length) body.include_domains = plan.includeDomains;
  if (plan.timeRange) body.time_range = plan.timeRange;
  if (plan.topic === "news" && plan.days) body.days = plan.days;

  return body;
}

async function fetchTavilySearch(apiKey, body, signal) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`Tavily ${res.status}: ${text.slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }

  return res.json();
}

async function searchWeb(searchPlan) {
  const plan = typeof searchPlan === "string" ? buildSearchPlan(searchPlan) : searchPlan;
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return {
      used: false,
      query: plan.query,
      results: [],
      answer: "",
      contextText: "",
      error: "Missing TAVILY_API_KEY",
      topic: plan.topic,
      timeRange: plan.timeRange,
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    let data;
    try {
      data = await fetchTavilySearch(apiKey, buildTavilyRequestBody(apiKey, plan, true), controller.signal);
    } catch (error) {
      if (error.status !== 400) throw error;
      console.log(`[WEB] retrying Tavily with legacy-compatible parameters: ${error.message}`);
      data = await fetchTavilySearch(apiKey, buildTavilyRequestBody(apiKey, plan, false), controller.signal);
    }

    const rawResults = Array.isArray(data.results) ? data.results : [];
    const results = normalizeAndRankSearchResults(rawResults, plan);
    const answer = normalizeText(data.answer, 1400);
    const contextText = results.length ? buildWebContext({ answer, results, plan }) : "";
    console.log(`[WEB] query="${plan.query}" topic=${plan.topic} time=${plan.timeRange || "none"} results=${results.length}/${rawResults.length}`);

    return {
      used: Boolean(results.length),
      query: plan.query,
      answer,
      results,
      contextText,
      error: "",
      topic: plan.topic,
      timeRange: plan.timeRange,
      rawResultsCount: rawResults.length,
    };
  } catch (error) {
    console.log(`[WEB] search failed: ${error.message}`);
    return {
      used: false,
      query: plan.query,
      results: [],
      answer: "",
      contextText: "",
      error: error.message,
      topic: plan.topic,
      timeRange: plan.timeRange,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getChatCompletion(messages, modelLabel = DEFAULT_MODEL_LABEL) {
  const selected = getModelOption(modelLabel);
  const res = await runGroqWithFallback(
    (groq) => groq.chat.completions.create({
      model: selected.text,
      messages,
      temperature: selected.temperature,
    }),
    { label: `chat ${selected.label}` }
  );
  const reply = normalizeText(res.choices[0]?.message?.content || "", MAX_JSON_TEXT_LENGTH);
  if (!reply) {
    throw new Error(`${selected.label} returned an empty reply`);
  }
  return { reply, tier: selected.label };
}

function isImageAnalysisPrompt(prompt = "") {
  const value = normalizeWhitespace(prompt).toLowerCase();
  return /\b(analy[sz]e|describe|caption|inspect|identify|recognize|ocr|transcribe|read|extract text)\b/.test(value)
    || /\bwhat(?:'s| is)\s+(?:in|on|shown|pictured)\b/.test(value)
    || /\bwhat do you see\b/.test(value)
    || /\btell me\s+(?:what|who|where).*?(?:image|photo|picture|screenshot)\b/.test(value)
    || /\b(?:image|photo|picture|screenshot)\s+(?:shows|says|contain|contains)\b/.test(value);
}

function buildVisionPrompt({ prompt, history = [], fileName = "" }) {
  const cleanedPrompt = normalizeText(prompt);
  const hasUserPrompt = Boolean(cleanedPrompt);
  const requestsImageAnalysis = hasUserPrompt && isImageAnalysisPrompt(cleanedPrompt);
  const primaryPrompt = cleanedPrompt || "Ask the user what they want to create or do with this attached reference image.";
  const recentContext = compactHistory(history, 6)
    .map((entry) => `${entry.role === "assistant" ? "Assistant" : "User"}: ${entry.content}`)
    .join("\n");

  return [
    "Use the user's text as the main generation prompt.",
    "Treat the attached image as a visual reference/input image.",
    requestsImageAnalysis
      ? "The user explicitly requested image analysis, so you may analyze or describe only the visual details needed to answer."
      : "Do not automatically analyze, describe, caption, identify, or summarize the image. Do not start with observations about the image. Use the image only as supporting reference when it helps satisfy the user's text prompt.",
    hasUserPrompt
      ? ""
      : "No text prompt was provided. Ask the user what they want done with the reference image instead of describing the image.",
    fileName ? `Attached image file: ${sanitizeFileName(fileName)}` : "",
    recentContext ? `Recent conversation context:\n${recentContext}` : "",
    `User prompt:\n${primaryPrompt}`,
  ].filter(Boolean).join("\n\n");
}

async function getVisionCompletion({ prompt, mimeType, imageBase64, systemPrompt = "", modelLabel = DEFAULT_MODEL_LABEL, history = [], fileName = "" }) {
  const selected = getModelOption(modelLabel);
  const visionPrompt = buildVisionPrompt({ prompt, history, fileName });
  const res = await runGroqWithFallback(
    (groq) => groq.chat.completions.create({
      model: selected.vision,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(systemPrompt),
        },
        {
          role: "user",
          content: [
            { type: "text", text: visionPrompt },
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

async function getTextReplyWithMemory({ message, userId, conversationId, systemPrompt, history, modelLabel }) {
  const cleanedMessage = normalizeText(message);
  if (!cleanedMessage) throw new Error("No message provided");

  const memoryKey = buildConversationKey({ userId, conversationId });
  const providedHistory = compactHistory(history, MAX_HISTORY_MESSAGES);
  const baseHistory = providedHistory.length ? providedHistory : getStoredHistory(memoryKey);
  const searchPlan = buildSearchPlan(cleanedMessage);
  const needsWeb = searchPlan.needsWeb;
  console.log(`[WEB] requested=${needsWeb} query="${searchPlan.query}" topic=${searchPlan.topic} time=${searchPlan.timeRange || "none"}`);

  const webSearch = needsWeb ? await searchWeb(searchPlan) : {
    used: false,
    query: searchPlan.query,
    results: [],
    answer: "",
    contextText: "",
    error: "",
    topic: searchPlan.topic,
    timeRange: searchPlan.timeRange,
    rawResultsCount: 0,
  };

  const finalMessages = [
    {
      role: "system",
      content: [
        buildSystemPrompt(systemPrompt),
        webSearch.used
          ? "When WEB DATA is provided, synthesize the answer from the ranked WEB SOURCES. Prefer official, primary, recent, and higher-relevance sources. Treat the Tavily draft answer as a lead, not proof. If the sources do not support a claim, say so instead of guessing. If sources conflict, mention the uncertainty."
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

  const { reply, tier } = await getChatCompletion(finalMessages, modelLabel);
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
      web_topic: webSearch.topic,
      web_time_range: webSearch.timeRange || undefined,
      web_results_count: webSearch.results.length,
      web_raw_results_count: webSearch.rawResultsCount || undefined,
      web_error: webSearch.error || undefined,
      sources: webSearch.results.slice(0, 4).map((result) => ({
        title: result.title,
        url: result.url,
        domain: result.domain,
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
    models: Object.keys(MODEL_OPTIONS),
    default_model: DEFAULT_MODEL_LABEL,
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
  rateLimit({
    windowMs: 1000,
    max: 1,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error: "Slow down",
      details: "PMCAI accepts 1 text request per second.",
      code: "RATE_LIMITED",
    },
  }),
  imageUpload.single("image"),
  async (req, res) => {
    try {
      const message = normalizeText(req.body?.message || req.body?.imagePrompt || req.body?.prompt);
      const userId = req.ip;
      const imageFile = req.file;
      const conversationId = normalizeText(req.body?.conversationId, 120) || "default";
      const modelLabel = normalizeModelLabel(normalizeText(req.body?.model, 20));
      const systemPrompt = normalizeText(req.body?.systemPrompt, 4000);
      const history = parseHistoryInput(req.body?.history);

      if (!message && !imageFile) {
        return sendApiError(res, 400, "No message provided", "Type a message or attach an image.", "NO_MESSAGE");
      }

      if (imageFile && isImageMimeType(imageFile.mimetype)) {
        const imagePrompt = message;
        const imageFileName = sanitizeFileName(imageFile.originalname || "upload-image");
        console.log(`[UPLOAD] image ${imageFileName} type=${imageFile.mimetype} bytes=${imageFile.size} prompt=${Boolean(message)}`);
        try {
          const reply = await getVisionCompletion({
            prompt: imagePrompt,
            mimeType: imageFile.mimetype || "image/jpeg",
            imageBase64: imageFile.buffer.toString("base64"),
            systemPrompt,
            modelLabel,
            history,
            fileName: imageFileName,
          });

          const assistantHistory = [
            ...history.slice(-MAX_HISTORY_MESSAGES),
            { role: "user", content: imagePrompt || "[image uploaded as reference; no text prompt provided]" },
            { role: "assistant", content: reply },
          ];
          saveStoredHistory(buildConversationKey({ userId, conversationId }), assistantHistory);

          logChatTranscript({
            ip: userId,
            conversationId,
            userMessage: message ? `[image: ${imageFileName}] ${message}` : `[image] ${imageFileName}`,
            aiMessage: reply,
          });

          return res.json({
            ok: true,
            reply,
            meta: {
              tier_used: modelLabel,
              vision_used: true,
              prompt_used: imagePrompt || null,
              file_name: imageFileName,
              conversation_id: conversationId,
            },
          });
        } catch (visionError) {
          console.log(`[ERROR] [UPLOAD] vision failed: ${visionError.message}`);
          const fallbackPrompt = message
            ? `The uploaded reference image "${imageFileName}" could not be processed. Answer the user's prompt as best you can without claiming to see the image.\n\nUser prompt:\n${message}`
            : `The uploaded reference image "${imageFileName}" could not be processed. Ask the user to enter a text prompt or retry the upload. Do not describe or caption the image.`;
          const fallback = await getTextReplyWithMemory({
            message: fallbackPrompt,
            userId,
            conversationId,
            systemPrompt,
            history,
            modelLabel,
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
              prompt_used: message || null,
              file_name: imageFileName,
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
        modelLabel,
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
      return sendApiError(res, 500, "PMCAI request failed", "PMCAI could not complete this request. Please try again.", "CHAT_FAILED");
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
