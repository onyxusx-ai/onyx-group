const PRIVATE_IPV4_PATTERNS = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^0\./,
];

export function detectPlatform(input) {
  let host = '';
  try {
    host = new URL(input).hostname.toLowerCase();
  } catch {
    return 'Marketplace';
  }

  if (host.includes('aliexpress')) return 'AliExpress';
  if (host === '1688.com' || host.endsWith('.1688.com')) return '1688';
  if (host === 'taobao.com' || host.endsWith('.taobao.com')) return 'Taobao';
  if (host === 'tmall.com' || host.endsWith('.tmall.com')) return 'Tmall';
  if (host === 'alibaba.com' || host.endsWith('.alibaba.com')) return 'Alibaba';
  if (host.includes('yangkeduo') || host.includes('pinduoduo')) return 'Pinduoduo';
  if (host.includes('poizon') || host.includes('dewu')) return 'Poizon';
  return host.replace(/^www\./, '') || 'Marketplace';
}

export function normalizeImageUrl(input, baseUrl = '') {
  const value = String(input || '').trim();
  if (!value || value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('javascript:')) return '';

  try {
    if (value.startsWith('//')) return new URL(`https:${value}`).href;
    return new URL(value, baseUrl || undefined).href;
  } catch {
    return '';
  }
}

export function isSafeRemoteUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host === '::1') return false;
  if (PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(host))) return false;
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return false;
  return true;
}

function absoluteMediaUrl(value, apiBase) {
  if (!value) return '';
  try {
    return new URL(value, apiBase.endsWith('/') ? apiBase : `${apiBase}/`).href;
  } catch {
    return value;
  }
}

export function mapApiProduct(raw, apiBase) {
  const images = Array.isArray(raw.images) ? raw.images.map((value) => absoluteMediaUrl(value, apiBase)).filter(Boolean) : [];
  const priceCny = Number(raw.priceCny || 0);
  const priceRub = Number(raw.priceRub || 0);

  return {
    id: raw.id,
    name: raw.title || raw.name || 'Товар из Китая',
    category: raw.category || 'accessories',
    source: raw.platform || raw.source || detectPlatform(raw.sourceUrl || ''),
    type: raw.type || 'Товар',
    priceCny,
    priceRub,
    badge: raw.badge || 'LIVE',
    deliveryDays: raw.deliveryDays || '20–25',
    description: raw.description || '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    sizes: Array.isArray(raw.sizes) ? raw.sizes : [],
    colors: Array.isArray(raw.colors) ? raw.colors : [],
    quick: Array.isArray(raw.quick) ? raw.quick : ['hot'],
    visual: raw.title || raw.name || 'ONYX PRODUCT',
    image: images[0] || '',
    images,
    sourceTitle: raw.sourceTitle || raw.title || raw.name || '',
    sourcePriceText: raw.priceText || 'Цена на площадке',
    sourceUrl: raw.sourceUrl || '',
    imageKind: 'marketplace-listing-exact',
    createdAt: raw.createdAt || '',
  };
}
