const OFFSCREEN_URL = 'offscreen.html';
const PROVIDERS = ['allegro', 'ceneo', 'olx'];
const STORAGE_PREFIX = 'marketplaceExporter';
const stateKey = (provider) => `${STORAGE_PREFIX}:state:${provider}`;
const metaKey = (provider) => `${STORAGE_PREFIX}:jobMeta:${provider}`;

let creatingOffscreen = null;

let ceneoWorkerTabId = null;
let ceneoTabQueue = Promise.resolve();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getCeneoWorkerTab() {
  if (ceneoWorkerTabId != null) {
    try {
      const tab = await chrome.tabs.get(ceneoWorkerTabId);
      if (tab?.id != null) return tab.id;
    } catch {
      ceneoWorkerTabId = null;
    }
  }

  const tab = await chrome.tabs.create({
    url: 'https://www.ceneo.pl/',
    active: false,
  });
  ceneoWorkerTabId = tab.id;
  return tab.id;
}

async function waitForCeneoTab(tabId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error('Karta robocza Ceneo została zamknięta.');
    }
    if (tab?.status === 'complete' && /^https:\/\/(?:www\.)?ceneo\.pl\//i.test(tab.url || '')) {
      // Ceneo renderuje część danych po JS. Krótka pauza pozwala stronie zakończyć inicjalizację.
      await delay(1100);
      return tab;
    }
    await delay(250);
  }
  throw new Error('Przekroczono czas oczekiwania na załadowanie strony Ceneo.');
}

async function readCeneoTabHtml(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: () => ({
      html: document.documentElement?.outerHTML || '',
      url: location.href,
      title: document.title || '',
      readyState: document.readyState,
    }),
  });
  const result = results?.[0]?.result;
  if (!result?.html) throw new Error('Nie udało się odczytać HTML z karty Ceneo.');
  return result;
}

async function fetchCeneoInBrowserTab(url) {
  // Jedna kolejka i jedna normalna karta. Nie próbujemy omijać ochrony serwisu,
  // tylko pozwalamy Ceneo wykonać JavaScript i użyć zwykłej sesji/cookies Chrome.
  ceneoTabQueue = ceneoTabQueue.catch(() => {}).then(async () => {
    let tabId = await getCeneoWorkerTab();
    try {
      await chrome.tabs.update(tabId, { url, active: false });
      await waitForCeneoTab(tabId);
      return { ok: true, ...(await readCeneoTabHtml(tabId)) };
    } catch (error) {
      // Jeżeli użytkownik przypadkiem zamknął kartę roboczą, odtwarzamy ją raz.
      const message = String(error?.message || error || '');
      if (/zamknięta|No tab with id|tab was closed/i.test(message)) {
        ceneoWorkerTabId = null;
        tabId = await getCeneoWorkerTab();
        await chrome.tabs.update(tabId, { url, active: false });
        await waitForCeneoTab(tabId);
        return { ok: true, ...(await readCeneoTabHtml(tabId)) };
      }
      throw error;
    }
  });
  return ceneoTabQueue;
}

async function closeCeneoWorkerTab() {
  const tabId = ceneoWorkerTabId;
  ceneoWorkerTabId = null;
  if (tabId == null) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Karta mogła zostać zamknięta ręcznie.
  }
}


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
    if (message.type === 'RUNNER_CENEO_TAB_FETCH') {
      fetchCeneoInBrowserTab(message.url).then((data) => sendResponse(data))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message.type === 'RUNNER_CENEO_TAB_CLOSE') {
      closeCeneoWorkerTab().then(() => sendResponse({ ok: true }))
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
      if (message.provider === 'ceneo') await closeCeneoWorkerTab();
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
      const overrideOptions = message.options || {};
      const response = await sendRunner({
        type: 'MARKETPLACE_RUNNER_START',
        provider: message.provider,
        sourceUrl: meta.sourceUrl,
        options: {
          ...(meta.options || {}),
          ...overrideOptions,
          workerLimits: {
            ...((meta.options || {}).workerLimits || {}),
            ...(overrideOptions.workerLimits || {}),
          },
          skipSeen: true,
        },
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
