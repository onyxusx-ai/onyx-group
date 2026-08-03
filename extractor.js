(() => {
  if (globalThis.__ONYX_EXTRACTOR_INSTALLED__) return;
  globalThis.__ONYX_EXTRACTOR_INSTALLED__ = true;

  function textFrom(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = element?.getAttribute?.('content') || element?.textContent;
      if (value && value.trim()) return value.trim();
    }
    return '';
  }

  function platformFromHostname(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (host.includes('aliexpress')) return 'AliExpress';
    if (host === '1688.com' || host.endsWith('.1688.com')) return '1688';
    if (host === 'taobao.com' || host.endsWith('.taobao.com')) return 'Taobao';
    if (host === 'tmall.com' || host.endsWith('.tmall.com')) return 'Tmall';
    if (host === 'alibaba.com' || host.endsWith('.alibaba.com')) return 'Alibaba';
    if (host.includes('yangkeduo') || host.includes('pinduoduo')) return 'Pinduoduo';
    if (host.includes('poizon') || host.includes('dewu')) return 'Poizon';
    return host.replace(/^www\./, '') || 'Marketplace';
  }

  function normalizeUrl(value) {
    const input = String(value || '').trim();
    if (!input || input.startsWith('data:') || input.startsWith('blob:')) return '';
    try {
      return new URL(input.startsWith('//') ? `https:${input}` : input, location.href).href;
    } catch {
      return '';
    }
  }

  function jsonLdProducts() {
    const values = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const parsed = JSON.parse(script.textContent || 'null');
        values.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {}
    });

    const queue = [...values];
    while (queue.length) {
      const value = queue.shift();
      if (!value || typeof value !== 'object') continue;
      const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
      if (types.some((type) => String(type).toLowerCase() === 'product')) return value;
      if (Array.isArray(value['@graph'])) queue.push(...value['@graph']);
    }
    return null;
  }

  function imageCandidates(productJson) {
    const values = [];
    const add = (value) => {
      if (Array.isArray(value)) value.forEach(add);
      else if (typeof value === 'string') values.push(value);
      else if (value && typeof value === 'object') add(value.url || value.contentUrl);
    };

    add(productJson?.image);
    add(document.querySelector('meta[property="og:image"]')?.content);
    add(document.querySelector('meta[name="twitter:image"]')?.content);

    const marketplaceSelectors = [
      '[class*="image-view"] img', '[class*="imageViewer"] img', '[class*="gallery"] img',
      '[class*="thumbnail"] img', '[class*="slider"] img', '[data-pl="product-image"] img',
      '.magnifier-image', '.main-img img', '#J_ImgBooth', '.tb-main-pic img', '.detail-gallery img',
    ];
    marketplaceSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((img) => {
        add(img.currentSrc || img.src || img.dataset.src || img.dataset.lazyload || img.getAttribute('data-lazy-src'));
        const srcset = img.getAttribute('srcset');
        if (srcset) add(srcset.split(',').at(-1)?.trim().split(/\s+/)[0]);
      });
    });

    document.querySelectorAll('img').forEach((img) => {
      const rect = img.getBoundingClientRect();
      const width = img.naturalWidth || rect.width;
      const height = img.naturalHeight || rect.height;
      if (width >= 280 && height >= 280) add(img.currentSrc || img.src || img.dataset.src || img.dataset.lazySrc);
    });

    const seen = new Set();
    return values.map(normalizeUrl).filter((url) => {
      if (!url || /\.(svg|ico)(\?|$)/i.test(url)) return false;
      if (!/\.(jpe?g|png|webp|avif|gif)(\?|_|$)/i.test(url)) return false;
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    }).slice(0, 12);
  }

  function priceFrom(productJson) {
    const offer = Array.isArray(productJson?.offers) ? productJson.offers[0] : productJson?.offers;
    return String(
      offer?.price ||
      offer?.lowPrice ||
      textFrom([
        'meta[property="product:price:amount"]',
        '[class*="price--current"]', '[class*="product-price"]', '[class*="priceText"]',
        '.uniform-banner-box-price', '.price--currentPriceText--', '#J_PromoPriceNum', '.tb-rmb-num',
      ])
    ).trim();
  }

  function extract() {
    const productJson = jsonLdProducts();
    const title = String(
      productJson?.name ||
      textFrom(['meta[property="og:title"]', 'h1', '[class*="product-title"]', '[class*="title--wrap"]']) ||
      document.title
    ).replace(/\s+/g, ' ').trim();

    const description = String(
      productJson?.description ||
      textFrom(['meta[name="description"]', 'meta[property="og:description"]', '[class*="product-description"]'])
    ).replace(/\s+/g, ' ').trim();

    return {
      sourceUrl: location.href,
      platform: platformFromHostname(location.hostname),
      title,
      sourceTitle: title,
      description,
      priceText: priceFrom(productJson),
      images: imageCandidates(productJson),
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'ONYX_EXTRACT_LISTING') return;
    try {
      sendResponse({ ok: true, listing: extract() });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
})();
