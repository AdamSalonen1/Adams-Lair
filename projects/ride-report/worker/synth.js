// The one nondeterministic step: hand Claude the already-computed numbers and
// get prose back. Everything here is defensive — the report row must land even
// when the CLI is rate-limited, logged out, hung, or returning garbage.
//
// Contract with the rest of the pipeline: synthesize() NEVER throws. It always
// resolves to a usable payload, and reports honestly whether it came from
// 'claude' or 'fallback'.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tripFallbackSummary } from './trip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Overridable so prompt variants can be A/B'd (and sabotaged in tests) without
// editing the versioned prompt.
const PROMPT_PATH = process.env.SYNTH_PROMPT_PATH || path.join(HERE, 'prompt.md');
const TRIP_PROMPT_PATH = process.env.SYNTH_TRIP_PROMPT_PATH || path.join(HERE, 'prompt-trip.md');

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const DEFAULT_TIMEOUT_MS = Number(process.env.SYNTH_TIMEOUT_MS || 180_000);
const MUD_LABEL = {
  dry: 'Trails should be in good shape.',
  damp: 'Trails are damp — expect soft spots.',
  muddy: 'Trails are mud — make it a pavement day.',
};

/**
 * Pull a JSON object out of model output. The prompt demands bare JSON, but a
 * stray ```json fence or a leading "Here's the report:" is the single most
 * likely deviation and is trivially recoverable — recovering beats burning a
 * retry on it.
 */
export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('result was not a string');
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch { /* fall through */ }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch { /* fall through */ }
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }

  throw new Error('no JSON object found in result');
}

/**
 * Validate the model's payload. Returns an array of human-readable problems —
 * empty means valid. These strings get fed back verbatim on the retry, so
 * they're written to be actionable by the model.
 */
export function validatePayload(payload) {
  const errors = [];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  if (!isObj(payload)) return ['Response must be a single JSON object.'];

  if (typeof payload.day_score !== 'number' || Number.isNaN(payload.day_score)) {
    errors.push('`day_score` must be a number.');
  } else if (payload.day_score < 0 || payload.day_score > 100) {
    errors.push(`\`day_score\` must be between 0 and 100 (got ${payload.day_score}).`);
  }

  if (typeof payload.summary !== 'string' || !payload.summary.trim()) {
    errors.push('`summary` must be a non-empty string.');
  } else if (payload.summary.length > 1200) {
    errors.push(`\`summary\` is ${payload.summary.length} chars; keep it under 1200.`);
  }

  if (!Array.isArray(payload.windows)) {
    errors.push('`windows` must be an array (use [] if there are none).');
  } else {
    payload.windows.forEach((w, i) => {
      if (!isObj(w)) { errors.push(`windows[${i}] must be an object.`); return; }
      if (typeof w.start !== 'string') errors.push(`windows[${i}].start must be a string.`);
      if (typeof w.end !== 'string') errors.push(`windows[${i}].end must be a string.`);
      if (typeof w.avgScore !== 'number') errors.push(`windows[${i}].avgScore must be a number.`);
    });
  }

  if (!isObj(payload.mud)) {
    errors.push('`mud` must be an object with `risk` and `weightedPrecip`.');
  } else {
    if (!['dry', 'damp', 'muddy'].includes(payload.mud.risk)) {
      errors.push(`\`mud.risk\` must be "dry", "damp", or "muddy" (got ${JSON.stringify(payload.mud.risk)}).`);
    }
    if (typeof payload.mud.weightedPrecip !== 'number') {
      errors.push('`mud.weightedPrecip` must be a number.');
    }
  }

  if (payload.headline != null && typeof payload.headline !== 'string') {
    errors.push('`headline`, if present, must be a string.');
  }

  return errors;
}

/**
 * Validate a trip narrative. Far looser than the daily check, and deliberately
 * so: the trip prompt asks for prose *only* — the scores, windows and per-day
 * mud are attached by code and never round-trip through the model, so there is
 * no numeric agreement left to police here.
 */
export function validateTripPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Response must be a single JSON object.'];
  }

  if (typeof payload.summary !== 'string' || !payload.summary.trim()) {
    errors.push('`summary` must be a non-empty string.');
  } else if (payload.summary.length > 1800) {
    errors.push(`\`summary\` is ${payload.summary.length} chars; keep it under 1800.`);
  }

  if (payload.headline != null && typeof payload.headline !== 'string') {
    errors.push('`headline`, if present, must be a string.');
  }

  return errors;
}

/** Spawn `claude -p`, write the ground-truth JSON to stdin, parse the envelope. */
function runClaude(promptText, inputJson, { model, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', promptText,
      '--output-format', 'json',
      '--model', model,
      // Pure text transformation: no tools, no MCP servers, and no session
      // files piling up on the Pi across months of 3-hourly runs.
      '--disallowed-tools', 'Bash Edit Write Read Glob Grep WebFetch WebSearch Task NotebookEdit',
      '--strict-mcp-config',
      '--no-session-persistence',
    ];

    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: HERE,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`could not spawn claude: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.trim().slice(0, 400) || '(no stderr)'}`));
        return;
      }

      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        reject(new Error(`claude returned unparseable envelope: ${stdout.slice(0, 300)}`));
        return;
      }

      if (envelope.is_error || envelope.subtype !== 'success') {
        reject(new Error(`claude reported failure: ${envelope.subtype} ${envelope.api_error_status || ''}`.trim()));
        return;
      }

      resolve({
        resultText: envelope.result,
        durationMs: envelope.duration_ms,
        costUsd: envelope.total_cost_usd,
        sessionId: envelope.session_id,
      });
    });

    child.stdin.write(JSON.stringify(inputJson, null, 2));
    child.stdin.end();
  });
}

/**
 * The attempt loop, shared by the daily and trip paths: run the prompt, parse,
 * validate, and on a bad first result retry once with the validation errors fed
 * back verbatim.
 *
 * Resolves to `{ parsed, model }` on success or `{ parsed: null, problem }` on
 * exhaustion — never throws, which is what lets both callers keep their promise
 * that a report row always lands.
 */
async function narrate({ promptPath, input, validate, model, timeoutMs }) {
  const basePrompt = await readFile(promptPath, 'utf8');
  let prompt = basePrompt;
  let lastProblem = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const started = Date.now();
      const { resultText, durationMs, costUsd } = await runClaude(prompt, input, { model, timeoutMs });

      const parsed = extractJson(resultText);
      const errors = validate(parsed);

      if (!errors.length) {
        console.log(`[synth] ok on attempt ${attempt} (${durationMs}ms, $${(costUsd ?? 0).toFixed(4)})`);
        return {
          parsed,
          model: { name: model, duration_ms: durationMs ?? (Date.now() - started), cost_usd: costUsd },
        };
      }

      lastProblem = errors.join(' ');
      console.warn(`[synth] attempt ${attempt} produced invalid payload: ${lastProblem}`);
    } catch (err) {
      lastProblem = err.message;
      console.warn(`[synth] attempt ${attempt} failed: ${err.message}`);
    }

    if (attempt === 1) {
      prompt = `${basePrompt}\n\n## Your previous response was rejected\n\n${lastProblem}\n\nReturn corrected JSON only — no fences, no commentary. First character '{', last character '}'.`;
    }
  }

  return { parsed: null, problem: lastProblem };
}

/** Deterministic prose from the score data. Never fails, never phones home. */
export function fallbackPayload(truth) {
  const { day_score: score, windows, mud } = truth;

  let verdict;
  if (score == null) verdict = 'Not enough data to call it';
  else if (score >= 90) verdict = 'Excellent — get out there';
  else if (score >= 75) verdict = 'Great day to ride';
  else if (score >= 60) verdict = 'Good, with some caveats';
  else if (score >= 45) verdict = 'Okay — pick your window carefully';
  else if (score >= 30) verdict = 'Rough one — short window if any';
  else verdict = 'Not a riding day';

  const best = windows.find((w) => w.best) || windows[0];
  const timeOf = (s) => {
    const h = Number(String(s).slice(11, 13));
    if (Number.isNaN(h)) return String(s);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12} ${ampm}`;
  };

  const parts = [`${verdict}.`];
  if (best) {
    parts.push(
      best.fallback
        ? `Nothing clears the bar today; the least-bad stretch is ${timeOf(best.start)} to ${timeOf(best.end)}, averaging ${best.avgScore}.`
        : `Best stretch is ${timeOf(best.start)} to ${timeOf(best.end)}, averaging ${best.avgScore}.`,
    );
  } else {
    parts.push('No daylight window worth calling out today.');
  }
  if (mud?.risk) parts.push(MUD_LABEL[mud.risk] || '');

  // No "narrative unavailable" disclaimer in the prose. That fact lives in the
  // row's `source` column, where it is machine-readable, and the page renders
  // it as a small note beside the summary — which is both more visible at a
  // glance and one less sentence of apology to read on a bad day.

  return {
    ...truth,
    summary: parts.filter(Boolean).join(' '),
    headline: verdict,
  };
}

function mockPayload(truth) {
  const base = fallbackPayload(truth);
  return {
    ...base,
    summary: `MOCK SYNTH — pipeline ran end to end without calling the Claude CLI. Score ${truth.day_score}, mud ${truth.mud?.risk}.`,
    headline: 'Mock run — no LLM called',
  };
}

/**
 * Ground truth in, narrated payload out.
 *
 * Resolves to { payload, source, model } where source is 'claude' or
 * 'fallback' — the two values the reports.source CHECK constraint allows.
 * MOCK_SYNTH reports 'fallback' because the prose genuinely did not come from
 * Claude, and the database should not claim otherwise.
 */
export async function synthesize(truth, {
  context = null,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  mock = process.env.MOCK_SYNTH === '1',
} = {}) {
  // The model sees richer detail (hourly limiting factors, temps, wind) than
  // gets stored — the DB payload stays the lean Phase 2 shape.
  const stdinPayload = context ? { ...truth, context } : truth;
  if (mock) {
    console.log('[synth] MOCK_SYNTH=1 — skipping the Claude CLI');
    return {
      payload: mockPayload(truth),
      source: 'fallback',
      model: { name: 'mock', duration_ms: 0 },
    };
  }

  const { parsed, problem, model: modelInfo } = await narrate({
    promptPath: PROMPT_PATH,
    input: stdinPayload,
    validate: validatePayload,
    model,
    timeoutMs,
  });

  if (!parsed) {
    console.error(`[synth] falling back to deterministic summary after 2 attempts: ${problem}`);
    return {
      payload: fallbackPayload(truth),
      source: 'fallback',
      model: { name: model, duration_ms: 0, error: problem },
    };
  }

  return {
    // Deterministic fields are re-asserted from ground truth: the model is
    // asked to copy them through, but the score engine owns them and code is a
    // better enforcer of that than a prompt is.
    payload: {
      ...truth,
      summary: parsed.summary.trim(),
      headline: typeof parsed.headline === 'string' ? parsed.headline.trim() : undefined,
    },
    source: 'claude',
    model: modelInfo,
  };
}

/**
 * Same contract as synthesize(), for a trip's multi-day outlook: never throws,
 * always resolves to a usable payload, reports honestly which one it is.
 *
 * The one structural difference is that the model contributes *only* prose
 * here. `truth` carries the per-day scores, windows and mud straight through to
 * the payload without ever being shown back to the model for echoing, so
 * there's no verbatim-copy contract to enforce on the way out.
 */
export async function synthesizeTrip(truth, {
  context = null,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  mock = process.env.MOCK_SYNTH === '1',
} = {}) {
  const stdinPayload = context ? { ...truth, context } : truth;

  if (mock) {
    console.log('[synth] MOCK_SYNTH=1 — skipping the Claude CLI');
    const base = tripFallbackSummary(truth);
    return {
      payload: {
        ...base,
        summary: `MOCK SYNTH — trip pipeline ran end to end without calling the Claude CLI. ${truth.days.length} day(s) scored, best ${truth.best_days[0] ?? 'n/a'}.`,
        headline: 'Mock run — no LLM called',
      },
      source: 'fallback',
      model: { name: 'mock', duration_ms: 0 },
    };
  }

  const { parsed, problem, model: modelInfo } = await narrate({
    promptPath: TRIP_PROMPT_PATH,
    input: stdinPayload,
    validate: validateTripPayload,
    model,
    timeoutMs,
  });

  if (!parsed) {
    console.error(`[synth] trip falling back to deterministic summary after 2 attempts: ${problem}`);
    return {
      payload: tripFallbackSummary(truth),
      source: 'fallback',
      model: { name: model, duration_ms: 0, error: problem },
    };
  }

  return {
    payload: {
      ...truth,
      summary: parsed.summary.trim(),
      headline: typeof parsed.headline === 'string' ? parsed.headline.trim() : undefined,
    },
    source: 'claude',
    model: modelInfo,
  };
}
