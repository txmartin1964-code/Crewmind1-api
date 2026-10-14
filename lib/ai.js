/**
 * lib/ai.js
 *
 * Owns: Direct Anthropic API integration for AI tasks (lead qualification, etc).
 *
 * Env:
 *   ANTHROPIC_API_KEY - required. Get one at https://console.anthropic.com
 *   ANTHROPIC_MODEL   - optional. Defaults to claude-haiku-4-5 (cheap + fast).
 */

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

/**
 * Simple prompt → response for analysis tasks.
 * Use when the input is already provided (no web search needed).
 */
async function chat(message, options = {}) {
  const response = await anthropic.messages.create(
    {
      model: options.model || DEFAULT_MODEL,
      max_tokens: options.maxTokens || 4096,
      messages: [{ role: 'user', content: message }],
      system: options.system,
    },
    {
      headers: options.subscriptionId
        ? { 'X-Subscription-ID': options.subscriptionId }
        : {},
    }
  );
  return response.content[0].text;
}

module.exports = { anthropic, chat };
