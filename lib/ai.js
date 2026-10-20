/**
 * lib/ai.js
 *
 * Owns: Google Gemini API integration for AI tasks (lead qualification, etc).
 *
 * Env:
 *   GEMINI_API_KEY - required. Free key from Google AI Studio:
 *                    https://aistudio.google.com/apikey
 *   GEMINI_MODEL   - optional. Defaults to gemini-3.5-flash (verified working
 *                    on the free tier; gemini-2.5-flash returns 404 for new
 *                    API users, so do not downgrade to it).
 *
 * Contract (unchanged from the previous provider): chat(message, options)
 * resolves to the model's reply as a plain string. Callers pass
 * { system, maxTokens, model } and parse the string themselves.
 */

const fetch = require('node-fetch');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

/**
 * Simple prompt → response for analysis tasks.
 * Use when the input is already provided (no web search needed).
 * Asks Gemini for a JSON response body so callers can JSON.parse the result.
 */
async function chat(message, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set — AI features are unavailable.');
  }

  const model = options.model || DEFAULT_MODEL;
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: message }] }],
    generationConfig: {
      maxOutputTokens: options.maxTokens || 4096,
      responseMimeType: 'application/json',
    },
  };
  if (options.system) {
    body.system_instruction = { parts: [{ text: options.system }] };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const candidate = (data.candidates || [])[0];
  const text = ((candidate && candidate.content && candidate.content.parts) || [])
    .map(part => part.text || '')
    .join('');

  if (!text) {
    const reason = (candidate && candidate.finishReason) || 'unknown';
    throw new Error(`Gemini API returned no text (finishReason: ${reason})`);
  }

  return text;
}

module.exports = { chat };
