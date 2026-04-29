/**
 * Novelty Analyzer — Claude-powered novelty checking and research idea generation.
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { searchAcademic } = require('./academicSearch');

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith('sk-ant-api03-YOUR')) return null;
  return new Anthropic({ apiKey: key });
}

// ── Novelty Check ─────────────────────────────────────────────────────────────

async function checkNovelty({ title, problem, keywords, field, country, methodology }) {
  const client = getClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY is not configured.');

  const searchQuery = [title || problem, keywords, field].filter(Boolean).join(' ');
  const { papers, broadened } = await searchAcademic(searchQuery, 10);

  const papersBlock = papers.length
    ? papers.slice(0, 8).map((p, i) =>
        `[${i + 1}] "${p.title}" (${p.year || 'n/a'}) — ${p.citations} citations\n    ${(p.abstract || '').slice(0, 200)}`
      ).join('\n\n')
    : 'No related papers found via academic search.';

  const prompt = `You are an expert academic research advisor. Analyze the novelty of a proposed research problem.

## Proposed Research
- Title/Topic: ${title || 'Not provided'}
- Problem Statement: ${problem}
- Keywords: ${keywords || 'Not provided'}
- Field: ${field || 'Not specified'}
- Country/Region: ${country || 'Not specified'}
- Methodology: ${methodology || 'Not specified'}

## Related Papers Found via Academic Search
${papersBlock}

## Instructions
Assess the novelty and provide structured output in EXACTLY this JSON format (no markdown, no explanation outside JSON):
{
  "noveltyScore": "Highly Novel",
  "noveltyPercentage": 78,
  "saturationLevel": "Low",
  "verdict": "One or two sentence overall assessment.",
  "strengths": ["Strength 1", "Strength 2", "Strength 3"],
  "concerns": ["Concern 1", "Concern 2"],
  "differentiationTips": ["Tip 1", "Tip 2", "Tip 3"],
  "similarPapers": [{"ref": 1, "title": "...", "overlap": "..."}],
  "totalPapersFound": ${papers.length}
}

noveltyScore must be one of: "Highly Novel" | "Moderately Novel" | "Common/Saturated"
saturationLevel must be one of: "Low" | "Medium" | "High"`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1400,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content[0].text;
  const result = parseClaudeJSON(text);
  result.papers = papers.slice(0, 6);
  result.broadenedSearch = broadened;
  return result;
}

// ── Generate Research Ideas ───────────────────────────────────────────────────

async function generateProblems({ field, interests, country, difficulty, methodology, count = 5 }) {
  const client = getClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY is not configured.');

  const searchQuery = `${field} research gaps novel problems ${interests || ''}`.trim();
  const { papers } = await searchAcademic(searchQuery, 6);

  const paperCtx = papers.length
    ? '\nRecent papers in this area (for context):\n' + papers.slice(0, 5).map((p) => `- "${p.title}" (${p.year || 'n/a'})`).join('\n')
    : '';

  const prompt = `You are an expert academic research advisor. Generate novel research problem ideas.

## Researcher Profile
- Field: ${field}
- Interests: ${interests || 'Open to any topic within the field'}
- Country/Region: ${country || 'Not specified'}
- Difficulty Level: ${difficulty || 'Intermediate'}
- Preferred Methodology: ${methodology || 'Open to any'}
${paperCtx}

## Instructions
Generate exactly ${count} unique, novel, and feasible research ideas. Each idea must target a real gap that is underexplored.

Respond in EXACTLY this JSON format (no markdown outside JSON):
{
  "ideas": [
    {
      "title": "Short catchy research title",
      "problem": "2-3 sentence problem statement explaining what gap exists.",
      "whyItMatters": "1-2 sentences on real-world or academic significance.",
      "noveltyPotential": "High",
      "noveltyReason": "One sentence on why this is under-researched.",
      "methodology": "2-3 sentences on suggested approach.",
      "keywords": ["keyword1", "keyword2", "keyword3", "keyword4"],
      "researchGap": "One sentence on what is missing in current literature."
    }
  ]
}

noveltyPotential must be "High" or "Medium". Generate exactly ${count} ideas.`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 3500,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content[0].text;
  return parseClaudeJSON(text);
}

function parseClaudeJSON(text) {
  // Strip markdown code fences if present
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude returned an unexpected response format. Please try again.');
  try {
    return JSON.parse(match[0]);
  } catch {
    throw new Error('Claude response could not be parsed as JSON. Please try again.');
  }
}

module.exports = { checkNovelty, generateProblems };
