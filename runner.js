(() => {
  const LEGACY_STORAGE_STATE = 'marketplaceExporterState';
  const LEGACY_STORAGE_RESULT = 'marketplaceExporterResult';
  const STORAGE_PREFIX = 'marketplaceExporter';

  const stateKey = (provider) => `${STORAGE_PREFIX}:state:${provider}`;
  const resultKey = (provider) => `${STORAGE_PREFIX}:result:${provider}`;
  const historyKey = (provider) => `${STORAGE_PREFIX}:history:${provider}`;
  const metaKey = (provider) => `${STORAGE_PREFIX}:jobMeta:${provider}`;
  const scanCacheKey = (provider) => `${STORAGE_PREFIX}:scanCache:${provider}`;
  const SCAN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const MAX_LISTING_PAGES = 100;
  const MAX_CHAT_CHUNK = 48000;

  const jobs = { allegro: null, ceneo: null, olx: null };
  // Bezpieczne limity per serwis. Allegro celowo pozostaje na 1 workerze,
  // żeby nie powtarzać sytuacji z blokadą antybotową. Wolne sloty mogą
  // przechodzić na Ceneo/OLX, ale nigdy nie zwiększają limitu Allegro.
  const PROVIDER_DEFAULT_WORKERS = { allegro: 1, ceneo: 1, olx: 4 };
  const PROVIDER_HARD_MAX_WORKERS = { allegro: 2, ceneo: 1, olx: 6 };
  const providerControl = {
    allegro: { penalty: 0, successStreak: 0, cooldownUntil: 0, nextRequestAt: 0, requestCount: 0 },
    ceneo: { penalty: 0, successStreak: 0, cooldownUntil: 0, nextRequestAt: 0, requestCount: 0 },
    olx: { penalty: 0, successStreak: 0, cooldownUntil: 0, nextRequestAt: 0, requestCount: 0 },
  };

  function configuredProviderLimit(provider) {
    const fallback = PROVIDER_DEFAULT_WORKERS[provider] || 1;
    const hardMax = PROVIDER_HARD_MAX_WORKERS[provider] || fallback;
    const requested = Number(jobs[provider]?.options?.workerLimits?.[provider] ?? fallback);
    return Math.max(1, Math.min(hardMax, Number.isFinite(requested) ? Math.round(requested) : fallback));
  }

  const scheduler = {
    limit: 6,
    active: 0,
    activeByProvider: { allegro: 0, ceneo: 0, olx: 0 },
    waiters: [],

    setLimit(value) {
      this.limit = Math.max(2, Math.min(9, Number(value || 6)));
      this.pump();
    },

    activeProviders() {
      return Object.keys(jobs).filter((provider) => Boolean(jobs[provider]));
    },

    dynamicCap(provider) {
      const providers = this.activeProviders();
      const activeCount = Math.max(1, providers.length);
      const fairShare = Math.max(1, Math.floor(this.limit / activeCount));
      const otherWaiting = this.waiters.some((item) => item.provider !== provider && !item.cancelled);
      const canBorrow = !otherWaiting;
      const base = canBorrow ? this.limit : fairShare;
      const penalty = providerControl[provider]?.penalty || 0;
      return Math.max(1, Math.min(configuredProviderLimit(provider), base - penalty));
    },

    acquire(provider, signal) {
      if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
      return new Promise((resolve, reject) => {
        const waiter = { provider, resolve, reject, signal, cancelled: false, abortHandler: null };
        if (signal) {
          waiter.abortHandler = () => {
            waiter.cancelled = true;
            reject(new DOMException('Aborted', 'AbortError'));
            this.pump();
          };
          signal.addEventListener('abort', waiter.abortHandler, { once: true });
        }
        this.waiters.push(waiter);
        this.pump();
      });
    },

    pump() {
      if (this.active >= this.limit) return;
      let madeProgress = true;
      while (this.active < this.limit && madeProgress) {
        madeProgress = false;
        for (let i = 0; i < this.waiters.length; i += 1) {
          const waiter = this.waiters[i];
          if (waiter.cancelled || waiter.signal?.aborted) {
            this.waiters.splice(i, 1);
            i -= 1;
            continue;
          }
          const cap = this.dynamicCap(waiter.provider);
          if ((this.activeByProvider[waiter.provider] || 0) >= cap) continue;
          this.waiters.splice(i, 1);
          if (waiter.abortHandler && waiter.signal) waiter.signal.removeEventListener('abort', waiter.abortHandler);
          this.active += 1;
          this.activeByProvider[waiter.provider] = (this.activeByProvider[waiter.provider] || 0) + 1;
          let released = false;
          waiter.resolve(() => {
            if (released) return;
            released = true;
            this.active = Math.max(0, this.active - 1);
            this.activeByProvider[waiter.provider] = Math.max(0, (this.activeByProvider[waiter.provider] || 0) - 1);
            this.pump();
          });
          madeProgress = true;
          break;
        }
      }
    },
  };


  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function storageGet(keys) {
    const response = await chrome.runtime.sendMessage({
      target: 'marketplace-background',
      type: 'RUNNER_STORAGE_GET',
      keys,
    });
    if (!response?.ok) throw new Error(response?.error || 'Nie udało się odczytać storage.');
    return response.data || {};
  }

  async function storageSet(items) {
    const response = await chrome.runtime.sendMessage({
      target: 'marketplace-background',
      type: 'RUNNER_STORAGE_SET',
      items,
    });
    if (!response?.ok) throw new Error(response?.error || 'Nie udało się zapisać storage.');
  }

  async function storageRemove(keys) {
    const response = await chrome.runtime.sendMessage({
      target: 'marketplace-background',
      type: 'RUNNER_STORAGE_REMOVE',
      keys,
    });
    if (!response?.ok) throw new Error(response?.error || 'Nie udało się usunąć danych ze storage.');
  }

  async function fetchCeneoViaBrowserTab(url, signal) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    let abortHandler;
    const abortPromise = signal ? new Promise((_, reject) => {
      abortHandler = () => reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', abortHandler, { once: true });
    }) : null;

    const requestPromise = chrome.runtime.sendMessage({
      target: 'marketplace-background',
      type: 'RUNNER_CENEO_TAB_FETCH',
      url,
    });

    try {
      const response = abortPromise
        ? await Promise.race([requestPromise, abortPromise])
        : await requestPromise;
      if (!response?.ok) throw new Error(response?.error || 'Nie udało się pobrać Ceneo przez kartę przeglądarki.');
      if (!response.html) throw new Error('Karta Ceneo nie zwróciła HTML.');
      return response.html;
    } finally {
      if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
    }
  }

  async function closeCeneoBrowserTab() {
    try {
      await chrome.runtime.sendMessage({
        target: 'marketplace-background',
        type: 'RUNNER_CENEO_TAB_CLOSE',
      });
    } catch {
      // Zamknięcie karty roboczej nie może wywrócić wyniku eksportu.
    }
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function singleLine(value) {
    return cleanText(value).replace(/\s*\n\s*/g, ' ');
  }

  function truncate(value, max) {
    const text = cleanText(value);
    if (text.length <= max) return text;
    return `${text.slice(0, max).trimEnd()}...`;
  }

  function absoluteUrl(href, base) {
    try {
      return new URL(href, base).href;
    } catch {
      return null;
    }
  }

  function detectProvider(rawUrl = location.href) {
    try {
      const hostname = new URL(rawUrl).hostname.toLowerCase();
      if (hostname === 'allegro.pl' || hostname.endsWith('.allegro.pl')) return 'allegro';
      if (hostname === 'ceneo.pl' || hostname.endsWith('.ceneo.pl')) return 'ceneo';
      if (hostname === 'olx.pl' || hostname.endsWith('.olx.pl')) return 'olx';
    } catch {
      // no-op
    }
    return null;
  }

  function providerLabel(provider) {
    if (provider === 'ceneo') return 'Ceneo';
    if (provider === 'olx') return 'OLX';
    return 'Allegro';
  }

  function parseDocument(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function parseJsonLd(doc) {
    const values = [];

    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || 'null');
        if (Array.isArray(parsed)) values.push(...parsed);
        else if (parsed) values.push(parsed);
      } catch {
        // Ignore malformed JSON-LD.
      }
    }

    function flatten(items) {
      const output = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        output.push(item);
        if (Array.isArray(item['@graph'])) output.push(...flatten(item['@graph']));
      }
      return output;
    }

    return flatten(values);
  }

  function findProductJsonLd(doc) {
    return parseJsonLd(doc).find((item) => {
      const type = item?.['@type'];
      return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
    }) || null;
  }

  function getMeta(doc, selector, attr = 'content') {
    return cleanText(doc.querySelector(selector)?.getAttribute(attr) || '');
  }

  function fragmentToText(fragment) {
    const blockTags = new Set([
      'P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'TR', 'DT', 'DD',
      'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'TABLE', 'BR',
    ]);

    function walk(node, out) {
      if (node.nodeType === Node.TEXT_NODE) {
        out.push(node.nodeValue || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;

      const tag = node.nodeType === Node.ELEMENT_NODE ? node.tagName : '';
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      if (tag === 'BR') {
        out.push('\n');
        return;
      }

      for (const child of node.childNodes) walk(child, out);
      if (blockTags.has(tag)) out.push('\n');
    }

    const parts = [];
    walk(fragment, parts);
    return cleanText(parts.join(''));
  }

  function extractSectionByMatcher(doc, startMatcher, endMatchers = []) {
    const headings = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const startIndex = headings.findIndex((heading) => startMatcher(singleLine(heading.textContent)));
    if (startIndex < 0) return '';

    let end = null;
    for (let i = startIndex + 1; i < headings.length; i += 1) {
      const text = singleLine(headings[i].textContent);
      if (endMatchers.some((matcher) => matcher(text))) {
        end = headings[i];
        break;
      }
    }

    const range = doc.createRange();
    range.setStartAfter(headings[startIndex]);
    if (end) range.setEndBefore(end);
    else range.setEndAfter(doc.body);

    return fragmentToText(range.cloneContents());
  }

  function extractSection(doc, startHeadingText, endHeadingTexts = []) {
    const start = startHeadingText.toLowerCase();
    const ends = endHeadingTexts.map((value) => value.toLowerCase());
    return extractSectionByMatcher(
      doc,
      (text) => text.toLowerCase() === start,
      ends.map((end) => (text) => text.toLowerCase() === end),
    );
  }

  function extractParameterByLabel(doc, label) {
    const labelLower = label.toLowerCase();

    for (const row of doc.querySelectorAll('tr')) {
      const cells = [...row.querySelectorAll(':scope > th, :scope > td')];
      if (cells.length < 2) continue;
      const key = singleLine(cells[0].textContent).replace(/\?[^|]*$/, '').trim();
      if (key.toLowerCase() === labelLower) {
        const value = singleLine(cells[cells.length - 1].textContent);
        if (value && value.toLowerCase() !== labelLower) return value;
      }
    }

    for (const dt of doc.querySelectorAll('dt')) {
      if (singleLine(dt.textContent).toLowerCase() !== labelLower) continue;
      const dd = dt.nextElementSibling;
      const value = singleLine(dd?.textContent);
      if (value) return value;
    }

    const all = [...doc.querySelectorAll('body *')];
    const leaves = all.filter((el) => {
      if (el.children.length > 0) return false;
      const text = singleLine(el.textContent).replace(/\?$/, '').trim().toLowerCase();
      return text === labelLower;
    });

    for (const leaf of leaves) {
      const siblingCandidates = [leaf.nextElementSibling, leaf.previousElementSibling].filter(Boolean);
      for (const sibling of siblingCandidates) {
        const value = singleLine(sibling.textContent);
        if (value && value.toLowerCase() !== labelLower && value.length <= 250) return value;
      }

      let parent = leaf.parentElement;
      for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
        const whole = singleLine(parent.textContent);
        if (!whole || whole.length > 450) continue;
        const index = whole.toLowerCase().indexOf(labelLower);
        if (index === -1) continue;
        const value = cleanText(`${whole.slice(0, index)} ${whole.slice(index + label.length)}`)
          .replace(/^\?+\s*/, '');
        if (value && value.toLowerCase() !== labelLower && value.length <= 250) return value;
      }
    }

    return '';
  }

  function extractKnownParameters(doc) {
    const labels = [
      'Stan',
      'Producent',
      'Marka',
      'Model',
      'Kod producenta',
      'EAN (GTIN)',
      'EAN',
      'Pojemność dysku',
      'Pojemność',
      'Format dysku',
      'Format',
      'Interfejs',
      'Pamięć podręczna',
      'Cache',
      'Prędkość obrotowa',
      'Prędkość Obrotowa',
      'Rodzaj dysku',
      'Przeznaczenie',
      'Technologia zapisu',
      'Gwarancja',
    ];

    const params = {};
    for (const label of labels) {
      const value = extractParameterByLabel(doc, label);
      if (value) params[label] = value;
    }
    return params;
  }

  function extractAllTableParameters(doc) {
    const params = {};
    for (const row of doc.querySelectorAll('tr')) {
      const cells = [...row.querySelectorAll(':scope > th, :scope > td')];
      if (cells.length < 2) continue;
      const rawKey = singleLine(cells[0].textContent);
      const rawValue = singleLine(cells[cells.length - 1].textContent);
      const key = rawKey.split('?')[0].trim();
      if (!key || !rawValue || key.length > 80 || rawValue.length > 300 || key === rawValue) continue;
      params[key] = rawValue;
    }
    return params;
  }

  // Allegro
  function providerRequestGap(provider) {
    const options = jobs[provider]?.options || {};
    const base = Math.max(200, Number(options.delayMs || 700));

    // Allegro ma osobny, konserwatywny limit niezależny od globalnej puli.
    // Nawet jeśli pozostałe serwisy skończą, Allegro nie przyspiesza ponad 1 request
    // mniej więcej co 3.2 s. Ceneo i OLX mogą wykorzystać wolne workery w ramach
    // swoich limitów.
    if (provider === 'allegro') return Math.max(3200, Math.round(base * 4.5));
    if (provider === 'ceneo') return Math.max(1800, Math.round(base * 2.5));
    if (provider === 'olx') return Math.max(350, Math.round(base * 0.65));
    return Math.max(700, base);
  }

  async function waitForProviderWindow(provider, signal) {
    const control = providerControl[provider];
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const now = Date.now();
      const wait = Math.max(control?.cooldownUntil || 0, control?.nextRequestAt || 0) - now;
      if (wait <= 0) return;
      await sleep(Math.min(wait, 1000));
    }
  }

  function noteProviderSuccess(provider) {
    const control = providerControl[provider];
    if (!control) return;
    control.successStreak += 1;
    if (control.successStreak >= 12 && control.penalty > 0) {
      control.penalty -= 1;
      control.successStreak = 0;
      scheduler.pump();
    }
  }

  function noteProviderThrottle(provider, status = 0) {
    const control = providerControl[provider];
    if (!control) return;
    control.successStreak = 0;
    control.penalty = Math.min(Math.max(0, configuredProviderLimit(provider) - 1), control.penalty + 1);
    const base = provider === 'allegro' ? 7000 : provider === 'olx' ? 5000 : 3500;
    const statusFactor = status === 429 ? 2 : 1;
    control.cooldownUntil = Math.max(control.cooldownUntil, Date.now() + base * statusFactor * Math.max(1, control.penalty));
    scheduler.pump();
  }

  function makeProtectionError(provider, url, status = 0) {
    const error = new Error(
      status
        ? `Serwis ${providerLabel(provider)} zablokował automatyczne żądania (HTTP ${status}). Wstrzymuję ten serwis, żeby nie przedłużać blokady.`
        : `Serwis ${providerLabel(provider)} zwrócił stronę ochronną. Wstrzymuję ten serwis, żeby nie przedłużać blokady.`,
    );
    error.code = 'PROTECTION_PAGE';
    error.provider = provider;
    error.url = url;
    error.status = status;
    return error;
  }

  function isRetryableError(error) {
    const message = String(error?.message || error || '');
    return /HTTP (403|408|425|429|5\d\d)|stronę ochronną|access denied|robotem|verify|failed to fetch|network|timeout|load failed/i.test(message);
  }

  async function fetchHtml(url, signal, retries = 2) {
    let lastError;
    const provider = detectProvider(url);

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      let release = null;
      try {
        await waitForProviderWindow(provider, signal);
        release = await scheduler.acquire(provider, signal);
        const control = providerControl[provider];
        control.requestCount = (control.requestCount || 0) + 1;
        control.nextRequestAt = Math.max(control.nextRequestAt || 0, Date.now() + providerRequestGap(provider));

        // Dłuższa przerwa co 20 żądań do Allegro. To celowo zmniejsza tempo
        // dużych skanów i redukuje ryzyko kolejnej blokady.
        if (provider === 'allegro' && control.requestCount > 1 && control.requestCount % 20 === 0) {
          control.nextRequestAt = Math.max(control.nextRequestAt, Date.now() + 12000);
        }
        if (provider === 'ceneo' && control.requestCount > 1 && control.requestCount % 25 === 0) {
          control.nextRequestAt = Math.max(control.nextRequestAt, Date.now() + 8000);
        }

        let html;
        if (provider === 'ceneo') {
          // Ceneo wykonujemy w pojedynczej, normalnej karcie Chrome. Dzięki temu
          // działa JavaScript strony oraz ta sama sesja/cookies co przy ręcznym
          // przeglądaniu. Nadal respektujemy stronę ochronną i natychmiast stopujemy.
          html = await fetchCeneoViaBrowserTab(url, signal);
          if (release) { release(); release = null; }
        } else {
          const response = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            redirect: 'follow',
            signal,
            headers: {
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.7',
            },
          });

          if (response.status === 403 || response.status === 429) {
            noteProviderThrottle(provider, response.status);
            if (release) { release(); release = null; }
            throw makeProtectionError(provider, url, response.status);
          }

          if (response.status >= 500) {
            noteProviderThrottle(provider, response.status);
            const retryAfter = Number.parseInt(response.headers.get('Retry-After') || '0', 10);
            lastError = new Error(`HTTP ${response.status} dla ${url}`);
            if (release) { release(); release = null; }
            if (attempt < retries) {
              const fallbackWait = provider === 'olx'
                ? Math.min(15000, 1800 * (attempt + 1))
                : Math.min(15000, 2000 * (attempt + 1));
              await sleep(retryAfter > 0 ? retryAfter * 1000 : fallbackWait);
              continue;
            }
            throw lastError;
          }

          if (!response.ok) throw new Error(`HTTP ${response.status} dla ${url}`);
          html = await response.text();
          if (release) { release(); release = null; }
        }

        if (/nietypow(?:y|a) ruch|access denied|potwierdź.{0,80}robotem|verify.{0,80}human|sprawdź.{0,80}człowiekiem|captcha|zostałeś zablokowany/i.test(html) && html.length < 250000) {
          noteProviderThrottle(provider, 429);
          throw makeProtectionError(provider, url, 0);
        }

        noteProviderSuccess(provider);
        return html;
      } catch (error) {
        if (release) release();
        lastError = error;
        if (error?.name === 'AbortError') throw error;
        if (error?.code === 'PROTECTION_PAGE') throw error;
        if (attempt < retries && isRetryableError(error)) {
          const wait = provider === 'allegro' ? 1800 * (attempt + 1) : provider === 'olx' ? 1200 * (attempt + 1) : 800 * (attempt + 1);
          await sleep(wait);
          continue;
        }
        break;
      }
    }

    throw lastError || new Error(`Nie udało się pobrać ${url}`);
  }

  // Allegro
  function getAllegroOfferId(rawUrl, bodyText = '') {
    try {
      const url = new URL(rawUrl);
      const fromQuery = url.searchParams.get('offerId');
      if (fromQuery && /^\d{7,}$/.test(fromQuery)) return fromQuery;

      const fromPath = url.pathname.match(/-(\d{7,})(?:$|\/)/);
      if (fromPath) return fromPath[1];
    } catch {
      // no-op
    }

    const fromBody = String(bodyText).match(/Numer oferty\s*:?\s*(\d{7,})/i);
    return fromBody?.[1] || null;
  }

  function isAllegroOfferUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (!(url.hostname === 'allegro.pl' || url.hostname.endsWith('.allegro.pl'))) return false;
      if (url.pathname.includes('/oferta/')) return true;
      return url.pathname.includes('/produkt/') && url.searchParams.has('offerId');
    } catch {
      return false;
    }
  }

  function normalizeAllegroOfferUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      url.hash = '';
      const offerId = getAllegroOfferId(url.href);
      if (offerId) url.search = `?offerId=${encodeURIComponent(offerId)}`;
      return url.href;
    } catch {
      return rawUrl;
    }
  }

  function inferAllegroComparisonUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (!(url.hostname === 'allegro.pl' || url.hostname.endsWith('.allegro.pl'))) return null;
      if (!url.pathname.startsWith('/produkt/')) return null;
      url.pathname = url.pathname.replace(/^\/produkt\//, '/oferty-produktu/');
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }

  function allegroPageUrl(sourceUrl, page) {
    const url = new URL(sourceUrl);
    if (page <= 1) url.searchParams.delete('p');
    else url.searchParams.set('p', String(page));
    return url.href;
  }

  function parseAllegroDeclaredCount(doc) {
    // Allegro od 2024 r. pokazuje na głównym listingu liczbę OFERT, ale same
    // wyniki są grupowane w PRODUKTY. Szukamy najpierw samodzielnego elementu
    // tekstowego typu "587 ofert". Dzięki temu nie mylimy licznika z filtrami
    // typu "4TB (120) ofert" ani z przyciskiem "zobacz 18 ofert".
    const exact = [];
    for (const el of doc.querySelectorAll('main *, body *')) {
      if (el.children.length > 0) continue;
      const text = singleLine(el.textContent || '');
      const match = text.match(/^([\d\s]+)\s+ofert(?:a|y)?$/i);
      if (!match) continue;
      const count = Number.parseInt(match[1].replace(/\s/g, ''), 10);
      if (Number.isFinite(count) && count > 0 && count < 1000000) exact.push(count);
    }
    if (exact.length) return exact[0];

    const candidates = [];
    for (const heading of doc.querySelectorAll('h1, [role="heading"][aria-level="1"]')) {
      const own = singleLine(heading.textContent || '');
      const parent = singleLine(heading.parentElement?.textContent || '').slice(0, 1600);
      const grandParent = singleLine(heading.parentElement?.parentElement?.textContent || '').slice(0, 2200);
      candidates.push(own, parent, grandParent);
    }
    candidates.push(singleLine(doc.body?.textContent || '').slice(0, 5000));

    for (const value of candidates) {
      const matches = [...String(value).matchAll(/([\d\s]+)\s+ofert(?:a|y)?\b/gi)]
        .map((match) => Number.parseInt(match[1].replace(/\s/g, ''), 10))
        .filter((count) => Number.isFinite(count) && count > 0 && count < 1000000);
      if (matches.length) return Math.max(...matches);
    }

    return null;
  }

  function parsePlnAmount(value) {
    const match = String(value || '').match(/(\d[\d\s]*[,.]\d{2}|\d[\d\s]*)\s*zł/i);
    if (!match) return null;
    const normalized = match[1].replace(/\s/g, '').replace(',', '.');
    const amount = Number.parseFloat(normalized);
    return Number.isFinite(amount) ? amount : null;
  }

  function extractAllegroCardMetadata(anchor) {
    let node = anchor;
    let bestText = singleLine(anchor.textContent || '');

    for (let depth = 0; depth < 8 && node; depth += 1) {
      const text = singleLine(node.textContent || '');
      if (text.length >= bestText.length && text.length <= 6000) bestText = text;
      if (/\d[\d\s]*[,.]\d{2}\s*zł/i.test(text) && /\bStan\b/i.test(text)) {
        bestText = text;
        break;
      }
      node = node.parentElement;
    }

    const conditionMatch = bestText.match(/\bStan\s*[:\-]?\s*(Nowy|Nowe|Używany|Używane|Powystawowy|Powystawowe|Po zwrocie|Odnowiony(?: przez (?:producenta|sprzedawcę))?|Uszkodzony|Uszkodzone|Jak nowy|Jak nowe)\b/i);
    return {
      listingPrice: (() => {
        const amount = parsePlnAmount(bestText);
        return amount === null ? '' : `${amount.toFixed(2)} zł`;
      })(),
      listingPriceAmount: parsePlnAmount(bestText),
      listingCondition: conditionMatch ? singleLine(conditionMatch[1]) : '',
    };
  }

  function allegroSourceFilters(sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      const priceToRaw = (url.searchParams.get('price_to') || '').replace(',', '.');
      const priceFromRaw = (url.searchParams.get('price_from') || '').replace(',', '.');
      const priceTo = Number.parseFloat(priceToRaw);
      const priceFrom = Number.parseFloat(priceFromRaw);
      const states = url.searchParams.getAll('stan').map((value) => value.toLowerCase());
      const stateGroups = url.searchParams.getAll('stan-grupa').map((value) => value.toLowerCase());
      return {
        priceTo: Number.isFinite(priceTo) ? priceTo : null,
        priceFrom: Number.isFinite(priceFrom) ? priceFrom : null,
        states,
        stateGroups,
      };
    } catch {
      return { priceTo: null, priceFrom: null, states: [], stateGroups: [] };
    }
  }

  function matchesAllegroSourceFilters(offer, filters) {
    const price = offer.listingPriceAmount;
    if (Number.isFinite(price)) {
      if (filters.priceTo !== null && price > filters.priceTo + 0.001) return false;
      if (filters.priceFrom !== null && price < filters.priceFrom - 0.001) return false;
    }

    const condition = String(offer.listingCondition || '').toLowerCase();
    if (!condition) return true;

    const wantsNew = filters.states.some((value) => value === 'nowe' || value === 'nowy');
    const wantsUsed = filters.states.some((value) => value.includes('używ') || value.includes('uzyw'));
    const wantsDamaged = filters.states.some((value) => value.includes('uszkodz'));
    const wantsLikeNew = filters.stateGroups.some((value) => value.includes('jak nowe') || value.includes('jak+nowe'));

    if (!wantsNew && !wantsUsed && !wantsDamaged && !wantsLikeNew) return true;

    if (wantsNew && /^now/.test(condition)) return true;
    if (wantsUsed && /używ|uzyw/.test(condition)) return true;
    if (wantsDamaged && /uszkodz/.test(condition)) return true;
    if (wantsLikeNew && /powystaw|po zwrocie|jak now/.test(condition)) return true;
    return false;
  }

  function parseAllegroListing(html, baseUrl) {
    const doc = parseDocument(html);
    const map = new Map();

    for (const anchor of doc.querySelectorAll('a[href]')) {
      const href = absoluteUrl(anchor.getAttribute('href'), baseUrl);
      if (!href || !isAllegroOfferUrl(href)) continue;

      const offerId = getAllegroOfferId(href);
      const key = offerId || normalizeAllegroOfferUrl(href);
      if (!map.has(key)) {
        const meta = extractAllegroCardMetadata(anchor);
        map.set(key, {
          provider: 'allegro',
          url: normalizeAllegroOfferUrl(href),
          itemId: offerId,
          listingTitle: singleLine(anchor.textContent),
          ...meta,
        });
      }
    }

    const declaredCount = parseAllegroDeclaredCount(doc);

    // To jest wyłącznie podpowiedź widocznej paginacji, nie liczba wszystkich stron.
    // Allegro pokazuje tylko fragment numerów stron wokół bieżącej strony.
    const pageNumbers = [];
    for (const anchor of doc.querySelectorAll('a[href]')) {
      const href = absoluteUrl(anchor.getAttribute('href'), baseUrl);
      if (!href || detectProvider(href) !== 'allegro') continue;
      try {
        const value = Number.parseInt(new URL(href).searchParams.get('p') || '', 10);
        if (Number.isFinite(value) && value >= 1 && value <= MAX_LISTING_PAGES) pageNumbers.push(value);
      } catch {
        // no-op
      }
    }

    // Rozwijamy wyłącznie produkty, które faktycznie trafiły do mapy głównego
    // listingu. Wcześniejsze skanowanie wszystkich linków /oferty-produktu/
    // łapało też rekomendacje i moduły poboczne, przez co 147 kart potrafiło
    // zamienić się w ponad 300 grup i setki zbędnych requestów.
    const comparisonUrls = [];
    for (const offer of map.values()) {
      const inferred = inferAllegroComparisonUrl(offer.url);
      if (inferred) comparisonUrls.push(inferred);
    }

    return {
      offers: [...map.values()],
      comparisonUrls: [...new Set(comparisonUrls)],
      declaredCount,
      totalPages: pageNumbers.length ? Math.max(...pageNumbers) : null,
    };
  }

  function parseAllegroProductOffersPage(html, baseUrl) {
    const doc = parseDocument(html);
    const pageText = cleanText(doc.body?.textContent || '');
    const countMatch = pageText.match(/([\d\s]+)\s+ofert(?:a|y)?\s+tego\s+produktu/i);
    const declaredCount = countMatch
      ? Number.parseInt(countMatch[1].replace(/\s/g, ''), 10)
      : null;

    const map = new Map();
    for (const anchor of doc.querySelectorAll('a[href]')) {
      const href = absoluteUrl(anchor.getAttribute('href'), baseUrl);
      if (!href || !isAllegroOfferUrl(href)) continue;
      const offerId = getAllegroOfferId(href);
      if (!offerId) continue;
      const key = String(offerId);
      if (!map.has(key)) {
        const meta = extractAllegroCardMetadata(anchor);
        map.set(key, {
          provider: 'allegro',
          url: normalizeAllegroOfferUrl(href),
          itemId: offerId,
          listingTitle: singleLine(anchor.textContent),
          ...meta,
        });
      }
      if (declaredCount && map.size >= declaredCount) break;
    }

    let totalPages = null;
    for (const anchor of doc.querySelectorAll('a[href]')) {
      const href = absoluteUrl(anchor.getAttribute('href'), baseUrl);
      if (!href) continue;
      try {
        const url = new URL(href);
        if (!url.pathname.startsWith('/oferty-produktu/')) continue;
        const page = Number.parseInt(url.searchParams.get('p') || '', 10);
        if (Number.isFinite(page) && page >= 2 && page <= 100) {
          totalPages = Math.max(totalPages || 0, page);
        }
      } catch {
        // no-op
      }
    }

    return { offers: [...map.values()], declaredCount, totalPages };
  }

  function allegroProductOffersPageUrl(baseUrl, page) {
    const url = new URL(baseUrl);
    if (page <= 1) url.searchParams.delete('p');
    else url.searchParams.set('p', String(page));
    return url.href;
  }

  function extractAllegroPrice(doc, productLd, pageText) {
    const ldOffer = Array.isArray(productLd?.offers) ? productLd.offers[0] : productLd?.offers;
    const ldPrice = ldOffer?.price;
    const ldCurrency = ldOffer?.priceCurrency;
    if (ldPrice !== undefined && ldPrice !== null) {
      return `${ldPrice}${ldCurrency === 'PLN' ? ' zł' : ldCurrency ? ` ${ldCurrency}` : ''}`;
    }

    const metaPrice = getMeta(doc, 'meta[property="product:price:amount"]');
    const metaCurrency = getMeta(doc, 'meta[property="product:price:currency"]');
    if (metaPrice) return `${metaPrice}${metaCurrency === 'PLN' ? ' zł' : metaCurrency ? ` ${metaCurrency}` : ''}`;

    const match = pageText.match(/(?:^|\n)cena\s+([\d\s,.]+\s*zł)/i)
      || pageText.match(/([\d\s,.]+\s*zł)(?:\s|\n)+(?:dostawa|KUP|do koszyka)/i);
    return match ? singleLine(match[1]) : '';
  }

  function extractAllegroSeller(doc, productLd, pageText) {
    const offer = Array.isArray(productLd?.offers) ? productLd.offers[0] : productLd?.offers;
    const ldSeller = offer?.seller?.name || productLd?.seller?.name;
    if (ldSeller) return singleLine(ldSeller);

    const section = extractSection(doc, 'Informacje o sprzedającym', ['Inni klienci oglądali również', 'Zamów w jednej przesyłce']);
    const lines = section.split('\n').map(singleLine).filter(Boolean);
    const ignored = /^(sprzedaż i wysyłka|firma|poleca|wszystkie przedmioty|inne przedmioty|zadaj pytanie)/i;
    const seller = lines.find((line) => !ignored.test(line) && line.length <= 80);
    if (seller) return seller.replace(/\s+Firma.*$/i, '').trim();

    const match = pageText.match(/od\s+([^\n]{2,80})\n\s*Firma/i);
    return match ? singleLine(match[1]) : '';
  }

  function extractAllegroSellerRating(doc, pageText) {
    const section = extractSection(doc, 'Informacje o sprzedającym', ['Inni klienci oglądali również', 'Zamów w jednej przesyłce']);
    const match = `${section}\n${pageText}`.match(/poleca\s*([\d,.]+%)/i);
    return match ? match[1].replace(',', '.') : '';
  }

  function extractAllegroShipping(pageText) {
    const candidates = [
      /dostawa\s+od\s+([\d\s,.]+\s*zł)/i,
      /Przewidywana dostawa[\s\S]{0,180}?([\d\s,.]+\s*zł)/i,
    ];
    for (const regex of candidates) {
      const match = pageText.match(regex);
      if (match) return singleLine(match[1]);
    }
    return '';
  }

  function extractAllegroCondition(params, pageText) {
    if (params.Stan) return params.Stan;
    const match = pageText.match(/Stan\s*:?\s*(Nowy|Używany|Odnowiony|Po zwrocie|Nowy z defektem|Niepełny komplet)/i);
    return match ? singleLine(match[1]) : '';
  }

  function parseAllegroOffer(html, listing, mode) {
    const doc = parseDocument(html);
    const productLd = findProductJsonLd(doc);
    const pageText = fragmentToText(doc.body);
    const params = extractKnownParameters(doc);
    const descriptionRaw = extractSection(doc, 'Opis', [
      'Warunki oferty',
      'Opcje zakupu',
      'Informacje o sprzedającym',
      'Odpowiedzialność za produkt',
    ]);

    const offerId = getAllegroOfferId(listing.url, pageText);
    const title = singleLine(
      productLd?.name
      || getMeta(doc, 'meta[property="og:title"]')
      || doc.querySelector('h1')?.textContent
      || doc.title,
    ).replace(/\s*[|•].*?Allegro.*$/i, '');
    const description = mode === 'full' ? descriptionRaw : truncate(descriptionRaw, 1200);
    const parametersText = extractSection(doc, 'Parametry', ['Opis']);

    return {
      provider: 'allegro',
      itemId: offerId,
      title,
      price: extractAllegroPrice(doc, productLd, pageText),
      condition: extractAllegroCondition(params, pageText),
      seller: extractAllegroSeller(doc, productLd, pageText),
      sellerRating: extractAllegroSellerRating(doc, pageText),
      shipping: extractAllegroShipping(pageText),
      params,
      parametersText: mode === 'full' ? truncate(parametersText, 3500) : truncate(parametersText, 1600),
      description,
      url: listing.url,
    };
  }

  // Ceneo
  function getCeneoProductId(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const match = url.pathname.match(/^\/(\d{5,})\/?$/);
      return match?.[1] || null;
    } catch {
      return null;
    }
  }

  function normalizeCeneoProductUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const productId = getCeneoProductId(url.href);
      if (!productId) return rawUrl;
      return `${url.origin}/${productId}`;
    } catch {
      return rawUrl;
    }
  }

  function getCeneoCurrentPage(sourceUrl) {
    try {
      const pathname = new URL(sourceUrl).pathname;
      const match = pathname.match(/;0020-30-0-0-(\d+)\.htm$/i);
      return match ? Number.parseInt(match[1], 10) + 1 : 1;
    } catch {
      return 1;
    }
  }

  function ceneoPageUrl(sourceUrl, page) {
    const url = new URL(sourceUrl);
    let pathname = url.pathname.replace(/;0020-30-0-0-\d+\.htm$/i, '.htm');

    if (page > 1) {
      const offset = page - 1;
      if (/\.htm$/i.test(pathname)) {
        pathname = pathname.replace(/\.htm$/i, `;0020-30-0-0-${offset}.htm`);
      } else {
        pathname = `${pathname.replace(/\/$/, '')};0020-30-0-0-${offset}.htm`;
      }
    }

    url.pathname = pathname;
    return url.href;
  }

  function findCeneoCard(anchor) {
    let node = anchor;
    for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
      const text = singleLine(node.textContent);
      if (text.length >= 30 && text.length <= 7000) {
        const className = String(node.className || '');
        const hasProductShape = /cat-prod-row|category-list-item|product-list-item/i.test(className)
          || node.hasAttribute?.('data-productid');
        const hasCommerceText = /\d[\d\s]*[,.]\d{2}\s*zł|Porównaj ceny|Idź do sklepu|opini|Pojemność|Cache|Prędkość/i.test(text);
        if (hasProductShape || hasCommerceText) return node;
      }
    }
    return anchor.parentElement;
  }

  function parseCeneoCard(card) {
    const text = singleLine(card?.textContent || '');
    const priceMatch = text.match(/(?:^|\s)(?:od\s*)?(\d[\d\s]*[,.]\d{2}\s*zł)/i);
    const shopsMatch = text.match(/w\s+(\d+)\s+sklep(?:ie|ach)/i);
    const offersMatch = text.match(/w\s+(\d+)\s+ofert(?:ach|cie|a|y)?/i);
    const ratingMatch = text.match(/(?:^|\s)([1-5][,.]\d)\s+(\d+)\s+opini/i);
    const purchasesMatch = text.match(/(\d+\+?)\s+kupionych ostatnio/i);
    const params = {};

    for (const li of card?.querySelectorAll?.('li') || []) {
      const liText = singleLine(li.textContent);
      const match = liText.match(/^([^:]{2,60}):\s*(.+)$/);
      if (match && match[2].length <= 150) params[match[1].trim()] = match[2].trim();
    }

    return {
      listingPrice: priceMatch?.[1] || '',
      shopsCount: shopsMatch ? Number(shopsMatch[1]) : null,
      offersCount: offersMatch ? Number(offersMatch[1]) : null,
      rating: ratingMatch?.[1]?.replace(',', '.') || '',
      reviewCount: ratingMatch ? Number(ratingMatch[2]) : null,
      purchasesRecently: purchasesMatch?.[1] || '',
      listingParams: params,
    };
  }

  function getCeneoPrimaryCards(doc, baseUrl) {
    const selectors = [
      'div.cat-prod-row.js_category-list-item',
      '[class*="cat-prod-row"][class*="js_category-list-item"]',
      '[data-productid][class*="cat-prod-row"]',
      '[data-productid][class*="category-list-item"]',
      '[data-productid][class*="product-list-item"]',
    ];

    const candidates = [];
    const seen = new Set();

    for (const selector of selectors) {
      for (const node of doc.querySelectorAll(selector)) {
        if (seen.has(node)) continue;
        const productId = node.getAttribute?.('data-productid');
        const hasProductLink = [...node.querySelectorAll('a[href]')].some((anchor) => {
          const href = absoluteUrl(anchor.getAttribute('href'), baseUrl);
          return Boolean(href && getCeneoProductId(href));
        });
        if (!productId && !hasProductLink) continue;
        seen.add(node);
        candidates.push(node);
      }
      if (candidates.length >= 5) break;
    }

    // Usuń zagnieżdżone duplikaty, zostawiając najbardziej zewnętrzną kartę.
    return candidates.filter((node, index) => !candidates.some((other, otherIndex) => (
      otherIndex !== index && other.contains(node)
    )));
  }

  function getCeneoProductAnchor(card, baseUrl) {
    const preferred = [
      'strong.cat-prod-row__name a[href]',
      '.cat-prod-row__name a[href]',
      'a.go-to-product[href]',
      'a.js_seoUrl[href]',
    ];

    for (const selector of preferred) {
      const anchor = card.querySelector?.(selector);
      const href = anchor ? absoluteUrl(anchor.getAttribute('href'), baseUrl) : null;
      if (href && getCeneoProductId(href)) return anchor;
    }

    let fallback = null;
    for (const anchor of card.querySelectorAll?.('a[href]') || []) {
      const href = absoluteUrl(anchor.getAttribute('href'), baseUrl);
      if (!href || !getCeneoProductId(href)) continue;
      const anchorText = singleLine(anchor.textContent);
      const fallbackText = singleLine(fallback?.textContent || '');
      if (!fallback || anchorText.length > fallbackText.length) fallback = anchor;
    }
    return fallback;
  }

  function parseCeneoPathFilter(sourceUrl, name) {
    try {
      const pathname = decodeURIComponent(new URL(sourceUrl).pathname);
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = pathname.match(new RegExp(`(?:^|/)${escaped}:([^/;]+?)(?:\\.htm|/|$)`, 'i'));
      if (!match) return [];
      return match[1].split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
    } catch {
      return [];
    }
  }

  function extractCapacityTokens(value) {
    return [...String(value || '').matchAll(/\b(\d+(?:[.,]\d+)?)\s*(TB|GB)\b/gi)]
      .map((match) => `${match[1].replace(',', '.')}${match[2].toUpperCase()}`.toUpperCase());
  }

  function normalizeInterfaceToken(value) {
    const compact = String(value || '').toUpperCase().replace(/\s+/g, '');
    if (/SAS/.test(compact)) return 'SAS';
    if (/SATA/.test(compact)) {
      return /SATA(?:III|3)|6GB\/?S/.test(compact) ? 'SATA3' : 'SATA';
    }
    if (/(?:^|[^S])ATA/.test(compact)) return 'ATA';
    return '';
  }

  function ceneoFallbackMatchesActiveFilters(baseUrl, title, cardData, cardText) {
    try {
      const pathname = decodeURIComponent(new URL(baseUrl).pathname);
      if (/\/Dyski_HDD\//i.test(pathname)) {
        const obviousNonHdd = `${title || ''} ${cardText || ''}`;
        if (/\bSSD\b|\bNVMe\b|\bM\.2\b|PCIe\s*(?:Gen\s*)?\d/i.test(obviousNonHdd)) return false;
      }
    } catch {
      // no-op
    }

    const allowedCapacities = parseCeneoPathFilter(baseUrl, 'Pojemnosc')
      .map((value) => value.replace(',', '.').toUpperCase());

    if (allowedCapacities.length) {
      const strongCapacitySource = [
        cardData?.listingParams?.Pojemność,
        cardData?.listingParams?.Pojemnosc,
        title,
      ].filter(Boolean).join(' ');
      const capacities = extractCapacityTokens(strongCapacitySource);
      if (capacities.length && !capacities.some((value) => allowedCapacities.includes(value))) return false;

      // Jeśli tytuł/parametr nie mówi o pojemności, użyj całej karty jako słabszego fallbacku.
      if (!capacities.length) {
        const cardCapacities = extractCapacityTokens(cardText);
        if (cardCapacities.length && !cardCapacities.some((value) => allowedCapacities.includes(value))) return false;
      }
    }

    const allowedInterfaces = parseCeneoPathFilter(baseUrl, 'Interfejs')
      .map(normalizeInterfaceToken)
      .filter(Boolean);

    if (allowedInterfaces.length) {
      const interfaceSource = [
        cardData?.listingParams?.Interfejs,
        title,
      ].filter(Boolean).join(' ');
      const detected = normalizeInterfaceToken(interfaceSource);
      if (detected && !allowedInterfaces.includes(detected)) return false;
    }

    return true;
  }

  function addCeneoListingCandidate(map, anchor, card, baseUrl, strictCard = false) {
    const href = absoluteUrl(anchor?.getAttribute?.('href'), baseUrl);
    if (!href || detectProvider(href) !== 'ceneo') return;

    const productId = getCeneoProductId(href);
    if (!productId) return;

    const anchorText = singleLine(anchor.textContent);
    const cardText = singleLine(card?.textContent || '');
    const generic = /^(warianty|porównaj ceny|idź do sklepu|napisz opinię|\d+[,.]\d{2}\s*zł|od\s*\d)/i.test(anchorText);
    const cardData = parseCeneoCard(card);

    // W głównej liście nie wymagamy ceny. Filtry z aktywnego URL stosujemy jednak
    // zawsze, także dla głównych kart, żeby nie łapać SSD/M.2 i rekomendacji spoza
    // aktywnego filtrowania.
    if (!strictCard && !cardData.listingPrice) return;
    if (!ceneoFallbackMatchesActiveFilters(baseUrl, anchorText, cardData, cardText)) return;

    const existing = map.get(productId);
    if (!existing) {
      map.set(productId, {
        provider: 'ceneo',
        url: normalizeCeneoProductUrl(href),
        itemId: productId,
        listingTitle: generic ? '' : anchorText,
        ...cardData,
      });
      return;
    }

    if (!generic && anchorText.length > (existing.listingTitle || '').length) existing.listingTitle = anchorText;
    if (!existing.listingPrice && cardData.listingPrice) existing.listingPrice = cardData.listingPrice;
    if (!existing.shopsCount && cardData.shopsCount) existing.shopsCount = cardData.shopsCount;
    if (!existing.offersCount && cardData.offersCount) existing.offersCount = cardData.offersCount;
    if (!existing.rating && cardData.rating) existing.rating = cardData.rating;
    if (!existing.reviewCount && cardData.reviewCount) existing.reviewCount = cardData.reviewCount;
    existing.listingParams = { ...(existing.listingParams || {}), ...(cardData.listingParams || {}) };
  }

  function parseCeneoListing(html, baseUrl) {
    const doc = parseDocument(html);
    const map = new Map();
    const primaryCards = getCeneoPrimaryCards(doc, baseUrl);

    if (primaryCards.length >= 3) {
      for (const card of primaryCards) {
        const anchor = getCeneoProductAnchor(card, baseUrl);
        if (anchor) addCeneoListingCandidate(map, anchor, card, baseUrl, true);
      }
    } else {
      // Fallback dla przyszłej zmiany HTML. Aktywne filtry z URL odrzucają
      // rekomendacje, które nie pasują np. do 2TB/4TB albo SATA.
      for (const anchor of doc.querySelectorAll('a[href]')) {
        const href = absoluteUrl(anchor.getAttribute('href'), baseUrl);
        if (!href || detectProvider(href) !== 'ceneo' || !getCeneoProductId(href)) continue;
        addCeneoListingCandidate(map, anchor, findCeneoCard(anchor), baseUrl, false);
      }
    }

    const bodyText = singleLine(doc.body?.textContent || '');
    const h1 = singleLine(doc.querySelector('h1')?.textContent || '');
    const h1Index = h1 ? bodyText.indexOf(h1) : -1;
    const headSlice = h1Index >= 0 ? bodyText.slice(h1Index, h1Index + 700) : bodyText.slice(0, 1800);
    const countMatch = headSlice.match(/\(([\d\s]+)\)/);
    const declaredCount = countMatch ? Number.parseInt(countMatch[1].replace(/\s/g, ''), 10) : null;

    let totalPages = null;

    // Ceneo koduje numer strony w URL jako ...;0020-30-0-0-N.htm.
    for (const anchor of doc.querySelectorAll('a[href]')) {
      const href = absoluteUrl(anchor.getAttribute('href'), baseUrl);
      if (!href || detectProvider(href) !== 'ceneo') continue;
      try {
        const pathname = new URL(href).pathname;
        const match = pathname.match(/;0020-30-0-0-(\d+)\.htm$/i);
        if (match) {
          const page = Number.parseInt(match[1], 10) + 1;
          if (page >= 2 && page <= MAX_LISTING_PAGES) totalPages = Math.max(totalPages || 0, page);
        }
      } catch {
        // no-op
      }
    }

    if (!totalPages) {
      const explicitPageTotalMatches = [...bodyText.matchAll(/\bz\s+(\d{1,3})\b/g)];
      for (const match of explicitPageTotalMatches) {
        const total = Number.parseInt(match[1], 10);
        if (total >= 2 && total <= MAX_LISTING_PAGES) totalPages = Math.max(totalPages || 0, total);
      }
    }

    return {
      offers: [...map.values()].filter((item) => item.listingTitle || item.listingPrice || item.itemId),
      declaredCount: Number.isFinite(declaredCount) ? declaredCount : null,
      totalPages,
    };
  }

  function extractCeneoPrice(productLd, listing, pageText) {
    if (listing.listingPrice) return listing.listingPrice;

    const offers = productLd?.offers;
    const offer = Array.isArray(offers) ? offers[0] : offers;
    const value = offer?.lowPrice ?? offer?.price;
    const currency = offer?.priceCurrency;
    if (value !== undefined && value !== null) {
      return `${value}${currency === 'PLN' ? ' zł' : currency ? ` ${currency}` : ''}`;
    }

    const top = pageText.slice(0, 2500);
    const match = top.match(/(?:^|\n)(\d[\d\s]*[,.]\d{2}\s*zł)(?:\n|$)/i);
    return match ? singleLine(match[1]) : '';
  }

  function extractCeneoRating(productLd, listing, pageText) {
    const aggregate = productLd?.aggregateRating || {};
    const rating = aggregate.ratingValue || listing.rating || '';
    const reviewCount = aggregate.reviewCount || aggregate.ratingCount || listing.reviewCount || null;
    if (rating || reviewCount) {
      return {
        rating: rating ? String(rating).replace(',', '.') : '',
        reviewCount: reviewCount ? Number(reviewCount) : null,
      };
    }

    const top = pageText.slice(0, 3000);
    const match = top.match(/(?:^|\n)([1-5][,.]\d)\s*\n\s*(\d+)\s+opini/i);
    return {
      rating: match?.[1]?.replace(',', '.') || '',
      reviewCount: match ? Number(match[2]) : null,
    };
  }

  function extractCeneoDescription(doc, mode) {
    let description = extractSectionByMatcher(
      doc,
      (text) => /opis i dane produktu/i.test(text),
      [(text) => /- opinie$|opinie i recenzje|opinie$/i.test(text)],
    );

    if (!description) {
      const meta = getMeta(doc, 'meta[name="description"]');
      description = meta;
    }

    return mode === 'full' ? description : truncate(description, 1400);
  }

  function parseCeneoOffer(html, listing, mode) {
    const doc = parseDocument(html);
    const productLd = findProductJsonLd(doc);
    const pageText = fragmentToText(doc.body);
    const tableParams = extractAllTableParameters(doc);
    const knownParams = extractKnownParameters(doc);
    const params = {
      ...(listing.listingParams || {}),
      ...tableParams,
      ...knownParams,
    };
    const ratingData = extractCeneoRating(productLd, listing, pageText);
    const top = pageText.slice(0, 6000);
    const offersCountMatch = top.match(/Oferty\s*\((\d+)\)/i);

    const title = singleLine(
      productLd?.name
      || doc.querySelector('h1')?.textContent
      || getMeta(doc, 'meta[property="og:title"]')
      || listing.listingTitle
      || doc.title,
    ).replace(/\s*[-|]\s*Opinie i ceny na Ceneo\.pl.*$/i, '');

    let summary = '';
    const h1 = doc.querySelector('h1');
    if (h1) {
      let node = h1.nextElementSibling;
      for (let i = 0; node && i < 5; i += 1, node = node.nextElementSibling) {
        const text = singleLine(node.textContent);
        if (text.length >= 20 && text.length <= 500 && !/opini|zł|kupionych/i.test(text)) {
          summary = text;
          break;
        }
      }
    }

    return {
      provider: 'ceneo',
      itemId: listing.itemId || getCeneoProductId(listing.url),
      title,
      price: extractCeneoPrice(productLd, listing, pageText),
      rating: ratingData.rating,
      reviewCount: ratingData.reviewCount,
      shopsCount: listing.shopsCount || null,
      offersCount: listing.offersCount || (offersCountMatch ? Number(offersCountMatch[1]) : null),
      purchasesRecently: listing.purchasesRecently || '',
      params,
      parametersText: '',
      summary,
      description: extractCeneoDescription(doc, mode),
      url: listing.url,
    };
  }


  // OLX
  function getOlxAdId(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const match = url.pathname.match(/-ID([A-Za-z0-9]+)\.html(?:$|\/)/i);
      if (match) return `ID${match[1]}`;
      const alt = url.pathname.match(/\/d\/oferta\/[^/?#]+-([A-Za-z0-9]{6,})\.html/i);
      return alt?.[1] || null;
    } catch {
      return null;
    }
  }

  function isOlxAdUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (!(url.hostname === 'olx.pl' || url.hostname.endsWith('.olx.pl'))) return false;
      return /\/d\/oferta\//i.test(url.pathname) && /\.html$/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  function normalizeOlxAdUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      url.hash = '';
      url.search = '';
      return url.href;
    } catch {
      return rawUrl;
    }
  }

  function olxPageUrl(sourceUrl, page) {
    const url = new URL(sourceUrl);
    if (page <= 1) url.searchParams.delete('page');
    else url.searchParams.set('page', String(page));
    return url.href;
  }

  function getOlxCurrentPage(sourceUrl) {
    try {
      return Math.max(1, Number.parseInt(new URL(sourceUrl).searchParams.get('page') || '1', 10) || 1);
    } catch {
      return 1;
    }
  }

  function getOlxPrimaryCards(doc) {
    const selectors = [
      '[data-cy="l-card"]',
      '[data-testid="l-card"]',
      'div[data-cy*="l-card"]',
      'article[data-cy*="l-card"]',
    ];
    const out = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const card of doc.querySelectorAll(selector)) {
        if (seen.has(card)) continue;
        const hasAd = [...card.querySelectorAll('a[href]')].some((a) => {
          const href = absoluteUrl(a.getAttribute('href'), location.origin);
          return Boolean(href && isOlxAdUrl(href));
        });
        if (!hasAd) continue;
        seen.add(card);
        out.push(card);
      }
      if (out.length >= 3) break;
    }
    return out.filter((node, index) => !out.some((other, i) => i !== index && other.contains(node)));
  }

  function findOlxCard(anchor) {
    let node = anchor;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      const cy = String(node.getAttribute?.('data-cy') || '');
      const testid = String(node.getAttribute?.('data-testid') || '');
      if (/l-card/i.test(cy) || /l-card/i.test(testid)) return node;
      const text = singleLine(node.textContent || '');
      if (text.length >= 20 && text.length <= 2200 && /\d[\d\s]*\s*zł/i.test(text)) return node;
    }
    return anchor.parentElement;
  }

  function getOlxAdAnchor(card, baseUrl) {
    let best = null;
    for (const anchor of card?.querySelectorAll?.('a[href]') || []) {
      const href = absoluteUrl(anchor.getAttribute('href'), baseUrl);
      if (!href || !isOlxAdUrl(href)) continue;
      const text = singleLine(anchor.textContent || '');
      if (!best || text.length > singleLine(best.textContent || '').length) best = anchor;
    }
    return best;
  }

  function parseOlxListingCard(card, anchor) {
    const text = singleLine(card?.textContent || '');
    const title = singleLine(anchor?.textContent || '');
    const priceMatch = text.match(/(\d[\d\s]*(?:[,.]\d{1,2})?\s*zł(?:\s+do negocjacji)?)/i);
    const conditionMatch = text.match(/\b(Nowe|Używane|Uszkodzone)\b/i);
    const dateMatch = text.match(/(?:Odświeżono\s+)?(?:dzisiaj|wczoraj|dnia\s+\d{1,2}\s+[a-ząćęłńóśźż]+\s+\d{4}|\d{1,2}\s+[a-ząćęłńóśźż]+\s+\d{4}|Dzisiaj\s+o\s+\d{1,2}:\d{2})/i);
    return {
      listingTitle: title,
      listingPrice: priceMatch?.[1] || '',
      listingCondition: conditionMatch?.[1] || '',
      listingDate: dateMatch?.[0] || '',
    };
  }

  function parseOlxDeclaredCount(doc) {
    const text = singleLine(doc.body?.textContent || '').slice(0, 7000);
    const match = text.match(/Znaleźliśmy\s+(?:ponad\s+)?([\d\s]+)\s+ogłosze(?:ń|nia)/i)
      || text.match(/([\d\s]+)\s+ogłosze(?:ń|nia)/i);
    if (!match) return null;
    const value = Number.parseInt(match[1].replace(/\s/g, ''), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function parseOlxListing(html, baseUrl) {
    const doc = parseDocument(html);
    const map = new Map();
    const cards = getOlxPrimaryCards(doc);

    const add = (anchor, card) => {
      const href = absoluteUrl(anchor?.getAttribute?.('href'), baseUrl);
      if (!href || !isOlxAdUrl(href)) return;
      const itemId = getOlxAdId(href) || normalizeOlxAdUrl(href);
      if (map.has(itemId)) return;
      const cardData = parseOlxListingCard(card, anchor);
      map.set(itemId, {
        provider: 'olx',
        itemId,
        url: normalizeOlxAdUrl(href),
        ...cardData,
      });
    };

    if (cards.length >= 3) {
      for (const card of cards) {
        const anchor = getOlxAdAnchor(card, baseUrl);
        if (anchor) add(anchor, card);
      }
    } else {
      // Fallback: link do ogłoszenia musi mieć w bliskim kontenerze cenę.
      for (const anchor of doc.querySelectorAll('a[href]')) {
        const href = absoluteUrl(anchor.getAttribute('href'), baseUrl);
        if (!href || !isOlxAdUrl(href)) continue;
        const card = findOlxCard(anchor);
        const cardText = singleLine(card?.textContent || '');
        if (!/\d[\d\s]*(?:[,.]\d{1,2})?\s*zł/i.test(cardText)) continue;
        add(anchor, card);
      }
    }

    let totalPages = null;
    for (const anchor of doc.querySelectorAll('a[href]')) {
      const href = absoluteUrl(anchor.getAttribute('href'), baseUrl);
      if (!href || detectProvider(href) !== 'olx') continue;
      try {
        const page = Number.parseInt(new URL(href).searchParams.get('page') || '', 10);
        if (Number.isFinite(page) && page >= 2 && page <= MAX_LISTING_PAGES) totalPages = Math.max(totalPages || 0, page);
      } catch {
        // no-op
      }
    }

    return {
      offers: [...map.values()],
      declaredCount: parseOlxDeclaredCount(doc),
      totalPages,
    };
  }

  function extractOlxPrice(doc, productLd, listing, pageText) {
    const offer = Array.isArray(productLd?.offers) ? productLd.offers[0] : productLd?.offers;
    if (offer?.price !== undefined && offer?.price !== null) {
      return `${offer.price}${offer.priceCurrency === 'PLN' ? ' zł' : offer.priceCurrency ? ` ${offer.priceCurrency}` : ''}`;
    }
    const metaPrice = getMeta(doc, 'meta[property="product:price:amount"]');
    if (metaPrice) return `${metaPrice} zł`;
    if (listing.listingPrice) return listing.listingPrice;
    const top = pageText.slice(0, 3500);
    const match = top.match(/(?:^|\n)(\d[\d\s]*(?:[,.]\d{1,2})?\s*zł(?:\s+do negocjacji)?)(?:\n|$)/i);
    return match ? singleLine(match[1]) : '';
  }

  function extractOlxLocation(productLd, pageText) {
    const address = productLd?.offers?.availableAtOrFrom?.address || productLd?.availableAtOrFrom?.address;
    if (address && typeof address === 'object') {
      const value = [address.addressLocality, address.addressRegion].filter(Boolean).join(', ');
      if (value) return singleLine(value);
    }
    const match = pageText.match(/(?:^|\n)Lokalizacja\n([^\n]{2,120})/i);
    return match ? singleLine(match[1]) : '';
  }

  function parseOlxOffer(html, listing, mode) {
    const doc = parseDocument(html);
    const productLd = findProductJsonLd(doc);
    const pageText = fragmentToText(doc.body);
    const params = { ...(listing.listingParams || {}), ...extractKnownParameters(doc), ...extractAllTableParameters(doc) };
    const descriptionRaw = extractSectionByMatcher(
      doc,
      (text) => /^opis$/i.test(text),
      [
        (text) => /o sprzedającym|użytkownik|lokalizacja|zwroty|pakiet ochronny|podobne ogłoszenia|inne ogłoszenia/i.test(text),
      ],
    );
    const title = singleLine(
      productLd?.name
      || getMeta(doc, 'meta[property="og:title"]')
      || doc.querySelector('h1')?.textContent
      || listing.listingTitle
      || doc.title,
    ).replace(/\s*[|•]\s*OLX\.pl.*$/i, '');
    const numericId = pageText.match(/(?:^|\n)ID:\s*(\d{5,})\b/i)?.[1] || '';
    const sellerType = pageText.match(/(?:^|\n)(Prywatne|Firmowe)(?:\n|$)/i)?.[1] || '';
    const dateAdded = pageText.match(/(?:^|\n)(Dodane\s+[^\n]{2,80}|Odświeżono(?: dnia)?\s+[^\n]{2,80})(?:\n|$)/i)?.[1] || listing.listingDate || '';
    const offer = Array.isArray(productLd?.offers) ? productLd.offers[0] : productLd?.offers;
    const sellerName = singleLine(offer?.seller?.name || productLd?.seller?.name || '');

    return {
      provider: 'olx',
      itemId: listing.itemId || getOlxAdId(listing.url),
      numericId,
      title,
      price: extractOlxPrice(doc, productLd, listing, pageText),
      condition: params.Stan || listing.listingCondition || '',
      sellerType,
      seller: sellerName,
      location: extractOlxLocation(productLd, pageText),
      dateAdded: singleLine(dateAdded),
      params,
      parametersText: '',
      description: mode === 'full' ? descriptionRaw : truncate(descriptionRaw, 1600),
      url: listing.url,
    };
  }

  function listingPageUrl(provider, sourceUrl, page) {
    if (provider === 'ceneo') return ceneoPageUrl(sourceUrl, page);
    if (provider === 'olx') return olxPageUrl(sourceUrl, page);
    return allegroPageUrl(sourceUrl, page);
  }

  function currentPageNumber(provider, sourceUrl) {
    if (provider === 'ceneo') return getCeneoCurrentPage(sourceUrl);
    if (provider === 'olx') return getOlxCurrentPage(sourceUrl);
    try {
      return Math.max(1, Number.parseInt(new URL(sourceUrl).searchParams.get('p') || '1', 10) || 1);
    } catch {
      return 1;
    }
  }

  function parseListing(provider, html, baseUrl) {
    if (provider === 'ceneo') return parseCeneoListing(html, baseUrl);
    if (provider === 'olx') return parseOlxListing(html, baseUrl);
    return parseAllegroListing(html, baseUrl);
  }

  function parseOffer(provider, html, listing, mode) {
    if (provider === 'ceneo') return parseCeneoOffer(html, listing, mode);
    if (provider === 'olx') return parseOlxOffer(html, listing, mode);
    return parseAllegroOffer(html, listing, mode);
  }

  function formatOffer(offer, index) {
    const lines = [`## ${index}. ${offer.title || 'Pozycja bez tytułu'}`];

    if (offer.provider === 'ceneo') {
      const main = [
        ['Źródło', 'Ceneo'],
        ['Cena od', offer.price],
        ['Ocena', offer.rating],
        ['Liczba opinii', offer.reviewCount],
        ['Liczba sklepów', offer.shopsCount],
        ['Liczba ofert', offer.offersCount],
        ['Kupionych ostatnio', offer.purchasesRecently],
        ['ID produktu', offer.itemId],
        ['URL', offer.url],
      ];
      for (const [key, value] of main) {
        if (value !== '' && value !== null && value !== undefined) lines.push(`- ${key}: ${value}`);
      }
    } else if (offer.provider === 'olx') {
      const main = [
        ['Źródło', 'OLX'],
        ['Cena', offer.price],
        ['Stan', offer.condition],
        ['Typ sprzedawcy', offer.sellerType],
        ['Sprzedawca', offer.seller],
        ['Lokalizacja', offer.location],
        ['Dodane / odświeżone', offer.dateAdded],
        ['ID ogłoszenia', offer.itemId],
        ['Numer OLX', offer.numericId],
        ['URL', offer.url],
      ];
      for (const [key, value] of main) {
        if (value !== '' && value !== null && value !== undefined) lines.push(`- ${key}: ${value}`);
      }
    } else {
      const main = [
        ['Źródło', 'Allegro'],
        ['Cena', offer.price],
        ['Stan', offer.condition],
        ['Sprzedawca', offer.seller],
        ['Ocena sprzedawcy', offer.sellerRating],
        ['Dostawa', offer.shipping],
        ['ID oferty', offer.itemId],
        ['URL', offer.url],
      ];
      for (const [key, value] of main) {
        if (value) lines.push(`- ${key}: ${value}`);
      }
    }

    const entries = Object.entries(offer.params || {}).filter(([, value]) => value);
    if (entries.length) {
      lines.push('', '### Parametry');
      for (const [key, value] of entries) lines.push(`- ${key}: ${value}`);
    } else if (offer.parametersText) {
      lines.push('', '### Parametry', offer.parametersText);
    }

    if (offer.summary) lines.push('', '### Skrót produktu', offer.summary);
    if (offer.description) lines.push('', '### Opis', offer.description);

    return lines.join('\n').trim();
  }

  function buildExport(offers, sourceUrl, mode, provider, diagnostics = {}) {
    const generatedAt = new Date().toISOString();
    const site = providerLabel(provider);
    const sourceNote = provider === 'ceneo'
      ? 'Na Ceneo cena "od" pochodzi z porównywarki danego produktu i może obejmować wiele sklepów.'
      : provider === 'olx'
        ? 'Na OLX każda pozycja odpowiada konkretnemu ogłoszeniu. Dane o SMART, przebiegu i stanie mogą znajdować się wyłącznie w opisie sprzedającego.'
        : 'Na Allegro główny listing jest listą produktów. Eksporter rozwija grupy przez "zobacz X ofert", aby każda pozycja eksportu odpowiadała konkretnej ofercie sprzedawcy.';
    const header = [
      `# Eksport z ${site}`,
      '',
      `Źródło: ${sourceUrl}`,
      `Wygenerowano: ${generatedAt}`,
      `Liczba pozycji w eksporcie: ${offers.length}`,
      provider === 'allegro' && diagnostics.listingProductCount !== undefined ? `Karty produktów na listingu Allegro: ${diagnostics.listingProductCount}` : null,
      provider === 'allegro' && diagnostics.groupsFound !== undefined ? `Produkty z linkiem do wielu ofert: ${diagnostics.groupsFound}` : null,
      provider === 'allegro' && diagnostics.groupsExpanded !== undefined ? `Rozwinięte grupy produktów: ${diagnostics.groupsExpanded}` : null,
      provider === 'allegro' && diagnostics.groupPagesScanned ? `Strony list ofert produktów: ${diagnostics.groupPagesScanned}` : null,
      diagnostics.discoveredCount !== undefined ? (provider === 'allegro' ? `Oferty po rozwinięciu grup: ${diagnostics.discoveredCount}` : `Znalezione na listingu: ${diagnostics.discoveredCount}`) : null,
      diagnostics.declaredCount ? `Liczba deklarowana przez serwis: ${diagnostics.declaredCount}` : null,
      diagnostics.pagesScanned ? (provider === 'allegro' ? `Przeskanowane strony produktów: ${diagnostics.pagesScanned}` : `Przeskanowane strony: ${diagnostics.pagesScanned}`) : null,
      diagnostics.totalPages ? `Wskazówka paginacji: ${diagnostics.totalPages}` : null,
      provider === 'allegro' && diagnostics.filteredOut ? `Odrzucone przy ponownym zastosowaniu filtrów: ${diagnostics.filteredOut}` : null,
      provider === 'allegro' && diagnostics.groupErrors ? `Błędy rozwijania grup: ${diagnostics.groupErrors}` : null,
      diagnostics.skippedSeen ? `Pominięto z historii: ${diagnostics.skippedSeen}` : null,
      diagnostics.successCount !== undefined ? `Pobrane poprawnie: ${diagnostics.successCount}` : null,
      diagnostics.errorCount ? `Błędy pobierania: ${diagnostics.errorCount}` : null,
      `Tryb: ${mode === 'full' ? 'pełne opisy' : 'AI compact'}`,
      sourceNote,
      '',
      'Przeanalizuj pozycje pod kątem ceny, opłacalności, parametrów i informacji z opisu. Dla dysków zwróć szczególną uwagę na model, pojemność, technologię zapisu CMR/SMR, przeznaczenie NAS/enterprise, obroty, cache, gwarancję i ewentualne informacje o przebiegu/SMART.',
      '',
    ].filter((line) => line !== null).join('\n');

    const blocks = offers.map((offer, index) => formatOffer(offer, index + 1));
    const fullText = `${header}${blocks.join('\n\n---\n\n')}`;

    const chunks = [];
    let current = `${header}Fragment 1\n\n`;

    for (const block of blocks) {
      const separator = current.trim() ? '\n\n---\n\n' : '';
      if ((current.length + separator.length + block.length) > MAX_CHAT_CHUNK && current.length > header.length + 20) {
        chunks.push(current.trim());
        current = `${header}Kontynuacja eksportu, fragment ${chunks.length + 1}\n\n${block}`;
      } else {
        current += `${separator}${block}`;
      }
    }

    if (current.trim()) chunks.push(current.trim());

    return {
      provider,
      sourceUrl,
      generatedAt,
      mode,
      offerCount: offers.length,
      offers,
      fullText,
      chunks,
    };
  }

  async function getScanCache(provider, sourceUrl) {
    const key = scanCacheKey(provider);
    const data = await storageGet(key);
    const cache = data[key];
    if (!cache || cache.sourceUrl !== sourceUrl || !Array.isArray(cache.allOffers)) return null;
    if (!cache.updatedAt || (Date.now() - cache.updatedAt) > SCAN_CACHE_TTL_MS) return null;
    return cache;
  }

  async function saveScanCache(provider, sourceUrl, scanResult) {
    const key = scanCacheKey(provider);
    await storageSet({
      [key]: {
        provider,
        sourceUrl,
        updatedAt: Date.now(),
        allOffers: Array.isArray(scanResult.allOffers) ? scanResult.allOffers : [],
        pagesScanned: scanResult.pagesScanned || 0,
        declaredCount: scanResult.declaredCount || null,
        totalPages: scanResult.totalPages || null,
        listingProductCount: scanResult.listingProductCount || null,
        groupsFound: scanResult.groupsFound || 0,
        groupsExpanded: scanResult.groupsExpanded || 0,
        groupPagesScanned: scanResult.groupPagesScanned || 0,
        groupErrors: scanResult.groupErrors || 0,
        filteredOut: scanResult.filteredOut || 0,
      },
    });
  }

  async function getHistory(provider) {
    const key = historyKey(provider);
    const data = await storageGet(key);
    const raw = data[key];
    if (!raw || typeof raw !== 'object') return { version: 1, items: {} };
    return {
      version: 1,
      items: raw.items && typeof raw.items === 'object' ? raw.items : {},
    };
  }

  async function addSuccessfulOffersToHistory(provider, offers) {
    const successful = offers.filter((offer) => offer && !offer.error && offer.itemId);
    if (!successful.length) return;

    const key = historyKey(provider);
    const history = await getHistory(provider);
    const now = Date.now();
    for (const offer of successful) {
      history.items[String(offer.itemId)] = {
        seenAt: now,
        title: truncate(offer.title || '', 180),
        url: offer.url || '',
      };
    }
    await storageSet({ [key]: history });
  }

  async function setState(provider, patch) {
    const key = stateKey(provider);
    const existing = (await storageGet(key))[key] || {};
    await storageSet({
      [key]: {
        ...existing,
        ...patch,
        provider,
        updatedAt: Date.now(),
      },
    });
  }

  async function scanListingPages(provider, sourceUrl, options, signal, seenIds) {
    const allOffers = new Map();
    const queuedOffers = new Map();
    const comparisonUrls = new Set();
    const currentPage = currentPageNumber(provider, sourceUrl);
    const firstPage = options.startFromFirst ? 1 : currentPage;
    let declaredCount = null;
    let totalPages = null;
    let pagesScanned = 0;
    let skippedSeen = 0;
    const skippedSeenIds = new Set();
    let consecutiveEmptyPages = 0;

    for (let page = firstPage; page <= MAX_LISTING_PAGES; page += 1) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const url = listingPageUrl(provider, sourceUrl, page);
      await setState(provider, {
        phase: `Skanowanie ${providerLabel(provider)}, strona ${page}`,
        currentItem: url,
        pagesScanned,
        offersFound: allOffers.size,
        queued: queuedOffers.size,
        skippedSeen,
        declaredCount,
        totalPages,
        percent: Math.min(15, Math.max(1, pagesScanned)),
      });

      let html;
      try {
        html = await fetchHtml(url, signal, provider === 'allegro' ? 3 : provider === 'olx' ? 2 : 2);
      } catch (error) {
        if (error?.code === 'PROTECTION_PAGE') throw error;
        // Nie traktujemy pojedynczego błędu technicznego strony listingu jako końca paginacji.
        await setState(provider, {
          currentItem: `Błąd strony ${page}: ${error?.message || String(error)}. Przerwa i dalsza próba.`,
        });
        await sleep(provider === 'allegro' ? 8000 : provider === 'olx' ? 5000 : 3000);
        if (totalPages && page < totalPages) continue;
        throw error;
      }

      const parsed = parseListing(provider, html, url);
      if (parsed.declaredCount) declaredCount = Math.max(declaredCount || 0, parsed.declaredCount);
      if (parsed.totalPages) totalPages = Math.max(totalPages || 0, parsed.totalPages);
      if (provider === 'allegro' && Array.isArray(parsed.comparisonUrls)) {
        for (const compareUrl of parsed.comparisonUrls) comparisonUrls.add(compareUrl);
      }

      let addedAll = 0;
      let addedQueued = 0;
      let pageSkippedSeen = 0;
      for (const offer of parsed.offers) {
        const key = String(offer.itemId || offer.url);
        if (!allOffers.has(key)) {
          allOffers.set(key, offer);
          addedAll += 1;
        }

        if (options.skipSeen && offer.itemId && seenIds.has(String(offer.itemId))) {
          const seenKey = String(offer.itemId);
          if (!skippedSeenIds.has(seenKey)) {
            skippedSeenIds.add(seenKey);
            pageSkippedSeen += 1;
          }
          continue;
        }

        if (!queuedOffers.has(key)) {
          if (options.maxOffers === 0 || queuedOffers.size < options.maxOffers) {
            queuedOffers.set(key, offer);
            addedQueued += 1;
          }
        }
      }

      skippedSeen += pageSkippedSeen;
      pagesScanned += 1;
      consecutiveEmptyPages = addedAll === 0 ? consecutiveEmptyPages + 1 : 0;

      await setState(provider, {
        pagesScanned,
        offersFound: allOffers.size,
        queued: queuedOffers.size,
        skippedSeen,
        declaredCount,
        totalPages,
        currentItem: `Strona ${page}: +${addedAll} ofert, +${addedQueued} do pobrania, pominięto ${pageSkippedSeen}`,
      });

      if (provider !== 'allegro' && options.maxOffers > 0 && queuedOffers.size >= options.maxOffers) break;

      if (provider === 'ceneo') {
        // Ceneo ma stabilną numerację stron. Gdy znamy ostatnią stronę, dochodzimy do niej.
        if (totalPages && page >= totalPages) break;
        if (!totalPages && page > firstPage && consecutiveEmptyPages >= 2) break;
      } else if (provider === 'olx') {
        // OLX korzysta z parametru page=N. Paginacja jest wskazówką, ale zatrzymujemy
        // się również po dwóch stronach bez nowych ID, aby nie polegać wyłącznie na DOM.
        if (totalPages && page >= totalPages) break;
        if (page > firstPage && consecutiveEmptyPages >= 2) break;
      } else {
        // Główny listing Allegro jest obecnie listą PRODUKTÓW, nie pojedynczych ofert.
        // Paginacja dotyczy więc kart produktów i tutaj możemy zakończyć na ostatniej
        // stronie widocznej w paginacji. Wszystkie oferty sprzedawców rozwijamy potem
        // przez /oferty-produktu/... .
        if (totalPages && page >= totalPages) break;
        if (!totalPages && page > firstPage && consecutiveEmptyPages >= 2) break;
      }

      await sleep(provider === 'ceneo' ? 500 : provider === 'olx' ? 800 : 700);
    }

    return {
      allOffers: [...allOffers.values()],
      queuedOffers: [...queuedOffers.values()],
      pagesScanned,
      skippedSeen,
      declaredCount,
      totalPages,
      comparisonUrls: [...comparisonUrls],
    };
  }

  function buildQueueFromOffers(offers, options, seenIds) {
    const queued = [];
    let skippedSeen = 0;
    const skippedIds = new Set();

    for (const offer of offers) {
      const id = offer.itemId ? String(offer.itemId) : null;
      if (options.skipSeen && id && seenIds.has(id)) {
        if (!skippedIds.has(id)) {
          skippedIds.add(id);
          skippedSeen += 1;
        }
        continue;
      }
      if (options.maxOffers > 0 && queued.length >= options.maxOffers) continue;
      queued.push(offer);
    }

    return { queuedOffers: queued, skippedSeen };
  }

  async function expandAllegroProductGroups(scanResult, sourceUrl, options, signal, seenIds) {
    const filters = allegroSourceFilters(sourceUrl);
    const all = new Map();
    let filteredOut = 0;

    for (const offer of scanResult.allOffers) {
      const key = String(offer.itemId || offer.url);
      if (matchesAllegroSourceFilters(offer, filters)) all.set(key, offer);
      else filteredOut += 1;
    }

    const groups = Array.isArray(scanResult.comparisonUrls) ? [...new Set(scanResult.comparisonUrls)] : [];
    let groupsExpanded = 0;
    let groupPagesScanned = 0;
    let groupErrors = 0;
    let rawOffersSeen = all.size;
    let nextGroup = 0;

    async function expandOne(compareUrl) {
      const groupMap = new Map();
      let declaredForGroup = null;
      let groupTotalPages = null;
      let consecutiveEmpty = 0;
      let localPages = 0;

      for (let page = 1; page <= 20; page += 1) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (groupTotalPages && page > groupTotalPages) break;

        const url = allegroProductOffersPageUrl(compareUrl, page);
        let html;
        try {
          html = await fetchHtml(url, signal, 2);
        } catch (error) {
          if (error?.name === 'AbortError' || error?.code === 'PROTECTION_PAGE') throw error;
          return { offers: [...groupMap.values()], pages: localPages, error: true };
        }

        localPages += 1;
        const parsed = parseAllegroProductOffersPage(html, url);
        if (parsed.declaredCount) declaredForGroup = Math.max(declaredForGroup || 0, parsed.declaredCount);
        if (parsed.totalPages) groupTotalPages = Math.max(groupTotalPages || 0, parsed.totalPages);

        let added = 0;
        for (const offer of parsed.offers) {
          const key = String(offer.itemId || offer.url);
          if (!groupMap.has(key)) {
            groupMap.set(key, offer);
            added += 1;
          }
        }

        consecutiveEmpty = added === 0 ? consecutiveEmpty + 1 : 0;
        if (declaredForGroup && groupMap.size >= declaredForGroup) break;
        if (groupTotalPages && page >= groupTotalPages) break;
        if (page > 1 && consecutiveEmpty >= 1) break;
        await sleep(Math.max(180, Math.min((options.delayMs || 700) * 0.4, 600)));
      }

      return { offers: [...groupMap.values()], pages: localPages, error: false };
    }

    async function groupWorker(workerNo) {
      while (true) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const index = nextGroup;
        nextGroup += 1;
        if (index >= groups.length) return;
        const compareUrl = groups[index];

        await setState('allegro', {
          phase: `Rozwijanie produktów Allegro ${groupsExpanded}/${groups.length}`,
          currentItem: `Worker grup ${workerNo}: ${index + 1}/${groups.length}`,
          offersFound: all.size,
          declaredCount: scanResult.declaredCount,
          totalPages: scanResult.totalPages,
          activeWorkers: scheduler.activeByProvider.allegro || 0,
          percent: groups.length ? 15 + ((groupsExpanded / groups.length) * 12) : 27,
        });

        const expanded = await expandOne(compareUrl);
        groupPagesScanned += expanded.pages;
        if (expanded.error) groupErrors += 1;
        rawOffersSeen += expanded.offers.length;

        for (const offer of expanded.offers) {
          const key = String(offer.itemId || offer.url);
          if (!matchesAllegroSourceFilters(offer, filters)) {
            filteredOut += 1;
            continue;
          }
          all.set(key, offer);
        }

        groupsExpanded += 1;
        await setState('allegro', {
          phase: `Rozwijanie produktów Allegro ${groupsExpanded}/${groups.length}`,
          currentItem: `Rozwinięto ${groupsExpanded}/${groups.length}, unikalnych ofert: ${all.size}`,
          offersFound: all.size,
          activeWorkers: scheduler.activeByProvider.allegro || 0,
          percent: groups.length ? 15 + ((groupsExpanded / groups.length) * 12) : 27,
        });
      }
    }

    const workerCount = Math.min(configuredProviderLimit('allegro'), Math.max(1, groups.length));
    await Promise.all(Array.from({ length: workerCount }, (_, i) => groupWorker(i + 1)));

    const queue = buildQueueFromOffers([...all.values()], options, seenIds);
    return {
      allOffers: [...all.values()],
      queuedOffers: queue.queuedOffers,
      skippedSeen: queue.skippedSeen,
      groupsFound: groups.length,
      groupsExpanded,
      groupPagesScanned,
      groupErrors,
      filteredOut,
      rawOffersSeen,
    };
  }

  async function fetchOfferDetails(provider, listingOffers, options, signal, progressMeta = {}) {
    const total = listingOffers.length;
    const results = new Array(total);
    const baseOffers = Array.isArray(progressMeta.baseOffers) ? progressMeta.baseOffers.filter((offer) => offer && !offer.error) : [];
    let nextIndex = 0;
    let processed = 0;
    let errors = 0;
    let lastPartialAt = 0;
    let savingPartial = Promise.resolve();
    const historyBuffer = [];

    function mergedOffers() {
      const map = new Map();
      for (const offer of baseOffers) {
        const key = String(offer.itemId || offer.url || Math.random());
        map.set(key, offer);
      }
      for (const offer of results.filter(Boolean)) {
        const key = String(offer.itemId || offer.url || Math.random());
        map.set(key, offer);
      }
      return [...map.values()];
    }

    async function flushHistory(force = false) {
      if (!force && historyBuffer.length < 5) return;
      if (!historyBuffer.length) return;
      const batch = historyBuffer.splice(0, historyBuffer.length);
      await addSuccessfulOffersToHistory(provider, batch);
    }

    async function savePartial(force = false) {
      const now = Date.now();
      if (!force && processed > 0 && processed % 25 !== 0 && (now - lastPartialAt) < 12000) return;
      lastPartialAt = now;
      const task = async () => {
        const snapshot = mergedOffers();
        const successCount = snapshot.filter((offer) => !offer.error).length;
        const errorCount = results.filter((offer) => offer?.error).length;
        const diagnostics = {
          ...(progressMeta.diagnostics || {}),
          successCount,
          errorCount,
        };
        const partialResult = buildExport(snapshot, progressMeta.sourceUrl || '', options.mode, provider, diagnostics);
        partialResult.partial = true;
        partialResult.totalQueued = total;
        partialResult.processedCount = processed;
        partialResult.successCount = successCount;
        partialResult.errorCount = errorCount;
        Object.assign(partialResult, progressMeta.resultFields || {});
        await storageSet({ [resultKey(provider)]: partialResult });
        await setState(provider, { partial: true });
      };
      savingPartial = savingPartial.then(task, task);
      await savingPartial;
    }

    async function fetchOne(listing, index, retryPass = false) {
      try {
        const retries = provider === 'ceneo' ? 1 : 2;
        const html = await fetchHtml(listing.url, signal, retries);
        const parsed = parseOffer(provider, html, listing, options.mode);
        if (!parsed.title && listing.listingTitle) parsed.title = listing.listingTitle;
        parsed._listingIndex = index;
        return parsed;
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'PROTECTION_PAGE') throw error;
        return {
          provider,
          itemId: listing.itemId,
          title: listing.listingTitle || 'Nie udało się pobrać szczegółów',
          price: listing.listingPrice || '',
          rating: listing.rating || '',
          reviewCount: listing.reviewCount || null,
          shopsCount: listing.shopsCount || null,
          offersCount: listing.offersCount || null,
          condition: listing.listingCondition || '',
          seller: '',
          sellerRating: '',
          shipping: '',
          params: listing.listingParams || {},
          parametersText: '',
          description: `Błąd pobierania${retryPass ? ' po ponownej próbie' : ''}: ${error?.message || String(error)}`,
          url: listing.url,
          error: true,
          _retryable: isRetryableError(error),
          _listingIndex: index,
        };
      }
    }

    async function worker(workerNo) {
      while (true) {
        if (signal.aborted) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= total) return;

        const listing = listingOffers[index];
        await setState(provider, {
          phase: provider === 'ceneo' ? 'Pobieranie danych produktów' : provider === 'olx' ? 'Pobieranie szczegółów ogłoszeń' : 'Pobieranie szczegółów ofert',
          currentItem: `${index + 1}/${total}: ${listing.listingTitle || listing.url}`,
          queued: total,
          processed,
          errors,
          activeWorkers: scheduler.activeByProvider[provider] || 0,
          percent: total ? 27 + (processed / total) * 66 : 93,
        });

        let parsed;
        try {
          parsed = await fetchOne(listing, index, false);
        } catch (error) {
          if (error?.name === 'AbortError') return;
          if (error?.code === 'PROTECTION_PAGE') {
            await flushHistory(true);
            await savePartial(true);
          }
          throw error;
        }
        results[index] = parsed;
        processed += 1;
        errors = results.filter((offer) => offer?.error).length;
        if (!parsed.error) historyBuffer.push(parsed);

        if (historyBuffer.length >= (provider === 'olx' ? 5 : 1)) await flushHistory(false);
        await setState(provider, {
          processed,
          errors,
          activeWorkers: scheduler.activeByProvider[provider] || 0,
          percent: total ? 27 + (processed / total) * 66 : 93,
          currentItem: `Worker ${workerNo}: ukończono ${processed}/${total}`,
        });
        await savePartial(false);

        const baseDelay = provider === 'allegro'
          ? Math.max(450, Math.round((options.delayMs || 700) * 0.85))
          : provider === 'olx'
            ? Math.max(220, Math.round((options.delayMs || 700) * 0.5))
            : Math.max(120, Math.round((options.delayMs || 700) * 0.22));
        await sleep(baseDelay);
      }
    }

    const workerCount = Math.max(1, Math.min(configuredProviderLimit(provider), total || 1));
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)));
    await flushHistory(true);
    await savePartial(true);

    if (signal.aborted) {
      return { offers: mergedOffers(), errors: results.filter((offer) => offer?.error).length, aborted: true };
    }

    // Druga próba tylko dla błędów przejściowych. Błędów 404 lub niepoprawnych stron
    // nie mielimy wielokrotnie, co wcześniej mocno spowalniało Ceneo.
    const failedIndexes = results
      .map((offer, index) => offer?.error && offer?._retryable ? index : -1)
      .filter((index) => index >= 0);

    if (failedIndexes.length) {
      await setState(provider, {
        phase: `Ponawianie ${failedIndexes.length} błędów przejściowych`,
        currentItem: 'Automatyczny retry z adaptacyjnym ograniczeniem szybkości',
        percent: 94,
      });

      let retried = 0;
      for (const index of failedIndexes) {
        if (signal.aborted) break;
        const listing = listingOffers[index];
        let parsed;
        try {
          parsed = await fetchOne(listing, index, true);
        } catch (error) {
          if (error?.name === 'AbortError') break;
          if (error?.code === 'PROTECTION_PAGE') {
            await flushHistory(true);
            await savePartial(true);
          }
          throw error;
        }
        results[index] = parsed;
        if (!parsed.error) historyBuffer.push(parsed);
        retried += 1;
        errors = results.filter((offer) => offer?.error).length;
        await setState(provider, {
          phase: `Ponawianie błędów ${retried}/${failedIndexes.length}`,
          currentItem: listing.listingTitle || listing.url,
          errors,
          activeWorkers: scheduler.activeByProvider[provider] || 0,
          percent: 94 + ((retried / failedIndexes.length) * 3),
        });
        if (historyBuffer.length >= (provider === 'olx' ? 5 : 1)) await flushHistory(false);
        await savePartial(false);
        await sleep(provider === 'allegro' ? 900 : provider === 'olx' ? 600 : 350);
      }
    }

    await flushHistory(true);
    await savePartial(true);
    return {
      offers: mergedOffers(),
      errors: results.filter((offer) => offer?.error).length,
      aborted: signal.aborted,
    };
  }

  async function run(provider, sourceUrl, options, resume = false) {
    const controller = new AbortController();
    const startedAt = Date.now();
    const effectiveOptions = resume ? { ...options, skipSeen: true } : { ...options };
    jobs[provider] = { controller, sourceUrl, options: effectiveOptions, startedAt };
    scheduler.setLimit(effectiveOptions.concurrency || 6);

    if (!provider || detectProvider(sourceUrl) !== provider) {
      jobs[provider] = null;
      throw new Error('Nieprawidłowy adres źródłowy dla wybranego serwisu.');
    }

    const stateStorageKey = stateKey(provider);
    const resultStorageKey = resultKey(provider);
    const previousResult = (await storageGet(resultStorageKey))[resultStorageKey] || null;
    const baseOffers = resume && Array.isArray(previousResult?.offers)
      ? previousResult.offers.filter((offer) => offer && !offer.error)
      : [];

    await storageSet({
      [metaKey(provider)]: {
        provider,
        sourceUrl,
        options: effectiveOptions,
        updatedAt: startedAt,
      },
      [stateStorageKey]: {
        running: true,
        done: false,
        failed: false,
        partial: Boolean(baseOffers.length),
        provider,
        phase: resume ? 'Wznawianie' : 'Start',
        pagesScanned: 0,
        offersFound: 0,
        queued: 0,
        skippedSeen: 0,
        processed: 0,
        errors: 0,
        declaredCount: null,
        totalPages: null,
        activeWorkers: 0,
        workerLimit: configuredProviderLimit(provider),
        currentItem: sourceUrl,
        percent: 0,
        startedAt,
        updatedAt: startedAt,
      },
    });

    try {
      const history = await getHistory(provider);
      const seenIds = new Set(Object.keys(history.items || {}));
      let scanResult = null;

      if (resume) {
        const cached = await getScanCache(provider, sourceUrl);
        if (cached) {
          const queue = buildQueueFromOffers(cached.allOffers, effectiveOptions, seenIds);
          scanResult = {
            ...cached,
            queuedOffers: queue.queuedOffers,
            skippedSeen: queue.skippedSeen,
            fromCache: true,
          };
          await setState(provider, {
            phase: 'Wznawianie z zapisanego skanu',
            offersFound: cached.allOffers.length,
            queued: queue.queuedOffers.length,
            skippedSeen: queue.skippedSeen,
            pagesScanned: cached.pagesScanned || 0,
            declaredCount: cached.declaredCount || null,
            totalPages: cached.totalPages || null,
            currentItem: `Używam zapisanego skanu sprzed ${Math.max(0, Math.round((Date.now() - cached.updatedAt) / 60000))} min. Pobieram tylko pozycje bez poprawnego wyniku.`,
            percent: provider === 'allegro' ? 27 : 20,
          });
        }
      }

      if (!scanResult) {
        scanResult = await scanListingPages(provider, sourceUrl, effectiveOptions, controller.signal, seenIds);
        const listingProductCount = scanResult.allOffers.length;

        if (provider === 'allegro') {
          const expanded = await expandAllegroProductGroups(scanResult, sourceUrl, effectiveOptions, controller.signal, seenIds);
          scanResult = {
            ...scanResult,
            allOffers: expanded.allOffers,
            queuedOffers: expanded.queuedOffers,
            skippedSeen: expanded.skippedSeen,
            listingProductCount,
            groupsFound: expanded.groupsFound,
            groupsExpanded: expanded.groupsExpanded,
            groupPagesScanned: expanded.groupPagesScanned,
            groupErrors: expanded.groupErrors,
            filteredOut: expanded.filteredOut,
            rawOffersSeen: expanded.rawOffersSeen,
          };
        }

        await saveScanCache(provider, sourceUrl, scanResult);
      }

      const listingOffers = scanResult.queuedOffers;
      if (!scanResult.allOffers.length) {
        throw new Error(`Nie znaleziono pozycji na stronie ${providerLabel(provider)}. Sprawdź zapisany adres i filtry.`);
      }

      const diagnosticsBase = {
        discoveredCount: scanResult.allOffers.length,
        declaredCount: scanResult.declaredCount,
        totalPages: scanResult.totalPages,
        pagesScanned: scanResult.pagesScanned,
        skippedSeen: scanResult.skippedSeen,
        listingProductCount: scanResult.listingProductCount,
        groupsFound: scanResult.groupsFound,
        groupsExpanded: scanResult.groupsExpanded,
        groupPagesScanned: scanResult.groupPagesScanned,
        groupErrors: scanResult.groupErrors,
        filteredOut: scanResult.filteredOut,
      };
      const resultFields = {
        skippedSeen: scanResult.skippedSeen,
        discoveredCount: scanResult.allOffers.length,
        declaredCount: scanResult.declaredCount,
        totalPages: scanResult.totalPages,
        pagesScanned: scanResult.pagesScanned,
        listingProductCount: scanResult.listingProductCount || null,
        groupsFound: scanResult.groupsFound || 0,
        groupsExpanded: scanResult.groupsExpanded || 0,
        groupPagesScanned: scanResult.groupPagesScanned || 0,
        groupErrors: scanResult.groupErrors || 0,
        filteredOut: scanResult.filteredOut || 0,
      };

      if (!listingOffers.length) {
        if (!baseOffers.length) {
          const emptyResult = buildExport([], sourceUrl, effectiveOptions.mode, provider, { ...diagnosticsBase, successCount: 0, errorCount: 0 });
          Object.assign(emptyResult, resultFields);
          await storageSet({ [resultStorageKey]: emptyResult });
        }
        await setState(provider, {
          running: false,
          done: true,
          failed: false,
          partial: false,
          phase: 'Gotowe, brak nowych pozycji',
          offersFound: scanResult.allOffers.length,
          queued: 0,
          skippedSeen: scanResult.skippedSeen,
          processed: baseOffers.length,
          errors: 0,
          declaredCount: scanResult.declaredCount,
          totalPages: scanResult.totalPages,
          currentItem: `Wszystkie znalezione pozycje były już w historii (${scanResult.skippedSeen}).`,
          percent: 100,
          finishedAt: Date.now(),
        });
        return;
      }

      await setState(provider, {
        phase: 'Lista gotowa, pobieram szczegóły',
        offersFound: scanResult.allOffers.length,
        queued: listingOffers.length,
        skippedSeen: scanResult.skippedSeen,
        declaredCount: scanResult.declaredCount,
        totalPages: scanResult.totalPages,
        percent: provider === 'allegro' ? 27 : 20,
        currentItem: provider === 'allegro'
          ? `Karty produktów: ${scanResult.listingProductCount || 0}, po rozwinięciu: ${scanResult.allOffers.length} ofert, nowych ${listingOffers.length}, pominięto ${scanResult.skippedSeen}`
          : `Znaleziono ${scanResult.allOffers.length}, nowych ${listingOffers.length}, pominięto ${scanResult.skippedSeen}`,
      });

      const detailResult = await fetchOfferDetails(provider, listingOffers, effectiveOptions, controller.signal, {
        sourceUrl,
        diagnostics: diagnosticsBase,
        resultFields,
        baseOffers,
      });

      if (detailResult.aborted || controller.signal.aborted) {
        await setState(provider, {
          running: false,
          done: false,
          failed: false,
          partial: true,
          phase: 'Przerwano, wynik częściowy zapisany',
          errors: detailResult.errors,
          currentItem: 'Możesz otworzyć częściowy wynik albo kliknąć Wznów. Poprawne pozycje są już w historii.',
          finishedAt: Date.now(),
        });
        return;
      }

      await setState(provider, {
        phase: 'Budowanie eksportu',
        currentItem: 'Dzielę wynik na fragmenty do ChatGPT',
        percent: 98,
      });

      const successCount = detailResult.offers.filter((offer) => !offer.error).length;
      const diagnostics = { ...diagnosticsBase, successCount, errorCount: detailResult.errors };
      const result = buildExport(detailResult.offers, sourceUrl, effectiveOptions.mode, provider, diagnostics);
      Object.assign(result, resultFields, {
        successCount,
        errorCount: detailResult.errors,
        partial: false,
      });
      await storageSet({ [resultStorageKey]: result });
      await addSuccessfulOffersToHistory(provider, detailResult.offers);

      await setState(provider, {
        running: false,
        done: true,
        failed: false,
        partial: false,
        phase: detailResult.errors ? 'Gotowe z błędami' : 'Gotowe',
        processed: detailResult.offers.length,
        errors: detailResult.errors,
        activeWorkers: 0,
        currentItem: `${successCount} poprawnie, ${detailResult.errors} błędów, ${result.chunks.length} fragmentów`,
        percent: 100,
        finishedAt: Date.now(),
      });
    } catch (error) {
      const aborted = error?.name === 'AbortError' || controller.signal.aborted;
      const protection = error?.code === 'PROTECTION_PAGE';
      await setState(provider, {
        running: false,
        done: false,
        failed: !aborted && !protection,
        partial: Boolean((await storageGet(resultStorageKey))[resultStorageKey]?.chunks?.length),
        phase: protection ? 'Wstrzymano przez ochronę serwisu' : aborted ? 'Przerwano' : 'Błąd',
        currentItem: protection
          ? `${error?.message || 'Serwis włączył ochronę.'} Nie ponawiam automatycznie. Po ustaniu blokady kliknij Wznów.`
          : aborted
            ? 'Eksport przerwany. Jeśli istnieje wynik częściowy, możesz go otworzyć i później wznowić.'
            : (error?.message || String(error)),
        activeWorkers: 0,
        finishedAt: Date.now(),
      });
    } finally {
      if (provider === 'ceneo') await closeCeneoBrowserTab();
      jobs[provider] = null;
      scheduler.pump();
    }
  }

  async function migrateLegacyStorage() {
    const legacy = await storageGet([LEGACY_STORAGE_STATE, LEGACY_STORAGE_RESULT]);
    const oldResult = legacy[LEGACY_STORAGE_RESULT];
    if (oldResult?.provider && (oldResult.provider === 'allegro' || oldResult.provider === 'ceneo' || oldResult.provider === 'olx')) {
      const provider = oldResult.provider;
      const newResultKey = resultKey(provider);
      const existing = (await storageGet(newResultKey))[newResultKey];
      if (!existing) await storageSet({ [newResultKey]: oldResult });
      await addSuccessfulOffersToHistory(provider, oldResult.offers || []);
    }

    const oldState = legacy[LEGACY_STORAGE_STATE];
    if (oldState?.provider && (oldState.provider === 'allegro' || oldState.provider === 'ceneo' || oldState.provider === 'olx')) {
      const provider = oldState.provider;
      const newStateKey = stateKey(provider);
      const existing = (await storageGet(newStateKey))[newStateKey];
      if (!existing) await storageSet({ [newStateKey]: oldState });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'marketplace-runner') return false;

    if (message?.type === 'MARKETPLACE_RUNNER_START') {
      const provider = message.provider || detectProvider(message.sourceUrl);
      if (!provider || !['allegro', 'ceneo', 'olx'].includes(provider)) {
        sendResponse({ ok: false, error: 'Nie rozpoznano serwisu.' });
        return false;
      }
      if (jobs[provider]) {
        sendResponse({ ok: false, error: `Eksport ${providerLabel(provider)} już trwa.` });
        return false;
      }

      const options = {
        startFromFirst: message.options?.startFromFirst !== false,
        mode: message.options?.mode === 'full' ? 'full' : 'compact',
        maxOffers: Math.max(0, Number(message.options?.maxOffers || 0)),
        concurrency: Math.max(2, Math.min(9, Number(message.options?.concurrency || 6))),
        workerLimits: {
          allegro: Math.max(1, Math.min(2, Number(message.options?.workerLimits?.allegro || 1))),
          ceneo: 1,
          olx: Math.max(1, Math.min(6, Number(message.options?.workerLimits?.olx || 4))),
        },
        delayMs: Math.max(200, Math.min(2000, Number(message.options?.delayMs || 700))),
        skipSeen: message.options?.skipSeen !== false,
      };

      run(provider, message.sourceUrl, options, Boolean(message.resume)).catch(async (error) => {
        jobs[provider] = null;
        await setState(provider, {
          running: false,
          done: false,
          failed: true,
          phase: 'Błąd',
          currentItem: error?.message || String(error),
          activeWorkers: 0,
        });
      });
      sendResponse({ ok: true, provider });
      return false;
    }

    if (message?.type === 'MARKETPLACE_RUNNER_STOP') {
      const provider = message.provider;
      if (jobs[provider]?.controller) jobs[provider].controller.abort();
      sendResponse({ ok: true, provider });
      return false;
    }

    if (message?.type === 'MARKETPLACE_RUNNER_STATUS') {
      sendResponse({
        ok: true,
        activeProviders: Object.keys(jobs).filter((provider) => Boolean(jobs[provider])),
        scheduler: {
          limit: scheduler.limit,
          active: scheduler.active,
          activeByProvider: { ...scheduler.activeByProvider },
        },
      });
      return false;
    }

    return false;
  });

  migrateLegacyStorage().catch(() => {});
})();
