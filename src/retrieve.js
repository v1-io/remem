import { buildPromptFeatures } from "./extract.js";

export function retrieveContext(store, config, { sessionId, projectRoot, promptText }) {
  const query = buildPromptFeatures(promptText);
  const pending = store.getPendingSession(sessionId);
  const excludeSessionIds = pending?.pendingInjections ?? [];
  const results = store.queryMemories({
    query,
    projectRoot,
    limit: config.retrieval.limit,
    excludeSessionIds,
  });

  if (results.length === 0) {
    return { text: "", results: [] };
  }

  const filtered = results.filter((result) => result.score >= config.retrieval.minScore);
  if (filtered.length === 0) {
    return { text: "", results: [] };
  }

  const lines = ["Relevant prior session memory:"];
  for (const result of filtered) {
    const references = [];
    if (result.symbols.length > 0) {
      references.push(`symbols: ${result.symbols.slice(0, 3).join(", ")}`);
    }
    if (result.files.length > 0) {
      references.push(`files: ${result.files.slice(0, 3).join(", ")}`);
    }
    lines.push(`- ${result.summary}`);
    lines.push(`  source: ${result.sessionId} on ${result.endedAt.slice(0, 10)}${references.length > 0 ? ` (${references.join("; ")})` : ""}`);
  }

  let text = lines.join("\n");
  if (text.length > config.retrieval.maxContextChars) {
    text = `${text.slice(0, config.retrieval.maxContextChars - 1)}…`;
  }
  return { text, results: filtered };
}
