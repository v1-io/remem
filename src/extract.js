const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "for",
  "of",
  "in",
  "on",
  "at",
  "is",
  "it",
  "this",
  "that",
  "with",
  "from",
  "have",
  "has",
  "had",
  "be",
  "been",
  "are",
  "was",
  "were",
  "my",
  "your",
  "our",
  "their",
  "seems",
  "seem",
  "into",
  "about",
]);

const ERROR_TERMS = [
  "race condition",
  "deadlock",
  "bug",
  "error",
  "exception",
  "failure",
  "hang",
  "crash",
  "timeout",
  "regression",
  "leak",
];

export function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function extractPrompt(input) {
  if (!input || typeof input !== "object") {
    return "";
  }
  const candidates = [
    input.prompt,
    input.user_prompt,
    input.userPrompt,
    input.prompt_text,
    input.text,
    input.message,
    input.content,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return normalizeWhitespace(candidate);
    }
  }
  return "";
}

export function extractFiles(text) {
  const matches = text.match(/\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|go|py|rb|rs|java|kt|swift|json|ya?ml|toml|md|css|scss|html)\b/g) ?? [];
  return uniq(matches);
}

export function extractSymbols(text) {
  const matches = text.match(/\b[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)*\b|\b[a-z]+(?:_[a-z0-9]+){1,}\b|\buse[A-Z][A-Za-z0-9]+\b/g) ?? [];
  return uniq(matches.filter((value) => value.length > 2 && !STOP_WORDS.has(value.toLowerCase())));
}

export function extractQuotedPhrases(text) {
  const matches = text.match(/"([^"]+)"|'([^']+)'/g) ?? [];
  return uniq(matches.map((value) => value.slice(1, -1)).filter(Boolean));
}

export function extractTerms(text) {
  const words = text
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{2,}/g)
    ?? [];
  return uniq(words.filter((word) => !STOP_WORDS.has(word)));
}

export function extractErrors(text) {
  const lower = text.toLowerCase();
  return ERROR_TERMS.filter((term) => lower.includes(term));
}

export function inferTags(text, files, symbols, errors) {
  const tags = [];
  if (files.length > 0) {
    tags.push("file-change");
  }
  if (symbols.length > 0) {
    tags.push("symbol");
  }
  if (errors.length > 0) {
    tags.push("debugging");
  }
  if (/\btest|spec|assert|failing\b/i.test(text)) {
    tags.push("testing");
  }
  if (/\bperf|slow|latency|throughput\b/i.test(text)) {
    tags.push("performance");
  }
  return uniq(tags);
}

export function buildPromptFeatures(text) {
  const normalized = normalizeWhitespace(text);
  const files = extractFiles(normalized);
  const symbols = extractSymbols(normalized);
  const phrases = extractQuotedPhrases(normalized);
  const terms = extractTerms(normalized);
  const errors = extractErrors(normalized);
  const tags = inferTags(normalized, files, symbols, errors);

  return {
    text: normalized,
    files,
    symbols,
    phrases,
    terms,
    errors,
    tags,
  };
}

export function buildSessionSummary(session) {
  const latestPrompt = session.promptSamples.at(-1)?.text || "";
  const parts = [];

  if (session.symbols.length > 0) {
    parts.push(`Worked on ${session.symbols.slice(0, 3).join(", ")}`);
  } else if (session.files.length > 0) {
    parts.push(`Worked in ${session.files.slice(0, 3).join(", ")}`);
  }

  if (session.errors.length > 0) {
    parts.push(`Investigated ${session.errors.slice(0, 3).join(", ")}`);
  }

  if (latestPrompt) {
    parts.push(latestPrompt.slice(0, 160));
  }

  return parts.join(". ").trim() || "Session memory captured.";
}

export function uniq(values) {
  return [...new Set(values)];
}
