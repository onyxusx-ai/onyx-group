export function platformFromHostname(hostname) {
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

export function normalizeUrl(value, baseUrl) {
  const input = String(value || '').trim();
  if (!input || input.startsWith('data:') || input.startsWith('blob:')) return '';
  try {
    return new URL(input.startsWith('//') ? `https:${input}` : input, baseUrl).href;
  } catch {
    return '';
  }
}

export function dedupeImageUrls(values, baseUrl) {
  const output = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = normalizeUrl(value, baseUrl);
    if (!normalized || /\.(svg|ico)(\?|$)/i.test(normalized)) continue;
    if (!/\.(jpe?g|png|webp|avif|gif)(\?|_|$)/i.test(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output.slice(0, 12);
}

export function pickJsonLdProduct(values) {
  const queue = [...(Array.isArray(values) ? values : [values])];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object') continue;
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.some((type) => String(type).toLowerCase() === 'product')) return value;
    if (Array.isArray(value['@graph'])) queue.push(...value['@graph']);
  }
  return null;
}

export function parseNumericPrice(value) {
  const cleaned = String(value || '').replace(/\s+/g, '').replace(',', '.');
  const match = cleaned.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}
