(() => {
  const LEGACY_STORAGE_STATE = 'marketplaceExporterState';
  const LEGACY_STORAGE_RESULT = 'marketplaceExporterResult';
  const STORAGE_PREFIX = 'marketplaceExporter';

  const stateKey = (provider) => `${STORAGE_PREFIX}:state:${provider}`;
  const resultKey = (provider) => `${STORAGE_PREFIX}:result:${provider}`;
  const historyKey = (provider) => `${STORAGE_PREFIX}:history:${provider}`;
  const MAX_LISTING_PAGES = 100;
  const MAX_CHAT_CHUNK = 48000;

  let job = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    } catch {
      // no-op
    }
    return null;
  }

  function providerLabel(provider) {
    return provider === 'ceneo' ? 'Ceneo' : 'Allegro';
  }

  function parseDocument(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  async function fetchHtml(url, signal, retries = 3) {
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      try {
        const response = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
          signal,
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });

        if (response.status === 403 || response.status === 429 || response.status >= 500) {
          const retryAfter = Number.parseInt(response.headers.get('Retry-After') || '0', 10);
          const provider = detectProvider(url);
          const fallbackWait = provider === 'allegro'
            ? Math.min(30000, 3000 * (2 ** attempt))
            : Math.min(12000, 1500 * (attempt + 1));
          const wait = retryAfter > 0 ? retryAfter * 1000 : fallbackWait;
          lastError = new Error(`HTTP ${response.status} dla ${url}`);
          if (attempt < retries) {
            await sleep(wait);
            continue;
          }
          throw lastError;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} dla ${url}`);
        }

        const html = await response.text();
        if (/nietypow(?:y|a) ruch|access denied|potwierdź.{0,80}robotem|verify.{0,80}human/i.test(html) && html.length < 250000) {
          throw new Error(`Serwis ${providerLabel(detectProvider(url))} zwrócił stronę ochronną zamiast danych`);
        }
        return html;
      } catch (error) {
        lastError = error;
        if (error?.name === 'AbortError') throw error;
        if (attempt < retries) {
          const protective = /stronę ochronną|access denied|robotem|verify/i.test(error?.message || '');
          const provider = detectProvider(url);
          const wait = protective && provider === 'allegro'
            ? Math.min(30000, 5000 * (attempt + 1))
            : 1000 * (attempt + 1);
          await sleep(wait);
        }
      }
    }

    throw lastError || new Error(`Nie udało się pobrać ${url}`);
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

  function allegroPageUrl(sourceUrl, page) {
    const url = new URL(sourceUrl);
    if (page <= 1) url.searchParams.delete('p');
    else url.searchParams.set('p', String(page));
    return url.href;
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
        map.set(key, {
          provider: 'allegro',
          url: normalizeAllegroOfferUrl(href),
          itemId: offerId,
          listingTitle: singleLine(anchor.textContent),
        });
      }
    }

    const bodyText = cleanText(doc.body?.textContent || '');

    // Allegro potrafi umieszczać na stronie kilka napisów typu „60 ofert”.
    // Pierwsza wersja brała pierwszy znaleziony numer, co mogło błędnie kończyć
    // skanowanie po jednej stronie. Bierzemy największą sensowną wartość.
    const declaredCounts = [...bodyText.matchAll(/([\d\s]+)\s+ofert(?:a|y)?\b/gi)]
      .map((match) => Number.parseInt(match[1].replace(/\s/g, ''), 10))
      .filter((value) => Number.isFinite(value) && value > 0 && value < 1000000);
    const declaredCount = declaredCounts.length ? Math.max(...declaredCounts) : null;

    // Najpewniejszy sygnał liczby stron to linki paginacji z parametrem p.
    // Nie ograniczamy się do tekstu strony, bo Allegro często renderuje tam
    // liczbę ofert na pojedynczą sekcję, a nie cały wynik filtrowania.
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
    let totalPages = pageNumbers.length ? Math.max(...pageNumbers) : null;
    if (declaredCount && map.size >= 10) {
      const estimatedPages = Math.min(MAX_LISTING_PAGES, Math.ceil(declaredCount / map.size));
      totalPages = Math.max(totalPages || 0, estimatedPages);
    }

    return {
      offers: [...map.values()],
      declaredCount,
      totalPages,
    };
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
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      const text = singleLine(node.textContent);
      if (text.length >= 40 && text.length <= 5000 && /\d[\d\s]*[,.]\d{2}\s*zł/i.test(text)) {
        if (/Porównaj ceny|Idź do sklepu|opini|Pojemność|Cache|Prędkość/i.test(text)) return node;
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

  function parseCeneoListing(html, baseUrl) {
    const doc = parseDocument(html);
    const map = new Map();

    for (const anchor of doc.querySelectorAll('a[href]')) {
      const href = absoluteUrl(anchor.getAttribute('href'), baseUrl);
      if (!href || detectProvider(href) !== 'ceneo') continue;
      const productId = getCeneoProductId(href);
      if (!productId) continue;

      const anchorText = singleLine(anchor.textContent);
      const generic = /^(warianty|porównaj ceny|idź do sklepu|napisz opinię|\d+[,.]\d{2}\s*zł|od\s*\d)/i.test(anchorText);
      const cardData = parseCeneoCard(findCeneoCard(anchor));
      if (!cardData.listingPrice) continue;
      const existing = map.get(productId);

      if (!existing) {
        map.set(productId, {
          provider: 'ceneo',
          url: normalizeCeneoProductUrl(href),
          itemId: productId,
          listingTitle: generic ? '' : anchorText,
          ...cardData,
        });
      } else {
        if (!generic && anchorText.length > (existing.listingTitle || '').length) existing.listingTitle = anchorText;
        if (!existing.listingPrice && cardData.listingPrice) existing.listingPrice = cardData.listingPrice;
        if (!existing.shopsCount && cardData.shopsCount) existing.shopsCount = cardData.shopsCount;
        if (!existing.offersCount && cardData.offersCount) existing.offersCount = cardData.offersCount;
        if (!existing.rating && cardData.rating) existing.rating = cardData.rating;
        if (!existing.reviewCount && cardData.reviewCount) existing.reviewCount = cardData.reviewCount;
        existing.listingParams = { ...(existing.listingParams || {}), ...(cardData.listingParams || {}) };
      }
    }

    const bodyText = singleLine(doc.body?.textContent || '');
    const h1 = singleLine(doc.querySelector('h1')?.textContent || '');
    const h1Index = h1 ? bodyText.indexOf(h1) : -1;
    const headSlice = h1Index >= 0 ? bodyText.slice(h1Index, h1Index + 600) : bodyText.slice(0, 1500);
    const countMatch = headSlice.match(/\(([\d\s]+)\)/);
    const declaredCount = countMatch ? Number.parseInt(countMatch[1].replace(/\s/g, ''), 10) : null;

    let totalPages = null;
    const explicitPageTotalMatches = [...bodyText.matchAll(/\bz\s+(\d{1,3})\b/g)];
    for (const match of explicitPageTotalMatches) {
      const total = Number.parseInt(match[1], 10);
      if (total >= 2 && total <= MAX_LISTING_PAGES) {
        totalPages = Math.max(totalPages || 0, total);
      }
    }

    return {
      offers: [...map.values()].filter((item) => item.listingTitle || item.listingPrice),
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

  function listingPageUrl(provider, sourceUrl, page) {
    return provider === 'ceneo' ? ceneoPageUrl(sourceUrl, page) : allegroPageUrl(sourceUrl, page);
  }

  function currentPageNumber(provider, sourceUrl) {
    if (provider === 'ceneo') return getCeneoCurrentPage(sourceUrl);
    try {
      return Math.max(1, Number.parseInt(new URL(sourceUrl).searchParams.get('p') || '1', 10) || 1);
    } catch {
      return 1;
    }
  }

  function parseListing(provider, html, baseUrl) {
    return provider === 'ceneo'
      ? parseCeneoListing(html, baseUrl)
      : parseAllegroListing(html, baseUrl);
  }

  function parseOffer(provider, html, listing, mode) {
    return provider === 'ceneo'
      ? parseCeneoOffer(html, listing, mode)
      : parseAllegroOffer(html, listing, mode);
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
      : 'Na Allegro każda pozycja odpowiada konkretnej ofercie.';
    const header = [
      `# Eksport z ${site}`,
      '',
      `Źródło: ${sourceUrl}`,
      `Wygenerowano: ${generatedAt}`,
      `Liczba pozycji w eksporcie: ${offers.length}`,
      diagnostics.discoveredCount !== undefined ? `Znalezione na listingu: ${diagnostics.discoveredCount}` : null,
      diagnostics.declaredCount ? `Liczba deklarowana przez serwis: ${diagnostics.declaredCount}` : null,
      diagnostics.totalPages ? `Liczba stron: ${diagnostics.totalPages}` : null,
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

  async function getHistory(provider) {
    const key = historyKey(provider);
    const data = await chrome.storage.local.get(key);
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
    await chrome.storage.local.set({ [key]: history });
  }

  async function setState(provider, patch) {
    const key = stateKey(provider);
    const existing = (await chrome.storage.local.get(key))[key] || {};
    await chrome.storage.local.set({
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
        html = page === currentPage && page === firstPage
          ? document.documentElement.outerHTML
          : await fetchHtml(url, signal, provider === 'allegro' ? 5 : 3);
      } catch (error) {
        // Nie traktujemy pojedynczego błędu strony listingu jako końca paginacji.
        // Przy Allegro chwilowe blokady są częste, więc robimy dłuższą przerwę i próbujemy dalej.
        await setState(provider, {
          currentItem: `Błąd strony ${page}: ${error?.message || String(error)}. Przerwa i dalsza próba.`,
        });
        await sleep(provider === 'allegro' ? 8000 : 3000);
        if (totalPages && page < totalPages) continue;
        throw error;
      }

      const parsed = parseListing(provider, html, url);
      if (parsed.declaredCount) declaredCount = Math.max(declaredCount || 0, parsed.declaredCount);
      if (parsed.totalPages) totalPages = Math.max(totalPages || 0, parsed.totalPages);

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

      if (options.maxOffers > 0 && queuedOffers.size >= options.maxOffers) break;
      if (totalPages && page >= totalPages) break;
      if (declaredCount && allOffers.size >= declaredCount) break;

      // Jeśli znamy liczbę stron, skanujemy do końca nawet gdy jedna strona nie da nowych linków.
      // Bez znanej liczby stron kończymy dopiero po dwóch kolejnych pustych stronach.
      if (!totalPages && page > firstPage && consecutiveEmptyPages >= 2) break;
      await sleep(provider === 'ceneo' ? 500 : 700);
    }

    return {
      allOffers: [...allOffers.values()],
      queuedOffers: [...queuedOffers.values()],
      pagesScanned,
      skippedSeen,
      declaredCount,
      totalPages,
    };
  }

  async function fetchOfferDetails(provider, listingOffers, options, signal) {
    const total = listingOffers.length;
    const results = new Array(total);
    let nextIndex = 0;
    let processed = 0;
    let errors = 0;
    let consecutiveErrors = 0;
    let cooldownUntil = 0;

    async function maybeCooldown() {
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await sleep(wait);
    }

    async function fetchOne(listing, index, retryPass = false) {
      await maybeCooldown();
      try {
        const html = await fetchHtml(listing.url, signal, provider === 'allegro' ? 5 : 3);
        const parsed = parseOffer(provider, html, listing, options.mode);
        if (!parsed.title && listing.listingTitle) parsed.title = listing.listingTitle;
        consecutiveErrors = 0;
        return parsed;
      } catch (error) {
        consecutiveErrors += 1;
        if (provider === 'allegro' && consecutiveErrors >= 3) {
          cooldownUntil = Math.max(cooldownUntil, Date.now() + 20000);
        }
        return {
          provider,
          itemId: listing.itemId,
          title: listing.listingTitle || 'Nie udało się pobrać szczegółów',
          price: listing.listingPrice || '',
          rating: listing.rating || '',
          reviewCount: listing.reviewCount || null,
          shopsCount: listing.shopsCount || null,
          offersCount: listing.offersCount || null,
          condition: '',
          seller: '',
          sellerRating: '',
          shipping: '',
          params: listing.listingParams || {},
          parametersText: '',
          description: `Błąd pobierania${retryPass ? ' po ponownej próbie' : ''}: ${error?.message || String(error)}`,
          url: listing.url,
          error: true,
          _listingIndex: index,
        };
      }
    }

    async function worker(workerNo) {
      while (true) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const index = nextIndex;
        nextIndex += 1;
        if (index >= total) return;

        const listing = listingOffers[index];
        await setState(provider, {
          phase: provider === 'ceneo' ? 'Pobieranie danych produktów' : 'Pobieranie szczegółów ofert',
          currentItem: `${index + 1}/${total}: ${listing.listingTitle || listing.url}`,
          queued: total,
          processed,
          errors,
          percent: total ? 15 + (processed / total) * 75 : 90,
        });

        const parsed = await fetchOne(listing, index, false);
        results[index] = parsed;
        if (parsed.error) errors += 1;

        processed += 1;
        await setState(provider, {
          processed,
          errors,
          percent: total ? 15 + (processed / total) * 75 : 90,
          currentItem: `Worker ${workerNo}: ukończono ${processed}/${total}`,
        });

        const baseDelay = provider === 'allegro' ? Math.max(options.delayMs, 1000) : options.delayMs;
        await sleep(baseDelay);
      }
    }

    const safeConcurrency = provider === 'allegro'
      ? Math.max(1, Math.min(options.concurrency, 2))
      : Math.max(1, Math.min(options.concurrency, 5));
    const workerCount = Math.max(1, Math.min(safeConcurrency, total || 1));
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)));

    // Druga, wolniejsza próba tylko dla błędów. To szczególnie ważne dla Allegro,
    // które potrafi po kilkudziesięciu żądaniach chwilowo ograniczyć kolejne pobrania.
    const failedIndexes = results
      .map((offer, index) => offer?.error ? index : -1)
      .filter((index) => index >= 0);

    if (failedIndexes.length && !signal.aborted) {
      await setState(provider, {
        phase: `Ponawianie ${failedIndexes.length} błędów`,
        currentItem: provider === 'allegro' ? 'Dłuższa przerwa przed ponowną próbą' : 'Ponowna próba pobierania',
        percent: 91,
      });
      await sleep(provider === 'allegro' ? 15000 : 3000);

      let retried = 0;
      for (const index of failedIndexes) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const listing = listingOffers[index];
        await setState(provider, {
          phase: `Ponawianie błędów ${retried + 1}/${failedIndexes.length}`,
          currentItem: listing.listingTitle || listing.url,
          percent: 91 + ((retried / failedIndexes.length) * 5),
        });

        const parsed = await fetchOne(listing, index, true);
        if (!parsed.error) {
          results[index] = parsed;
          errors -= 1;
        } else {
          results[index] = parsed;
        }
        retried += 1;
        await sleep(provider === 'allegro' ? Math.max(2500, options.delayMs * 2) : Math.max(1200, options.delayMs));
      }
    }

    return { offers: results.filter(Boolean), errors };
  }

  async function run(options) {
    const controller = new AbortController();
    job = { controller };

    const sourceUrl = location.href;
    const provider = detectProvider(sourceUrl);
    const startedAt = Date.now();

    if (!provider) {
      job = null;
      throw new Error('Obsługiwane są tylko Allegro i Ceneo.');
    }

    const stateStorageKey = stateKey(provider);
    const resultStorageKey = resultKey(provider);
    await chrome.storage.local.remove(resultStorageKey);
    await chrome.storage.local.set({
      [stateStorageKey]: {
        running: true,
        done: false,
        failed: false,
        provider,
        phase: 'Start',
        pagesScanned: 0,
        offersFound: 0,
        queued: 0,
        skippedSeen: 0,
        processed: 0,
        errors: 0,
        declaredCount: null,
        totalPages: null,
        currentItem: sourceUrl,
        percent: 0,
        startedAt,
        updatedAt: startedAt,
      },
    });

    try {
      const history = await getHistory(provider);
      const seenIds = new Set(Object.keys(history.items || {}));
      const scanResult = await scanListingPages(provider, sourceUrl, options, controller.signal, seenIds);
      const listingOffers = scanResult.queuedOffers;

      if (!scanResult.allOffers.length) {
        throw new Error(`Nie znaleziono pozycji na stronie ${providerLabel(provider)}. Otwórz stronę kategorii/wyników z ustawionymi filtrami.`);
      }

      if (!listingOffers.length) {
        const emptyDiagnostics = {
          discoveredCount: scanResult.allOffers.length,
          declaredCount: scanResult.declaredCount,
          totalPages: scanResult.totalPages,
          skippedSeen: scanResult.skippedSeen,
          successCount: 0,
          errorCount: 0,
        };
        const emptyResult = buildExport([], sourceUrl, options.mode, provider, emptyDiagnostics);
        emptyResult.skippedSeen = scanResult.skippedSeen;
        emptyResult.discoveredCount = scanResult.allOffers.length;
        emptyResult.declaredCount = scanResult.declaredCount;
        emptyResult.totalPages = scanResult.totalPages;
        await chrome.storage.local.set({ [resultStorageKey]: emptyResult });
        await setState(provider, {
          running: false,
          done: true,
          failed: false,
          phase: 'Gotowe, brak nowych pozycji',
          offersFound: scanResult.allOffers.length,
          queued: 0,
          skippedSeen: scanResult.skippedSeen,
          processed: 0,
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
        percent: 15,
        currentItem: `Znaleziono ${scanResult.allOffers.length}, do pobrania ${listingOffers.length}, pominięto ${scanResult.skippedSeen}`,
      });

      const detailResult = await fetchOfferDetails(provider, listingOffers, options, controller.signal);

      await setState(provider, {
        phase: 'Budowanie eksportu',
        currentItem: 'Dzielę wynik na fragmenty do ChatGPT',
        percent: 97,
      });

      const diagnostics = {
        discoveredCount: scanResult.allOffers.length,
        declaredCount: scanResult.declaredCount,
        totalPages: scanResult.totalPages,
        skippedSeen: scanResult.skippedSeen,
        successCount: detailResult.offers.filter((offer) => !offer.error).length,
        errorCount: detailResult.errors,
      };
      const result = buildExport(detailResult.offers, sourceUrl, options.mode, provider, diagnostics);
      result.skippedSeen = scanResult.skippedSeen;
      result.discoveredCount = scanResult.allOffers.length;
      result.declaredCount = scanResult.declaredCount;
      result.totalPages = scanResult.totalPages;
      result.successCount = detailResult.offers.filter((offer) => !offer.error).length;
      result.errorCount = detailResult.errors;
      await chrome.storage.local.set({ [resultStorageKey]: result });

      // Do historii trafiają wyłącznie pozycje pobrane poprawnie. Błędy zostają do ponowienia.
      await addSuccessfulOffersToHistory(provider, detailResult.offers);

      await setState(provider, {
        running: false,
        done: true,
        failed: false,
        phase: detailResult.errors ? 'Gotowe z błędami' : 'Gotowe',
        processed: detailResult.offers.length,
        errors: detailResult.errors,
        currentItem: `${result.successCount} poprawnie, ${detailResult.errors} błędów, ${result.chunks.length} fragmentów`,
        percent: 100,
        finishedAt: Date.now(),
      });
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      await setState(provider, {
        running: false,
        done: false,
        failed: !aborted,
        phase: aborted ? 'Przerwano' : 'Błąd',
        currentItem: aborted ? 'Eksport przerwany przez użytkownika.' : (error?.message || String(error)),
        finishedAt: Date.now(),
      });
    } finally {
      job = null;
    }
  }

  async function migrateLegacyStorage() {
    const legacy = await chrome.storage.local.get([LEGACY_STORAGE_STATE, LEGACY_STORAGE_RESULT]);
    const oldResult = legacy[LEGACY_STORAGE_RESULT];
    if (oldResult?.provider && (oldResult.provider === 'allegro' || oldResult.provider === 'ceneo')) {
      const provider = oldResult.provider;
      const newResultKey = resultKey(provider);
      const existing = (await chrome.storage.local.get(newResultKey))[newResultKey];
      if (!existing) await chrome.storage.local.set({ [newResultKey]: oldResult });
      await addSuccessfulOffersToHistory(provider, oldResult.offers || []);
    }

    const oldState = legacy[LEGACY_STORAGE_STATE];
    if (oldState?.provider && (oldState.provider === 'allegro' || oldState.provider === 'ceneo')) {
      const provider = oldState.provider;
      const newStateKey = stateKey(provider);
      const existing = (await chrome.storage.local.get(newStateKey))[newStateKey];
      if (!existing) await chrome.storage.local.set({ [newStateKey]: oldState });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'MARKETPLACE_EXPORTER_START' || message?.type === 'ALLEGRO_EXPORTER_START') {
      if (job) {
        sendResponse({ ok: false, error: 'Eksport już trwa na tej karcie.' });
        return false;
      }

      const provider = detectProvider(location.href);
      const options = {
        startFromFirst: message.options?.startFromFirst !== false,
        mode: message.options?.mode === 'full' ? 'full' : 'compact',
        maxOffers: Math.max(0, Number(message.options?.maxOffers || 0)),
        concurrency: Math.max(1, Math.min(5, Number(message.options?.concurrency || (provider === 'allegro' ? 1 : 2)))),
        delayMs: Math.max(200, Number(message.options?.delayMs || (provider === 'allegro' ? 1200 : 600))),
        skipSeen: message.options?.skipSeen !== false,
      };

      run(options).catch(async (error) => {
        const providerNow = detectProvider(location.href);
        if (providerNow) {
          await setState(providerNow, {
            running: false,
            done: false,
            failed: true,
            phase: 'Błąd',
            currentItem: error?.message || String(error),
          });
        }
      });
      sendResponse({ ok: true, provider });
      return false;
    }

    if (message?.type === 'MARKETPLACE_EXPORTER_STOP' || message?.type === 'ALLEGRO_EXPORTER_STOP') {
      if (job?.controller) job.controller.abort();
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'MARKETPLACE_EXPORTER_PING') {
      sendResponse({ ok: true, provider: detectProvider(location.href), running: Boolean(job) });
      return false;
    }

    sendResponse({ ok: false, error: 'Nieznany komunikat.' });
    return false;
  });

  migrateLegacyStorage().catch(() => {});
})();
