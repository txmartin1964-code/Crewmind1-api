/**
 * services/lead-qualify.js
 * Owns: AI-powered lead qualification logic.
 * Does NOT own: DB writes (db/leads.js), email sending (services/email.js), HTTP handling (routes/).
 *
 * Scoring: 0–100. Below 40 = disqualified. 40–69 = review. 70+ = qualified.
 */

const { chat } = require('../lib/polsia-ai');

const SCORE_THRESHOLD_QUALIFIED = 70;
const SCORE_THRESHOLD_REVIEW = 40;

/**
 * Qualifies a lead using AI scoring.
 * Returns { ai_score, ai_reasoning, ai_flags, qualification_status, status }
 */
async function qualifyLead(lead) {
  const prompt = buildQualificationPrompt(lead);

  let raw;
  try {
    raw = await chat(prompt, {
      system: `You are a lead qualification assistant for a home services company.
Your job is to score inbound service requests on a scale of 0–100 based on:
- Seriousness (real address, real timeline, specific description)
- Job scope (well-defined vs vague)
- Fit (within typical home services scope)
- Red flags (spam, unrealistic expectations, outside scope)

Always respond with valid JSON only. No other text.`,
      maxTokens: 1024,
    });
  } catch (err) {
    // AI failure is non-fatal — default to pending manual review
    console.error('[lead-qualify] AI call failed:', err.message);
    return {
      ai_score: null,
      ai_reasoning: 'AI qualification unavailable — manual review required.',
      ai_flags: [],
      qualification_status: 'manual_review',
      status: 'new',
    };
  }

  let parsed;
  try {
    // Strip any markdown code fences if present
    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.error('[lead-qualify] JSON parse error:', raw);
    return {
      ai_score: null,
      ai_reasoning: 'Qualification parsing error — manual review required.',
      ai_flags: [],
      qualification_status: 'manual_review',
      status: 'new',
    };
  }

  const score = Math.min(100, Math.max(0, parseInt(parsed.score) || 0));
  const flags = parsed.flags || [];
  const reasoning = parsed.reasoning || '';

  let qualification_status, status;
  if (score >= SCORE_THRESHOLD_QUALIFIED) {
    qualification_status = 'qualified';
    status = 'qualified';
  } else if (score >= SCORE_THRESHOLD_REVIEW) {
    qualification_status = 'manual_review';
    status = 'new';
  } else {
    qualification_status = 'disqualified';
    status = 'disqualified';
  }

  return { ai_score: score, ai_reasoning: reasoning, ai_flags: flags, qualification_status, status };
}

function buildQualificationPrompt(lead) {
  return `Qualify this home services lead:

Name: ${lead.name}
Email: ${lead.email}
Phone: ${lead.phone || 'not provided'}
Job Type: ${lead.job_type}
Address: ${lead.address}${lead.city ? ', ' + lead.city : ''}${lead.zip ? ' ' + lead.zip : ''}
Square Footage: ${lead.sqft || 'not provided'}
Timeline: ${lead.timeline || 'not specified'}
Description: ${lead.description || 'no description provided'}
Photos submitted: ${(lead.photo_urls || []).length} photo(s)

Respond with JSON only:
{
  "score": <0-100 integer>,
  "reasoning": "<1-2 sentences explaining the score>",
  "flags": ["<red flag 1 if any>", "<red flag 2 if any>"]
}

Score guidance:
- 90-100: Clear scope, real address, urgent timeline, detailed description
- 70-89: Good scope, reasonable timeline, adequate details
- 40-69: Vague scope or timeline, needs follow-up but worth pursuing
- 0-39: Spam, out of scope, unrealistic, or missing critical info`;
}

module.exports = { qualifyLead };
