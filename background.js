const OFFSCREEN_URL = 'offscreen.html';
const PROVIDERS = ['allegro', 'ceneo', 'olx'];
const STORAGE_PREFIX = 'marketplaceExporter';
const stateKey = (provider) => `${STORAGE_PREFIX}:state:${provider}`;
const metaKey = (provider) => `${STORAGE_PREFIX}:jobMeta:${provider}`;

let creatingOffscreen = null;

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_PARSER'],
    justification: 'Eksport ofert działa niezależnie od kart użytkownika i wymaga DOMParser do analizy HTML.',
  }).finally(() => {
    creatingOffscreen = null;
  });
  return creatingOffscreen;
}

async function sendRunner(message) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ ...message, target: 'marketplace-runner' });
}

async function resumeInterruptedJobs(activeProviders = []) {
  const keys = [];
  for (const provider of PROVIDERS) keys.push(stateKey(provider), metaKey(provider));
  const data = await chrome.storage.local.get(keys);
  const resumed = [];

  for (const provider of PROVIDERS) {
    const state = data[stateKey(provider)] || {};
    const meta = data[metaKey(provider)] || null;
    if (!state.running || activeProviders.includes(provider) || !meta?.sourceUrl) continue;
    try {
      await sendRunner({
        type: 'MARKETPLACE_RUNNER_START',
        provider,
        sourceUrl: meta.sourceUrl,
        options: { ...(meta.options || {}), skipSeen: true },
        resume: true,
      });
      resumed.push(provider);
    } catch {
      // Pozostawiamy stan do ręcznego wznowienia z popupu.
    }
  }
  return resumed;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

  if (message.target === 'marketplace-background') {
    if (message.type === 'RUNNER_STORAGE_GET') {
      chrome.storage.local.get(message.keys).then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message.type === 'RUNNER_STORAGE_SET') {
      chrome.storage.local.set(message.items || {}).then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message.type === 'RUNNER_STORAGE_REMOVE') {
      chrome.storage.local.remove(message.keys).then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    return false;
  }

  if (message.target === 'marketplace-runner') return false;

  if (message.type === 'EXPORTER_BG_START') {
    (async () => {
      const response = await sendRunner({
        type: 'MARKETPLACE_RUNNER_START',
        provider: message.provider,
        sourceUrl: message.sourceUrl,
        options: message.options || {},
        resume: Boolean(message.resume),
      });
      sendResponse(response);
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message.type === 'EXPORTER_BG_STOP') {
    (async () => {
      const response = await sendRunner({ type: 'MARKETPLACE_RUNNER_STOP', provider: message.provider });
      sendResponse(response);
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message.type === 'EXPORTER_BG_RESUME') {
    (async () => {
      const data = await chrome.storage.local.get(metaKey(message.provider));
      const meta = data[metaKey(message.provider)];
      if (!meta?.sourceUrl) {
        sendResponse({ ok: false, error: 'Brak zapisanego adresu źródłowego do wznowienia.' });
        return;
      }
      const response = await sendRunner({
        type: 'MARKETPLACE_RUNNER_START',
        provider: message.provider,
        sourceUrl: meta.sourceUrl,
        options: { ...(meta.options || {}), skipSeen: true },
        resume: true,
      });
      sendResponse(response);
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message.type === 'EXPORTER_BG_HEALTH') {
    (async () => {
      let status = { ok: true, activeProviders: [] };
      try {
        status = await sendRunner({ type: 'MARKETPLACE_RUNNER_STATUS' });
      } catch {
        await ensureOffscreen();
      }
      const activeProviders = Array.isArray(status?.activeProviders) ? status.activeProviders : [];
      const resumed = await resumeInterruptedJobs(activeProviders);
      sendResponse({ ok: true, activeProviders, resumed });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return false;
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen()
    .then(() => sendRunner({ type: 'MARKETPLACE_RUNNER_STATUS' }))
    .then((status) => resumeInterruptedJobs(status?.activeProviders || []))
    .catch(() => {});
});
