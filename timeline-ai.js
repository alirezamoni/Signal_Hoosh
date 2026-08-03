/**
 * timeline-ai.js — Causal Discovery Engine's OpenRouter helper.
 *
 * Thin adapter over lib/ai-client.js. Keeps the engine's own model override
 * (timeline_ai_model, falls back to the general ai_model when empty) and the
 * exact public API (callNarrative/callStructured/getModels/resolvedModel)
 * that timeline-engine.js, timeline-predict.js, timeline-graph.js and
 * timeline-learn.js already depend on — only the network/reasoning-bug/
 * rate-limit internals moved into the shared client.
 */
const aiClient = require('./lib/ai-client');

const TIMELINE_MODEL_OVERRIDE_KEY = 'timeline_ai_model';

function getModels() { return aiClient.getModels(TIMELINE_MODEL_OVERRIDE_KEY); }
function resolvedModel() { return getModels()[0]; }

async function callNarrative(prompt, system) {
  return aiClient.callText(prompt, { system, max_tokens: 1200, tag: 'tl-ai', models: getModels() });
}

async function callStructured(prompt, system) {
  return aiClient.callJSON(prompt, { system, max_tokens: 900, tag: 'tl-ai/json', models: getModels() });
}

module.exports = {
  callNarrative, callStructured, getModels, resolvedModel,
  persianRatio: aiClient.persianRatio,
  isChainOfThoughtJunk: aiClient.isChainOfThoughtJunk,
  extractJson: aiClient.extractJson,
  FALLBACK_MODELS: aiClient.FALLBACK_MODELS,
};
