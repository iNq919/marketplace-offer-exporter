const STORAGE_STATE = 'marketplaceExporterState';
const STORAGE_RESULT = 'marketplaceExporterResult';

const els = {
  startFromFirst: document.querySelector('#startFromFirst'),
  mode: document.querySelector('#mode'),
  maxOffers: document.querySelector('#maxOffers'),
  concurrency: document.querySelector('#concurrency'),
  delayMs: document.querySelector('#delayMs'),
  delayOutput: document.querySelector('#delayOutput'),
  startBtn: document.querySelector('#startBtn'),
  stopBtn: document.querySelector('#stopBtn'),
  statusBadge: document.querySelector('#statusBadge'),
  phase: document.querySelector('#phase'),
  percent: document.querySelector('#percent'),
  progress: document.querySelector('#progress'),
  pagesScanned: document.querySelector('#pagesScanned'),
  offersFound: document.querySelector('#offersFound'),
  processed: document.querySelector('#processed'),
  errors: document.querySelector('#errors'),
  currentItem: document.querySelector('#currentItem'),
  resultCard: document.querySelector('#resultCard'),
  resultMeta: document.querySelector('#resultMeta'),
  chunkLabel: document.querySelector('#chunkLabel'),
  prevChunkBtn: document.querySelector('#prevChunkBtn'),
  nextChunkBtn: document.querySelector('#nextChunkBtn'),
  copyChunkBtn: document.querySelector('#copyChunkBtn'),
  copyAllBtn: document.querySelector('#copyAllBtn'),
  downloadTxtBtn: document.querySelector('#downloadTxtBtn'),
  downloadJsonBtn: document.querySelector('#downloadJsonBtn'),
  messageBox: document.querySelector('#messageBox'),
};

let currentChunk = 0;
let cachedResult = null;
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

async function getActiveMarketplaceTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const provider = tab?.url ? providerFromUrl(tab.url) : null;
  if (!tab?.id || !provider) {
    throw new Error('Otwórz stronę Allegro lub Ceneo z ustawionymi filtrami.');
  }
  return { tab, provider };
}

function isMissingReceiverError(error) {
  const message = error?.message || String(error || '');
  return /receiving end does not exist|could not establish connection/i.test(message);
}

async function sendToMarketplaceTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function normalizeState(state = {}) {
  return {
    running: Boolean(state.running),
    provider: state.provider || '',
    phase: state.phase || 'Gotowy',
    pagesScanned: Number(state.pagesScanned || 0),
    offersFound: Number(state.offersFound || 0),
    processed: Number(state.processed || 0),
    errors: Number(state.errors || 0),
    currentItem: state.currentItem || '',
    percent: Math.max(0, Math.min(100, Number(state.percent || 0))),
    done: Boolean(state.done),
    failed: Boolean(state.failed),
  };
}

function renderState(rawState) {
  const state = normalizeState(rawState);
  els.phase.textContent = state.phase;
  els.progress.value = state.percent;
  els.percent.textContent = `${Math.round(state.percent)}%`;
  els.pagesScanned.textContent = state.pagesScanned;
  els.offersFound.textContent = state.offersFound;
  els.processed.textContent = state.processed;
  els.errors.textContent = state.errors;
  els.currentItem.textContent = state.currentItem;

  els.startBtn.disabled = state.running;
  els.stopBtn.disabled = !state.running;
  els.statusBadge.className = 'badge';

  if (state.running) {
    els.statusBadge.classList.add('running');
    els.statusBadge.textContent = state.provider ? providerLabel(state.provider) : 'pracuje';
  } else if (state.failed) {
    els.statusBadge.classList.add('error');
    els.statusBadge.textContent = 'błąd';
  } else if (state.done) {
    els.statusBadge.classList.add('done');
    els.statusBadge.textContent = 'gotowe';
  } else {
    els.statusBadge.classList.add('idle');
    els.statusBadge.textContent = 'gotowy';
  }
}

async function refresh() {
  const data = await chrome.storage.local.get([STORAGE_STATE, STORAGE_RESULT]);
  renderState(data[STORAGE_STATE]);

  if (data[STORAGE_RESULT]?.chunks?.length) {
    cachedResult = data[STORAGE_RESULT];
    currentChunk = Math.min(currentChunk, cachedResult.chunks.length - 1);
    renderResult();
  }
}

function renderResult() {
  if (!cachedResult?.chunks?.length) {
    els.resultCard.classList.add('hidden');
    return;
  }

  els.resultCard.classList.remove('hidden');
  const total = cachedResult.offers?.length || cachedResult.offerCount || 0;
  const modeLabel = cachedResult.mode === 'full' ? 'pełne opisy' : 'AI compact';
  const site = providerLabel(cachedResult.provider);
  els.resultMeta.textContent = `${site}: ${total} pozycji, ${cachedResult.chunks.length} fragmentów, tryb: ${modeLabel}`;
  els.chunkLabel.textContent = `Fragment ${currentChunk + 1}/${cachedResult.chunks.length}`;
  els.prevChunkBtn.disabled = currentChunk <= 0;
  els.nextChunkBtn.disabled = currentChunk >= cachedResult.chunks.length - 1;
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

els.delayMs.addEventListener('input', () => {
  els.delayOutput.value = `${els.delayMs.value} ms`;
});

els.startBtn.addEventListener('click', async () => {
  hideMessage();
  try {
    const { tab, provider } = await getActiveMarketplaceTab();
    const options = {
      startFromFirst: els.startFromFirst.checked,
      mode: els.mode.value,
      maxOffers: Math.max(0, Number.parseInt(els.maxOffers.value || '0', 10) || 0),
      concurrency: Math.max(1, Math.min(5, Number.parseInt(els.concurrency.value || '2', 10) || 2)),
      delayMs: Math.max(200, Number.parseInt(els.delayMs.value || '500', 10) || 500),
    };

    currentChunk = 0;
    cachedResult = null;
    els.resultCard.classList.add('hidden');
    await chrome.storage.local.remove(STORAGE_RESULT);

    const response = await sendToMarketplaceTab(tab.id, {
      type: 'MARKETPLACE_EXPORTER_START',
      options,
    });

    if (!response?.ok) {
      throw new Error(response?.error || `Nie udało się rozpocząć eksportu. Odśwież stronę ${providerLabel(provider)} i spróbuj ponownie.`);
    }

    showMessage(`Eksport z ${providerLabel(provider)} uruchomiony. Możesz zamknąć okno rozszerzenia i wrócić później.`, false);
    await refresh();
  } catch (error) {
    showMessage(error?.message || String(error));
  }
});

els.stopBtn.addEventListener('click', async () => {
  hideMessage();
  try {
    const { tab } = await getActiveMarketplaceTab();
    await sendToMarketplaceTab(tab.id, { type: 'MARKETPLACE_EXPORTER_STOP' });
    showMessage('Wysłano polecenie przerwania.', false);
  } catch (error) {
    showMessage(error?.message || String(error));
  }
});

els.prevChunkBtn.addEventListener('click', () => {
  if (currentChunk > 0) {
    currentChunk -= 1;
    renderResult();
  }
});

els.nextChunkBtn.addEventListener('click', () => {
  if (cachedResult && currentChunk < cachedResult.chunks.length - 1) {
    currentChunk += 1;
    renderResult();
  }
});

els.copyChunkBtn.addEventListener('click', async () => {
  if (!cachedResult?.chunks?.[currentChunk]) return;
  await navigator.clipboard.writeText(cachedResult.chunks[currentChunk]);
  showMessage(`Skopiowano fragment ${currentChunk + 1}/${cachedResult.chunks.length}.`, false);
});

els.copyAllBtn.addEventListener('click', async () => {
  if (!cachedResult?.fullText) return;
  try {
    await navigator.clipboard.writeText(cachedResult.fullText);
    showMessage('Skopiowano cały eksport.', false);
  } catch {
    showMessage('Cały eksport jest prawdopodobnie zbyt duży dla schowka. Użyj fragmentów lub pobierz TXT.');
  }
});

els.downloadTxtBtn.addEventListener('click', () => {
  if (!cachedResult?.fullText) return;
  const prefix = cachedResult.provider || 'oferty';
  downloadText(`${prefix}-export-${Date.now()}.txt`, cachedResult.fullText);
});

els.downloadJsonBtn.addEventListener('click', () => {
  if (!cachedResult?.offers) return;
  const prefix = cachedResult.provider || 'oferty';
  downloadText(
    `${prefix}-export-${Date.now()}.json`,
    JSON.stringify({
      provider: cachedResult.provider,
      sourceUrl: cachedResult.sourceUrl,
      generatedAt: cachedResult.generatedAt,
      mode: cachedResult.mode,
      offers: cachedResult.offers,
    }, null, 2),
    'application/json;charset=utf-8',
  );
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_STATE]) renderState(changes[STORAGE_STATE].newValue);
  if (changes[STORAGE_RESULT]?.newValue) {
    cachedResult = changes[STORAGE_RESULT].newValue;
    currentChunk = 0;
    renderResult();
  }
});

refreshTimer = setInterval(refresh, 1500);
window.addEventListener('unload', () => clearInterval(refreshTimer));
refresh().catch((error) => showMessage(error?.message || String(error)));
