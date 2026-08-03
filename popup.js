let listing = null;
const $ = (id) => document.getElementById(id);

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function setStatus(message, type = '') {
  $('status').textContent = message;
  $('status').className = `status ${type}`.trim();
}

async function loadSettings() {
  const values = await chrome.storage.local.get(['apiBase', 'adminToken']);
  $('apiBase').value = values.apiBase || '';
  $('adminToken').value = values.adminToken || '';
}

async function saveSettings() {
  await chrome.storage.local.set({
    apiBase: normalizeBase($('apiBase').value),
    adminToken: $('adminToken').value.trim(),
  });
  setStatus('Подключение сохранено.', 'success');
}

async function sendExtract(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'ONYX_EXTRACT_LISTING' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['extractor.js'] });
    return chrome.tabs.sendMessage(tabId, { type: 'ONYX_EXTRACT_LISTING' });
  }
}

function fillPreview(value) {
  listing = value;
  $('title').value = value.title || '';
  $('platform').value = value.platform || '';
  $('priceText').value = value.priceText || '';
  $('description').value = value.description || '';
  $('priceCny').value = '';
  $('priceRub').value = '';
  $('imageSummary').textContent = `Найдено точных фотографий объявления: ${(value.images || []).length}`;
  $('preview').hidden = false;
}

async function extractListing() {
  setStatus('Считываю объявление…');
  $('extractButton').disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Открой страницу товара в обычной вкладке.');
    const response = await sendExtract(tab.id);
    if (!response?.ok) throw new Error(response?.error || 'Не удалось считать страницу.');
    if (!(response.listing.images || []).length) throw new Error('Фотографии объявления не найдены. Прокрути галерею товара и повтори.');
    fillPreview(response.listing);
    setStatus('Объявление считано. Проверь данные и добавь товар.', 'success');
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  } finally {
    $('extractButton').disabled = false;
  }
}

async function importListing() {
  if (!listing) return;
  const apiBase = normalizeBase($('apiBase').value);
  const token = $('adminToken').value.trim();
  if (!apiBase || !token) {
    $('settingsBox').open = true;
    setStatus('Сначала укажи Worker URL и admin token.', 'error');
    return;
  }

  const payload = {
    ...listing,
    title: $('title').value.trim(),
    sourceTitle: $('title').value.trim(),
    platform: $('platform').value.trim(),
    priceText: $('priceText').value.trim(),
    priceCny: Number(String($('priceCny').value).replace(',', '.')) || 0,
    priceRub: Number(String($('priceRub').value).replace(/\s/g, '')) || 0,
    category: $('category').value,
    type: $('type').value.trim() || 'Товар',
    description: $('description').value.trim(),
    badge: 'LIVE',
    deliveryDays: '20–25',
  };

  $('importButton').disabled = true;
  setStatus('Worker копирует фотографии объявления в ONYX…');
  try {
    const response = await fetch(`${apiBase}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `Ошибка ${response.status}`);
    setStatus(`Готово. Сохранено фото: ${data.product.images.length}.`, 'success');
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  } finally {
    $('importButton').disabled = false;
  }
}

$('saveSettings').addEventListener('click', saveSettings);
$('extractButton').addEventListener('click', extractListing);
$('importButton').addEventListener('click', importListing);
loadSettings();
