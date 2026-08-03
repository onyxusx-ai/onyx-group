const $ = (id) => document.getElementById(id);
let importedListing = null;

function apiBase() {
  return String(localStorage.getItem('onyx_api_base') || window.ONYX_CONFIG?.API_BASE || '').trim().replace(/\/+$/, '');
}
function adminToken() { return String(localStorage.getItem('onyx_admin_token') || '').trim(); }
function setStatus(element, text, kind = '') { element.textContent = text; element.className = `status ${kind}`.trim(); }
function toast(text) { $('toast').textContent = text; $('toast').classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').classList.remove('show'), 2200); }
function absoluteUrl(value) { try { return new URL(value, `${apiBase()}/`).href; } catch { return value; } }
function encodePayload(value) { return btoa(unescape(encodeURIComponent(JSON.stringify(value)))); }
function decodePayload(value) { return JSON.parse(decodeURIComponent(escape(atob(value)))); }

function buildBookmarklet() {
  const adminUrl = new URL('admin.html', location.href).href.split('#')[0];
  const code = `(function(){try{var q=function(s){var e=document.querySelector(s);return e&&(e.content||e.textContent||'').trim()||''},a=[],add=function(v){if(!v)return;if(Array.isArray(v)){v.forEach(add);return}if(typeof v==='string')a.push(v)},j=null;document.querySelectorAll('script[type="application/ld+json"]').forEach(function(s){try{var x=JSON.parse(s.textContent),z=Array.isArray(x)?x:[x];z.forEach(function(v){if(v&&String(v['@type']).toLowerCase()==='product')j=v;if(v&&Array.isArray(v['@graph']))v['@graph'].forEach(function(g){if(g&&String(g['@type']).toLowerCase()==='product')j=g})})}catch(e){}});add(j&&j.image);add(q('meta[property="og:image"]'));document.querySelectorAll('img').forEach(function(i){var r=i.getBoundingClientRect(),w=i.naturalWidth||r.width,h=i.naturalHeight||r.height;if(w>=280&&h>=280)add(i.currentSrc||i.src||i.dataset.src||i.dataset.lazySrc)});var seen={},imgs=a.map(function(v){try{return new URL(String(v).indexOf('//')===0?'https:'+v:v,location.href).href}catch(e){return''}}).filter(function(v){if(!v||v.indexOf('data:')===0||/\\.(svg|ico)(\\?|$)/i.test(v)||seen[v])return false;seen[v]=1;return true}).slice(0,12),p={sourceUrl:location.href,platform:location.hostname,title:(j&&j.name)||q('meta[property="og:title"]')||q('h1')||document.title,description:(j&&j.description)||q('meta[name="description"]')||q('meta[property="og:description"]'),priceText:q('meta[property="product:price:amount"]')||q('[class*="price--current"]')||q('[class*="product-price"]')||'',images:imgs};location.href=${JSON.stringify(adminUrl)}+'#import='+encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(p)))))}catch(e){alert('ONYX: '+e.message)}})()`;
  $('bookmarkletLink').href = `javascript:${code}`;
}

function fillImportForm(data) {
  importedListing = data;
  $('sourceUrl').value = data.sourceUrl || '';
  $('platform').value = data.platform || '';
  $('title').value = data.title || '';
  $('description').value = data.description || '';
  $('priceText').value = data.priceText || '';
  $('images').value = (data.images || []).join('\n');
  renderImagePreview();
  location.hash = 'import';
}

function renderImagePreview() {
  const urls = $('images').value.split(/\n+/).map((value) => value.trim()).filter(Boolean).slice(0, 12);
  $('imagePreview').innerHTML = urls.map((url) => `<img src="${url.replace(/"/g, '&quot;')}" alt="Фото объявления" referrerpolicy="no-referrer">`).join('');
}

async function saveAndCheck() {
  const base = $('apiBase').value.trim().replace(/\/+$/, '');
  const token = $('adminToken').value.trim();
  localStorage.setItem('onyx_api_base', base);
  localStorage.setItem('onyx_admin_token', token);
  if (!base) { setStatus($('connectionStatus'), 'Укажи Worker URL', 'error'); return; }
  setStatus($('connectionStatus'), 'Проверяю…');
  try {
    const response = await fetch(`${base}/health`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `Ошибка ${response.status}`);
    setStatus($('connectionStatus'), 'Worker подключён', 'success');
    toast('Подключение сохранено');
    loadCatalog();
  } catch (error) {
    setStatus($('connectionStatus'), error.message, 'error');
  }
}

async function importProduct(event) {
  event.preventDefault();
  const base = apiBase();
  const token = adminToken();
  if (!base || !token) { setStatus($('importStatus'), 'Сначала сохрани Worker URL и admin token.', 'error'); return; }

  const payload = {
    sourceUrl: $('sourceUrl').value.trim(),
    platform: $('platform').value.trim(),
    title: $('title').value.trim(),
    sourceTitle: $('title').value.trim(),
    description: $('description').value.trim(),
    priceText: $('priceText').value.trim(),
    priceCny: Number($('priceCny').value.replace(',', '.')) || 0,
    priceRub: Number($('priceRub').value.replace(/\s/g, '')) || 0,
    category: $('category').value,
    type: $('type').value.trim() || 'Товар',
    badge: $('badge').value.trim() || 'LIVE',
    deliveryDays: '20–25',
    images: $('images').value.split(/\n+/).map((value) => value.trim()).filter(Boolean),
  };

  $('importButton').disabled = true;
  setStatus($('importStatus'), 'Worker копирует точные фотографии объявления…');
  try {
    const response = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `Ошибка ${response.status}`);
    setStatus($('importStatus'), `Товар добавлен. Сохранено фотографий: ${data.product.images.length}.`, 'success');
    toast('Товар появился в витрине');
    await loadCatalog();
  } catch (error) {
    setStatus($('importStatus'), error.message, 'error');
  } finally {
    $('importButton').disabled = false;
  }
}

async function loadCatalog() {
  const base = apiBase();
  if (!base) { $('catalogGrid').innerHTML = '<p class="status">Сначала подключи Worker.</p>'; return; }
  $('catalogGrid').innerHTML = '<p class="status">Загрузка…</p>';
  try {
    const response = await fetch(`${base}/api/products`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `Ошибка ${response.status}`);
    const products = data.products || [];
    $('catalogGrid').innerHTML = products.length ? products.map((product) => `
      <article class="admin-product">
        <img src="${absoluteUrl(product.images?.[0] || '')}" alt="${String(product.title || '').replace(/"/g, '&quot;')}">
        <div class="admin-product-body">
          <small>${product.platform || 'Marketplace'} · ${product.priceText || 'Цена на площадке'}</small>
          <h3>${product.title || 'Товар'}</h3>
          <div class="admin-product-actions">
            <a class="ghost" href="${product.sourceUrl}" target="_blank" rel="noopener">Источник</a>
            <button class="danger" data-delete-id="${product.id}">Удалить</button>
          </div>
        </div>
      </article>`).join('') : '<p class="status">Каталог пуст. Импортируй первое объявление.</p>';
  } catch (error) {
    $('catalogGrid').innerHTML = `<p class="status error">${error.message}</p>`;
  }
}

async function deleteProduct(id) {
  if (!confirm('Удалить товар и его фотографии из ONYX?')) return;
  try {
    const response = await fetch(`${apiBase()}/api/products/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken()}` } });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `Ошибка ${response.status}`);
    toast('Товар удалён');
    loadCatalog();
  } catch (error) { toast(error.message); }
}

function clearImport() {
  $('importForm').reset();
  $('type').value = 'Товар'; $('badge').value = 'LIVE'; $('imagePreview').innerHTML = ''; importedListing = null;
  history.replaceState(null, '', location.pathname + location.search);
}

function loadHashImport() {
  const match = location.hash.match(/^#import=(.+)$/);
  if (!match) return;
  try { fillImportForm(decodePayload(decodeURIComponent(match[1]))); }
  catch (error) { setStatus($('importStatus'), `Не удалось прочитать объявление: ${error.message}`, 'error'); }
}

$('apiBase').value = apiBase();
$('adminToken').value = adminToken();
$('saveSettings').addEventListener('click', saveAndCheck);
$('importForm').addEventListener('submit', importProduct);
$('images').addEventListener('input', renderImagePreview);
$('reloadCatalog').addEventListener('click', loadCatalog);
$('clearImport').addEventListener('click', clearImport);
$('catalogGrid').addEventListener('click', (event) => { const button = event.target.closest('[data-delete-id]'); if (button) deleteProduct(button.dataset.deleteId); });
buildBookmarklet();
loadHashImport();
if (apiBase()) saveAndCheck();
