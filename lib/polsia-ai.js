/**
 * lib/polsia-ai.js
 * Owns: Polsia AI proxy integration.
 * Does NOT own: business logic, email sending, database operations.
 */

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  baseURL: process.env.POLSIA_API_URL || 'https://polsia.com/api/proxy/ai',
  apiKey: process.env.POLSIA_API_KEY,
});

/**
 * Simple prompt → response for analysis tasks.
 * Use when the input is already provided (no web search needed).
 */
async function chat(message, options = {}) {
  const response = await anthropic.messages.create(
    {
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
