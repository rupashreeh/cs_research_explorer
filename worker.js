/**
 * Cloudflare Worker — CS Research Explorer proxy
 *
 * Routes:
 *   POST /         → Anthropic (Claude)
 *   POST /gemini   → Google Gemini
 *   POST /groq     → Groq
 *   POST /models   → DIAGNOSTIC: lists the models each key can actually see
 *
 * Ollama runs locally — called directly from the browser, no proxy needed.
 *
 * Setup — Settings → Variables and Secrets:
 *   ANTHROPIC_API_KEY  =  sk-ant-...
 *   GEMINI_API_KEY     =  AIza...
 *   GROQ_API_KEY       =  gsk_...
 *
 * WHY THE REWRITE: all three hardcoded model IDs 404'd with model_not_found.
 * Each route now walks a candidate list and uses the first one that answers,
 * so a single retirement no longer takes the whole app down. Upstream errors
 * are surfaced instead of being swallowed into an empty object.
 */

const ALLOWED_ORIGINS = [
  'https://rupashreeh.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

// Tried in order; first one that doesn't 404 wins. Newest first.
const CLAUDE_MODELS = [
  'claude-sonnet-5-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-5-5',
];

const GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.5-flash',
];

const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
];

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== 'POST') {
      return jsonError(request, 405, 'Method not allowed — use POST');
    }

    const path = new URL(request.url).pathname;

    try {
      if (path === '/models') return listModels(request, env);
      if (path === '/gemini') return proxyGemini(request, env);
      if (path === '/groq')   return proxyGroq(request, env);
      return proxyClaude(request, env);
    } catch (err) {
      return jsonError(request, 500, 'Worker threw: ' + (err && err.message));
    }
  }
};

// ── Claude (Anthropic) ────────────────────────────────────────────────────
// Returns Anthropic's NATIVE shape ({content:[{text}]}) because the frontend's
// callClaude() reads json.content[0].text. Do not normalise this one.
async function proxyClaude(request, env) {
  const body = await readJson(request);
  if (!body) return jsonError(request, 400, 'Invalid JSON in request body');
  if (!env.ANTHROPIC_API_KEY) return jsonError(request, 500, 'ANTHROPIC_API_KEY is not set in Worker secrets');

  let lastErr = 'no models attempted';

  for (const model of CLAUDE_MODELS) {
    const payload = {
      model,
      max_tokens: body.max_tokens || 4000,
      stream: false,
      messages: body.messages || [],
    };
    if (body.system) payload.system = body.system;
    if (typeof body.temperature === 'number') payload.temperature = body.temperature;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();

    if (upstream.ok) {
      const headers = corsHeaders(request);
      headers.set('Content-Type', 'application/json');
      headers.set('X-Model-Used', model);
      return new Response(text, { status: 200, headers });
    }

    lastErr = `${model} → HTTP ${upstream.status}: ${text.slice(0, 300)}`;
    // Only keep walking the list on "this model is gone". Anything else
    // (401 bad key, 429 rate limit, 529 overloaded) is terminal.
    if (upstream.status !== 404) break;
  }

  return jsonError(request, 502, 'Claude: ' + lastErr);
}

// ── Gemini (Google) ───────────────────────────────────────────────────────
// Normalised to OpenAI shape because the frontend routes this through
// callOpenAICompat(), which reads json.choices[0].message.content.
async function proxyGemini(request, env) {
  const body = await readJson(request);
  if (!body) return jsonError(request, 400, 'Invalid JSON in request body');
  if (!env.GEMINI_API_KEY) return jsonError(request, 500, 'GEMINI_API_KEY is not set in Worker secrets');

  const messages = body.messages || [];

  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const geminiBody = {
    contents,
    generationConfig: {
      maxOutputTokens: body.max_tokens || 3000,
      temperature: 0.2,
      // Forces bare JSON. Without this Gemini wraps output in ```json fences
      // and the frontend's JSON.parse quietly yields zero papers.
      responseMimeType: 'application/json',
    },
  };

  // Proper system slot — not a smuggled-in user turn, which Gemini
  // weights as ordinary conversation.
  const system = messages.find(m => m.role === 'system');
  if (system) geminiBody.systemInstruction = { parts: [{ text: system.content }] };

  let lastErr = 'no models attempted';

  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    let resp;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 8000)));
      }
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,   // header, not a query param
        },
        body: JSON.stringify(geminiBody),
      });
      if (resp.status !== 429 && resp.status !== 503) break;
    }

    const raw = await resp.text();

    if (!resp.ok) {
      lastErr = `${model} → HTTP ${resp.status}: ${raw.slice(0, 300)}`;
      if (resp.status !== 404) break;
      continue;
    }

    let json;
    try { json = JSON.parse(raw); } catch {
      lastErr = `${model} → unparseable upstream body`;
      break;
    }

    const cand = json.candidates && json.candidates[0];
    const text = cand && cand.content && cand.content.parts && cand.content.parts[0]
      ? cand.content.parts[0].text
      : null;

    // A blocked or truncated response used to look identical to success.
    if (!text) {
      const reason = (cand && cand.finishReason)
        || (json.promptFeedback && json.promptFeedback.blockReason)
        || 'empty candidate';
      return jsonError(request, 502, `Gemini returned no text (${reason})`);
    }

    const headers = corsHeaders(request);
    headers.set('Content-Type', 'application/json');
    headers.set('X-Model-Used', model);
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }),
      { status: 200, headers }
    );
  }

  return jsonError(request, 502, 'Gemini: ' + lastErr);
}

// ── Groq ──────────────────────────────────────────────────────────────────
async function proxyGroq(request, env) {
  const body = await readJson(request);
  if (!body) return jsonError(request, 400, 'Invalid JSON in request body');
  if (!env.GROQ_API_KEY) return jsonError(request, 500, 'GROQ_API_KEY is not set in Worker secrets');

  let lastErr = 'no models attempted';

  for (const model of GROQ_MODELS) {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: body.messages || [],
        max_tokens: body.max_tokens || 4000,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    const text = await upstream.text();

    if (upstream.ok) {
      const headers = corsHeaders(request);
      headers.set('Content-Type', 'application/json');
      headers.set('X-Model-Used', model);
      return new Response(text, { status: 200, headers });
    }

    lastErr = `${model} → HTTP ${upstream.status}: ${text.slice(0, 300)}`;
    if (upstream.status !== 404) break;
  }

  return jsonError(request, 502, 'Groq: ' + lastErr);
}

// ── Diagnostic: what can each key actually see? ───────────────────────────
// curl -X POST https://cs-research-proxy.rrangaiyengar.workers.dev/models
async function listModels(request, env) {
  const out = {};

  out.anthropic = env.ANTHROPIC_API_KEY
    ? await probe('https://api.anthropic.com/v1/models?limit=100', {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      }, d => (d.data || []).map(m => m.id))
    : 'ANTHROPIC_API_KEY not set';

  out.gemini = env.GEMINI_API_KEY
    ? await probe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
        { 'x-goog-api-key': env.GEMINI_API_KEY },
        d => (d.models || [])
          .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map(m => m.name.replace('models/', '')))
    : 'GEMINI_API_KEY not set';

  out.groq = env.GROQ_API_KEY
    ? await probe('https://api.groq.com/openai/v1/models',
        { 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
        d => (d.data || []).map(m => m.id))
    : 'GROQ_API_KEY not set';

  out.configured = { CLAUDE_MODELS, GEMINI_MODELS, GROQ_MODELS };

  const headers = corsHeaders(request);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(out, null, 2), { status: 200, headers });
}

async function probe(url, headers, extract) {
  try {
    const r = await fetch(url, { headers });
    const t = await r.text();
    if (!r.ok) return `HTTP ${r.status}: ${t.slice(0, 200)}`;
    return extract(JSON.parse(t));
  } catch (e) {
    return 'probe failed: ' + (e && e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

// Shaped as {error:{message}} so the frontend's existing
// `e.error ? e.error.message : ...` branch shows the real cause.
function jsonError(request, status, message) {
  const headers = corsHeaders(request);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify({ error: { message } }), { status, headers });
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return new Headers({
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-Model-Used',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  });
}
