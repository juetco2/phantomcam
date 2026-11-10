/**
 * PhantomCam service worker (Manifest V3).
 *
 * Acts as the single place that talks to the Gemini API. Extension pages and
 * content scripts ask it for a summary over `chrome.runtime.sendMessage`, which
 * keeps the API key out of page context and avoids CORS entirely.
 */

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];
const GEMINI_HOST = 'https://generativelanguage.googleapis.com/v1beta/models';

const SUMMARY_PROMPT = `You are an expert executive meeting assistant. Analyze the following Google Meet
discussion transcript and produce a crisp, structured summary with exactly these sections:

1. Executive Summary (2-3 sentences)
2. Key Decisions Made
3. Action Items & Assignees

Use bullet points. Do not invent facts that are not supported by the transcript.

Transcript:
`;

const DEFAULT_SETTINGS = {
  phantomcamFreezeKey: 'F',
  phantomcamLiveKey: 'L',
  loopDuration: 15
};

// Seed defaults without clobbering anything the user has already saved.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS), (current) => {
    const missing = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (current[key] === undefined) missing[key] = value;
    }
    if (Object.keys(missing).length > 0) chrome.storage.local.set(missing);
  });
});

/**
 * Calls Gemini, falling back to the next model in GEMINI_MODELS when the
 * requested one is unavailable (retired, renamed, or not enabled for the key).
 */
async function generateSummary(transcriptText, apiKey) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: SUMMARY_PROMPT + transcriptText }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
  });

  let lastError = null;

  for (const model of GEMINI_MODELS) {
    let response;
    try {
      response = await fetch(`${GEMINI_HOST}/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body
      });
    } catch (networkError) {
      throw new Error(`Network error reaching Gemini: ${networkError.message}`);
    }

    if (response.ok) {
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('')
        .trim();
      if (text) return { ok: true, text, model };
      throw new Error('Gemini returned an empty response.');
    }

    const detail = await response.text();
    lastError = `Gemini ${response.status}: ${extractApiError(detail)}`;

    // Only a missing/unsupported model is worth retrying with another model.
    const modelMissing = response.status === 404 ||
      (response.status === 400 && /model/i.test(detail));
    if (!modelMissing) break;
  }

  return { ok: false, error: lastError || 'Gemini request failed.' };
}

function extractApiError(rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    return parsed?.error?.message || rawBody.slice(0, 200);
  } catch {
    return rawBody.slice(0, 200);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action !== 'GEMINI_SUMMARIZE') return undefined;

  (async () => {
    const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
    const apiKey = (message.apiKey || geminiApiKey || '').trim();

    if (!apiKey) {
      sendResponse({ ok: false, error: 'MISSING_API_KEY' });
      return;
    }
    if (!message.transcript || !message.transcript.trim()) {
      sendResponse({ ok: false, error: 'EMPTY_TRANSCRIPT' });
      return;
    }

    try {
      sendResponse(await generateSummary(message.transcript, apiKey));
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();

  // Keep the message channel open for the async response.
  return true;
});
