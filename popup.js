const PROVIDERS = ['allegro', 'ceneo'];
const STORAGE_PREFIX = 'marketplaceExporter';
const LEGACY_STORAGE_STATE = 'marketplaceExporterState';
const LEGACY_STORAGE_RESULT = 'marketplaceExporterResult';

const stateKey = (provider) => `${STORAGE_PREFIX}:state:${provider}`;
const resultKey = (provider) => `${STORAGE_PREFIX}:result:${provider}`;
const historyKey = (provider) => `${STORAGE_PREFIX}:history:${provider}`;
const SETTINGS_KEY = `${STORAGE_PREFIX}:settings`;

const els = {
  activeSiteLabel: document.querySelector('#activeSiteLabel'),
  globalBadge: document.querySelector('#globalBadge'),
  startFromFirst: document.querySelector('#startFromFirst'),
  skipSeen: document.querySelector('#skipSeen'),
  mode: document.querySelector('#mode'),
  maxOffers: document.querySelector('#maxOffers'),
  concurrency: document.querySelector('#concurrency'),
  delayMs: document.querySelector('#delayMs'),
  delayOutput: document.querySelector('#delayOutput'),
  startCurrentBtn: document.querySelector('#startCurrentBtn'),
  startBothBtn: document.querySelector('#startBothBtn'),
  importHistoryBtn: document.querySelector('#importHistoryBtn'),
  historyFiles: document.querySelector('#historyFiles'),
  resultCard: document.querySelector('#resultCard'),
  resultTitle: document.querySelector('#resultTitle'),
  resultMeta: document.querySelector('#resultMeta'),
  resultProvider: document.querySelector('#resultProvider'),
  chunkLabel: document.querySelector('#chunkLabel'),
  prevChunkBtn: document.querySelector('#prevChunkBtn'),
  nextChunkBtn: document.querySelector('#nextChunkBtn'),
  copyChunkBtn: document.querySelector('#copyChunkBtn'),
  copyAllBtn: document.querySelector('#copyAllBtn'),
  downloadTxtBtn: document.querySelector('#downloadTxtBtn'),
  downloadJsonBtn: document.querySelector('#downloadJsonBtn'),
  messageBox: document.querySelector('#messageBox'),
};

const providerEls = Object.fromEntries(PROVIDERS.map((provider) => [provider, {
  badge: document.querySelector(`#${provider}Badge`),
  phase: document.querySelector(`#${provider}Phase`),
  percent: document.querySelector(`#${provider}Percent`),
  progress: document.querySelector(`#${provider}Progress`),
  pages: document.querySelector(`#${provider}Pages`),
  found: document.querySelector(`#${provider}Found`),
  queued: document.querySelector(`#${provider}Queued`),
  skipped: document.querySelector(`#${provider}Skipped`),
  processed: document.querySelector(`#${provider}Processed`),
  errors: document.querySelector(`#${provider}Errors`),
  declared: document.querySelector(`#${provider}Declared`),
  current: document.querySelector(`#${provider}Current`),
  stopBtn: document.querySelector(`#${provider}StopBtn`),
  resultBtn: document.querySelector(`#${provider}ResultBtn`),
  historyCount: document.querySelector(`#${provider}HistoryCount`),
  clearHistoryBtn: document.querySelector(`#${provider}ClearHistoryBtn`),
}]));

const states = { allegro: {}, ceneo: {} };
const results = { allegro: null, ceneo: null };
const chunkIndexes = { allegro: 0, ceneo: 0 };
let activeResultProvider = 'allegro';
let refreshTimer = null;

function providerFromUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'allegro.pl' || host.endsWith('.allegro.pl')) return 'allegro';
    if (host === 'ceneo.pl' || host.endsWith('.ceneo.pl')) return 'ceneo';
  } catch {
    // no-op
  }
  return null;
}

function providerLabel(provider) {
  return provider === 'ceneo' ? 'Ceneo' : 'Allegro';
}

function showMessage(message, error = true) {
  els.messageBox.textContent = message;
  els.messageBox.classList.remove('hidden');
  els.messageBox.style.background = error ? '#fef3f2' : '#ecfdf3';
  els.messageBox.style.color = error ? '#b42318' : '#027a48';
  els.messageBox.style.borderColor = error ? '#fecdca' : '#abefc6';
}

function hideMessage() {
  els.messageBox.classList.add('hidden');
}

function isMissingReceiverError(error) {
  const message = error?.message || String(error || '');
  return /receiving end does not exist|could not establish connection/i.test(message);
}

async function sendToMarketplaceTab(tabId, message, injectIfMissing = true) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!injectIfMissing || !isMissingReceiverError(error)) throw error;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await new Promise((resolve) => setTimeout(resolve, 160));
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function getTabsByProvider() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const grouped = { allegro: [], ceneo: [] };
  for (const tab of tabs) {
    const provider = providerFromUrl(tab.url || '');
    if (provider && tab.id) grouped[provider].push(tab);
  }
  for (const provider of PROVIDERS) {
    grouped[provider].sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  }
  return grouped;
}

async function getActiveMarketplaceTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const provider = providerFromUrl(tab?.url || '');
  if (!tab?.id || !provider) {
    throw new Error('Otwórz kartę Allegro lub Ceneo z ustawionymi filtrami.');
  }
  return { tab, provider };
}

function getOptions() {
  return {
    startFromFirst: els.startFromFirst.checked,
    skipSeen: els.skipSeen.checked,
    mode: els.mode.value,
    maxOffers: Math.max(0, Number.parseInt(els.maxOffers.value || '0', 10) || 0),
    concurrency: Math.max(1, Math.min(5, Number.parseInt(els.concurrency.value || '1', 10) || 1)),
    delayMs: Math.max(400, Number.parseInt(els.delayMs.value || '1200', 10) || 1200),
  };
}

async function saveSettings() {
  await chrome.storage.local.set({ [SETTINGS_KEY]: getOptions() });
}

async function loadSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = data[SETTINGS_KEY];
  if (!settings) return;
  els.startFromFirst.checked = settings.startFromFirst !== false;
  els.skipSeen.checked = settings.skipSeen !== false;
  els.mode.value = settings.mode === 'full' ? 'full' : 'compact';
  els.maxOffers.value = Number(settings.maxOffers || 0);
  els.concurrency.value = Math.max(1, Math.min(5, Number(settings.concurrency || 1)));
  els.delayMs.value = Math.max(400, Math.min(3000, Number(settings.delayMs || 1200)));
  els.delayOutput.value = `${els.delayMs.value} ms`;
}

function normalizeState(state = {}) {
  return {
    running: Boolean(state.running),
    provider: state.provider || '',
    phase: state.phase || 'Gotowy',
    pagesScanned: Number(state.pagesScanned || 0),
    offersFound: Number(state.offersFound || 0),
    queued: Number(state.queued || 0),
    skippedSeen: Number(state.skippedSeen || 0),
    processed: Number(state.processed || 0),
    errors: Number(state.errors || 0),
    declaredCount: Number.isFinite(Number(state.declaredCount)) ? Number(state.declaredCount) : null,
    totalPages: Number.isFinite(Number(state.totalPages)) ? Number(state.totalPages) : null,
    currentItem: state.currentItem || '',
    percent: Math.max(0, Math.min(100, Number(state.percent || 0))),
    done: Boolean(state.done),
    failed: Boolean(state.failed),
  };
}

function setBadge(el, state) {
  el.className = 'badge';
  if (state.running) {
    el.classList.add('running');
    el.textContent = 'pracuje';
  } else if (state.failed) {
    el.classList.add('error');
    el.textContent = 'błąd';
  } else if (state.done) {
    el.classList.add('done');
    el.textContent = state.errors ? 'gotowe z błędami' : 'gotowe';
  } else {
    el.classList.add('idle');
    el.textContent = 'gotowy';
  }
}

function renderGlobalBadge() {
  const running = PROVIDERS.filter((provider) => normalizeState(states[provider]).running).length;
  const errors = PROVIDERS.filter((provider) => normalizeState(states[provider]).failed).length;
  els.globalBadge.className = 'badge';
  if (running) {
    els.globalBadge.classList.add('running');
    els.globalBadge.textContent = running === 2 ? '2 zadania' : 'pracuje';
  } else if (errors) {
    els.globalBadge.classList.add('error');
    els.globalBadge.textContent = 'błąd';
  } else {
    els.globalBadge.classList.add('idle');
    els.globalBadge.textContent = 'gotowy';
  }
}

function renderState(provider, rawState) {
  const state = normalizeState(rawState);
  states[provider] = state;
  const ui = providerEls[provider];

  ui.phase.textContent = state.phase;
  ui.percent.textContent = `${Math.round(state.percent)}%`;
  ui.progress.value = state.percent;
  ui.pages.textContent = state.pagesScanned;
  ui.found.textContent = state.offersFound;
  ui.queued.textContent = state.queued;
  ui.skipped.textContent = state.skippedSeen;
  ui.processed.textContent = state.processed;
  ui.errors.textContent = state.errors;
  ui.current.textContent = state.currentItem;
  ui.stopBtn.disabled = !state.running;
  setBadge(ui.badge, state);

  const diagnostics = [];
  if (state.declaredCount) diagnostics.push(`Serwis deklaruje: ${state.declaredCount}`);
  if (state.totalPages) {
    diagnostics.push(provider === 'allegro'
      ? `widoczna paginacja do: ${state.totalPages}`
      : `stron wg paginacji: ${state.totalPages}`);
  }
  ui.declared.textContent = diagnostics.join(', ');
  renderGlobalBadge();
}

function historyCount(history) {
  return history?.items && typeof history.items === 'object' ? Object.keys(history.items).length : 0;
}

function renderHistory(provider, history) {
  providerEls[provider].historyCount.textContent = `Historia: ${historyCount(history)}`;
}

function renderResultButtons() {
  for (const provider of PROVIDERS) {
    providerEls[provider].resultBtn.disabled = !results[provider]?.chunks?.length;
  }
}

function renderResult() {
  const provider = activeResultProvider;
  const result = results[provider];
  if (!result?.chunks?.length) {
    const fallback = PROVIDERS.find((item) => results[item]?.chunks?.length);
    if (!fallback) {
      els.resultCard.classList.add('hidden');
      return;
    }
    activeResultProvider = fallback;
    els.resultProvider.value = fallback;
    return renderResult();
  }

  els.resultCard.classList.remove('hidden');
  els.resultProvider.value = provider;
  const total = result.offers?.length || result.offerCount || 0;
  const success = Number.isFinite(Number(result.successCount))
    ? Number(result.successCount)
    : (result.offers || []).filter((offer) => !offer.error).length;
  const errors = Number.isFinite(Number(result.errorCount))
    ? Number(result.errorCount)
    : Math.max(0, total - success);
  const discovered = result.discoveredCount || total;
  const skipped = result.skippedSeen || 0;
  const modeLabel = result.mode === 'full' ? 'pełne opisy' : 'AI compact';

  els.resultTitle.textContent = `Eksport ${providerLabel(provider)}`;
  const pages = Number(result.pagesScanned || 0);
  els.resultMeta.textContent = `Znalezione: ${discovered}, eksport: ${total}, poprawnie: ${success}, błędy: ${errors}, pominięte z historii: ${skipped}, przeskanowane strony: ${pages || '?'}, fragmenty: ${result.chunks.length}, tryb: ${modeLabel}`;

  const index = Math.min(chunkIndexes[provider] || 0, result.chunks.length - 1);
  chunkIndexes[provider] = index;
  els.chunkLabel.textContent = `Fragment ${index + 1}/${result.chunks.length}`;
  els.prevChunkBtn.disabled = index <= 0;
  els.nextChunkBtn.disabled = index >= result.chunks.length - 1;
}

function downloadText(filename, text, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function refreshActiveSiteLabel() {
  try {
    const { provider } = await getActiveMarketplaceTab();
    els.activeSiteLabel.textContent = `Bieżąca karta: ${providerLabel(provider)}. Możesz równolegle uruchomić drugi serwis.`;
  } catch {
    els.activeSiteLabel.textContent = 'Otwórz kartę Allegro lub Ceneo, albo użyj obu otwartych kart.';
  }
}

async function startOnTab(tab, provider) {
  const response = await sendToMarketplaceTab(tab.id, {
    type: 'MARKETPLACE_EXPORTER_START',
    options: getOptions(),
  });
  if (!response?.ok) throw new Error(response?.error || `Nie udało się rozpocząć eksportu ${providerLabel(provider)}.`);
}

async function stopProvider(provider) {
  const grouped = await getTabsByProvider();
  let sent = 0;
  for (const tab of grouped[provider]) {
    try {
      const response = await sendToMarketplaceTab(tab.id, { type: 'MARKETPLACE_EXPORTER_STOP' }, false);
      if (response?.ok) sent += 1;
    } catch {
      // Karta nie ma aktywnego content scriptu, więc nie ma czego zatrzymywać.
    }
  }
  if (!sent) showMessage(`Nie znalazłem aktywnego zadania ${providerLabel(provider)} na otwartych kartach.`, true);
  else showMessage(`Wysłano polecenie przerwania ${providerLabel(provider)}.`, false);
}

async function getHistory(provider) {
  const key = historyKey(provider);
  const data = await chrome.storage.local.get(key);
  const raw = data[key];
  return raw && typeof raw === 'object' ? raw : { version: 1, items: {} };
}

async function mergeHistory(provider, entries) {
  const key = historyKey(provider);
  const history = await getHistory(provider);
  history.version = 1;
  history.items = history.items && typeof history.items === 'object' ? history.items : {};
  const now = Date.now();

  for (const entry of entries) {
    if (!entry?.itemId) continue;
    history.items[String(entry.itemId)] = {
      seenAt: entry.seenAt || now,
      title: String(entry.title || '').slice(0, 180),
      url: entry.url || '',
    };
  }
  await chrome.storage.local.set({ [key]: history });
  renderHistory(provider, history);
  return entries.length;
}

function parseTxtHistory(text) {
  const provider = /#\s*Eksport z Ceneo/i.test(text) ? 'ceneo'
    : /#\s*Eksport z Allegro/i.test(text) ? 'allegro'
      : null;
  if (!provider) throw new Error('Nie rozpoznano, czy plik pochodzi z Allegro czy Ceneo.');

  const blocks = text.split(/\n\s*---\s*\n/g);
  const entries = [];
  for (const block of blocks) {
    if (/Błąd pobierania/i.test(block)) continue;
    const idRegex = provider === 'allegro' ? /-\s*ID oferty:\s*(\d+)/i : /-\s*ID produktu:\s*(\d+)/i;
    const id = block.match(idRegex)?.[1];
    if (!id) continue;
    const title = block.match(/^##\s*\d+\.\s*(.+)$/m)?.[1] || '';
    const url = block.match(/-\s*URL:\s*(https?:\/\/\S+)/i)?.[1] || '';
    entries.push({ itemId: id, title, url });
  }
  return { provider, entries };
}

function parseJsonHistory(text) {
  const value = JSON.parse(text);
  const provider = value?.provider;
  if (!PROVIDERS.includes(provider)) throw new Error('JSON nie zawiera poprawnego pola provider.');
  const offers = Array.isArray(value.offers) ? value.offers : [];
  const entries = offers
    .filter((offer) => offer && !offer.error && offer.itemId)
    .map((offer) => ({ itemId: offer.itemId, title: offer.title || '', url: offer.url || '' }));
  return { provider, entries };
}

async function importHistoryFiles(fileList) {
  let total = 0;
  const counts = { allegro: 0, ceneo: 0 };
  const errors = [];

  for (const file of [...fileList]) {
    try {
      const text = await file.text();
      const parsed = file.name.toLowerCase().endsWith('.json')
        ? parseJsonHistory(text)
        : parseTxtHistory(text);
      await mergeHistory(parsed.provider, parsed.entries);
      counts[parsed.provider] += parsed.entries.length;
      total += parsed.entries.length;
    } catch (error) {
      errors.push(`${file.name}: ${error?.message || String(error)}`);
    }
  }

  if (total) {
    showMessage(`Zaimportowano do historii: Allegro ${counts.allegro}, Ceneo ${counts.ceneo}.`, false);
  }
  if (errors.length) showMessage(`Nie udało się zaimportować części plików:\n${errors.join('\n')}`, true);
}

async function migrateLegacyStorage() {
  const legacy = await chrome.storage.local.get([LEGACY_STORAGE_STATE, LEGACY_STORAGE_RESULT]);
  const oldResult = legacy[LEGACY_STORAGE_RESULT];
  if (oldResult?.provider && PROVIDERS.includes(oldResult.provider)) {
    const provider = oldResult.provider;
    const newResultStorageKey = resultKey(provider);
    const existing = (await chrome.storage.local.get(newResultStorageKey))[newResultStorageKey];
    if (!existing) await chrome.storage.local.set({ [newResultStorageKey]: oldResult });
    const successful = (oldResult.offers || [])
      .filter((offer) => offer && !offer.error && offer.itemId)
      .map((offer) => ({ itemId: offer.itemId, title: offer.title || '', url: offer.url || '' }));
    await mergeHistory(provider, successful);
  }

  const oldState = legacy[LEGACY_STORAGE_STATE];
  if (oldState?.provider && PROVIDERS.includes(oldState.provider)) {
    const provider = oldState.provider;
    const key = stateKey(provider);
    const existing = (await chrome.storage.local.get(key))[key];
    if (!existing) await chrome.storage.local.set({ [key]: oldState });
  }
}

async function refresh() {
  const keys = [];
  for (const provider of PROVIDERS) keys.push(stateKey(provider), resultKey(provider), historyKey(provider));
  const data = await chrome.storage.local.get(keys);

  for (const provider of PROVIDERS) {
    renderState(provider, data[stateKey(provider)] || {});
    results[provider] = data[resultKey(provider)] || null;
    renderHistory(provider, data[historyKey(provider)] || { version: 1, items: {} });
  }
  renderResultButtons();
  renderResult();
  await refreshActiveSiteLabel();
}

els.delayMs.addEventListener('input', () => {
  els.delayOutput.value = `${els.delayMs.value} ms`;
});

for (const input of [els.startFromFirst, els.skipSeen, els.mode, els.maxOffers, els.concurrency, els.delayMs]) {
  input.addEventListener('change', () => saveSettings().catch(() => {}));
}

els.startCurrentBtn.addEventListener('click', async () => {
  hideMessage();
  try {
    await saveSettings();
    const { tab, provider } = await getActiveMarketplaceTab();
    await startOnTab(tab, provider);
    showMessage(`Eksport ${providerLabel(provider)} uruchomiony. Drugi serwis możesz uruchomić równolegle na jego karcie.`, false);
    await refresh();
  } catch (error) {
    showMessage(error?.message || String(error));
  }
});

els.startBothBtn.addEventListener('click', async () => {
  hideMessage();
  try {
    await saveSettings();
    const grouped = await getTabsByProvider();
    const missing = PROVIDERS.filter((provider) => grouped[provider].length === 0);
    const started = [];
    const failures = [];

    for (const provider of PROVIDERS) {
      const tab = grouped[provider][0];
      if (!tab) continue;
      try {
        await startOnTab(tab, provider);
        started.push(providerLabel(provider));
      } catch (error) {
        failures.push(`${providerLabel(provider)}: ${error?.message || String(error)}`);
      }
    }

    if (!started.length) throw new Error('Otwórz po jednej karcie Allegro i Ceneo z ustawionymi filtrami.');
    let message = `Uruchomiono: ${started.join(' + ')}.`;
    if (missing.length) message += ` Brak otwartej karty: ${missing.map(providerLabel).join(', ')}.`;
    if (failures.length) message += ` Błędy: ${failures.join(' | ')}`;
    showMessage(message, failures.length > 0);
    await refresh();
  } catch (error) {
    showMessage(error?.message || String(error));
  }
});

for (const provider of PROVIDERS) {
  providerEls[provider].stopBtn.addEventListener('click', () => stopProvider(provider).catch((error) => showMessage(error?.message || String(error))));
  providerEls[provider].resultBtn.addEventListener('click', () => {
    activeResultProvider = provider;
    els.resultProvider.value = provider;
    renderResult();
    els.resultCard.scrollIntoView({ block: 'nearest' });
  });
  providerEls[provider].clearHistoryBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove(historyKey(provider));
    renderHistory(provider, { version: 1, items: {} });
    showMessage(`Wyczyszczono historię ${providerLabel(provider)}.`, false);
  });
}

els.importHistoryBtn.addEventListener('click', () => els.historyFiles.click());
els.historyFiles.addEventListener('change', async () => {
  hideMessage();
  await importHistoryFiles(els.historyFiles.files || []);
  els.historyFiles.value = '';
  await refresh();
});

els.resultProvider.addEventListener('change', () => {
  activeResultProvider = els.resultProvider.value;
  renderResult();
});

els.prevChunkBtn.addEventListener('click', () => {
  const provider = activeResultProvider;
  if ((chunkIndexes[provider] || 0) > 0) {
    chunkIndexes[provider] -= 1;
    renderResult();
  }
});

els.nextChunkBtn.addEventListener('click', () => {
  const provider = activeResultProvider;
  const result = results[provider];
  if (result && (chunkIndexes[provider] || 0) < result.chunks.length - 1) {
    chunkIndexes[provider] += 1;
    renderResult();
  }
});

els.copyChunkBtn.addEventListener('click', async () => {
  const provider = activeResultProvider;
  const result = results[provider];
  const index = chunkIndexes[provider] || 0;
  if (!result?.chunks?.[index]) return;
  await navigator.clipboard.writeText(result.chunks[index]);
  showMessage(`Skopiowano ${providerLabel(provider)}, fragment ${index + 1}/${result.chunks.length}.`, false);
});

els.copyAllBtn.addEventListener('click', async () => {
  const result = results[activeResultProvider];
  if (!result?.fullText) return;
  try {
    await navigator.clipboard.writeText(result.fullText);
    showMessage(`Skopiowano cały eksport ${providerLabel(activeResultProvider)}.`, false);
  } catch {
    showMessage('Cały eksport jest zbyt duży dla schowka. Użyj fragmentów lub pobierz TXT.');
  }
});

els.downloadTxtBtn.addEventListener('click', () => {
  const result = results[activeResultProvider];
  if (!result?.fullText) return;
  downloadText(`${activeResultProvider}-export-${Date.now()}.txt`, result.fullText);
});

els.downloadJsonBtn.addEventListener('click', () => {
  const result = results[activeResultProvider];
  if (!result?.offers) return;
  downloadText(
    `${activeResultProvider}-export-${Date.now()}.json`,
    JSON.stringify(result, null, 2),
    'application/json;charset=utf-8',
  );
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const provider of PROVIDERS) {
    const stateChange = changes[stateKey(provider)];
    const resultChange = changes[resultKey(provider)];
    const historyChange = changes[historyKey(provider)];
    if (stateChange) renderState(provider, stateChange.newValue || {});
    if (resultChange) {
      results[provider] = resultChange.newValue || null;
      chunkIndexes[provider] = 0;
      renderResultButtons();
      if (activeResultProvider === provider || !results[activeResultProvider]) renderResult();
    }
    if (historyChange) renderHistory(provider, historyChange.newValue || { version: 1, items: {} });
  }
});

(async () => {
  try {
    await loadSettings();
    await migrateLegacyStorage();
    await refresh();
  } catch (error) {
    showMessage(error?.message || String(error));
  }
})();

refreshTimer = setInterval(() => refresh().catch(() => {}), 1800);
window.addEventListener('unload', () => clearInterval(refreshTimer));
