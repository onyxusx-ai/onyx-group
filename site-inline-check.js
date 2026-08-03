
    const PUBLIC_TELEGRAM_URL = "https://t.me/onyxgrouptg";
    const ORDER_TELEGRAM_USERNAME = "onyxgroupadmin";
    const ORDER_TELEGRAM_URL = "https://t.me/onyxgroupadmin";
    const MARKETPLACES = {
      alibaba: { name: "Alibaba", home: "https://www.alibaba.com/", search: query => `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(query)}` },
      "1688": { name: "1688", home: "https://www.1688.com/", search: query => `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(query)}` },
      taobao: { name: "Taobao", home: "https://www.taobao.com/", search: query => `https://s.taobao.com/search?q=${encodeURIComponent(query)}` },
      aliexpress: { name: "AliExpress", home: "https://www.aliexpress.com/", search: query => `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(query)}` },
      poizon: { name: "Poizon", home: "https://www.poizon.com/", search: null },
      pinduoduo: { name: "Pinduoduo", home: "https://www.pinduoduo.com/", search: null }
    };
    const SOURCE_TO_MARKETPLACE = { Alibaba: "alibaba", "1688": "1688", Taobao: "taobao", AliExpress: "aliexpress", Poizon: "poizon", Pinduoduo: "pinduoduo" };
    const MANAGER_PIN = "2026";
    const SITE_CONFIG = window.ONYX_CONFIG || {};
    const ONYX_API_BASE = String(localStorage.getItem("onyx_api_base") || SITE_CONFIG.API_BASE || "").trim().replace(/\/+$/, "");
    const TRACKING_API_BASE = (document.querySelector('meta[name="tracking-api"]')?.content || ONYX_API_BASE || "").trim().replace(/\/+$/, "");
    const USE_DEMO_CATALOG = Boolean(SITE_CONFIG.USE_DEMO_CATALOG);

    const STATIC_PRODUCTS = [];


    let products = [];
    let catalogLoadState = "idle";

    function calculateLivePriceRub(priceCny) {
      const itemRub = Math.max(0, Number(priceCny || 0)) * 13;
      const commission = itemRub >= 150000 ? itemRub * 0.07 : itemRub >= 50000 ? itemRub * 0.10 : itemRub * 0.20;
      return Math.round(itemRub + Math.max(350, commission) + 900);
    }

    function absoluteApiUrl(value) {
      if (!value || !ONYX_API_BASE) return value || "";
      try {
        return new URL(value, `${ONYX_API_BASE}/`).href;
      } catch {
        return value;
      }
    }

    function mapLiveProduct(raw) {
      const images = Array.isArray(raw.images) ? raw.images.map(absoluteApiUrl).filter(Boolean) : [];
      const priceCny = Number(raw.priceCny || 0);
      return {
        id: String(raw.id),
        name: raw.title || raw.name || "Товар из Китая",
        category: raw.category || "accessories",
        source: raw.platform || raw.source || "Marketplace",
        type: raw.type || "Товар",
        priceCny,
        priceRub: Number(raw.priceRub || 0) || calculateLivePriceRub(priceCny),
        badge: raw.badge || "LIVE",
        deliveryDays: raw.deliveryDays || "20–25",
        description: raw.description || "",
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        sizes: Array.isArray(raw.sizes) ? raw.sizes : [],
        colors: Array.isArray(raw.colors) ? raw.colors : [],
        quick: Array.isArray(raw.quick) ? raw.quick : ["hot"],
        visual: raw.title || raw.name || "ONYX PRODUCT",
        image: images[0] || "",
        images,
        sourceTitle: raw.sourceTitle || raw.title || raw.name || "",
        sourcePriceText: raw.priceText || "Цена на площадке",
        sourceUrl: raw.sourceUrl || "",
        imageKind: "marketplace-listing-exact",
        createdAt: raw.createdAt || ""
      };
    }

    function setCatalogStatus(text, kind = "") {
      const element = document.getElementById("catalogConnectionStatus");
      if (!element) return;
      element.textContent = text;
      element.dataset.state = kind;
    }

    async function loadLiveCatalog() {
      catalogLoadState = "loading";
      setCatalogStatus("Подключаю живую витрину ONYX…", "loading");

      if (!ONYX_API_BASE) {
        products = USE_DEMO_CATALOG ? STATIC_PRODUCTS : [];
        catalogLoadState = "unconfigured";
        setCatalogStatus("Живая витрина ещё не подключена. Открой admin.html, укажи Worker URL и импортируй объявления — их точные фотографии появятся здесь автоматически.", "unconfigured");
        return;
      }

      try {
        const response = await fetch(`${ONYX_API_BASE}/api/products`, { headers: { accept: "application/json" } });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || `Ошибка ${response.status}`);
        products = (data.products || []).map(mapLiveProduct);
        catalogLoadState = "ready";
        setCatalogStatus(products.length
          ? `Живая витрина подключена. Товаров: ${products.length}. Фотографии скопированы непосредственно из объявлений.`
          : "Живая витрина подключена, но пока пуста. Добавь первое объявление через расширение или admin.html.", "ready");
      } catch (error) {
        products = USE_DEMO_CATALOG ? STATIC_PRODUCTS : [];
        catalogLoadState = "error";
        setCatalogStatus(`Не удалось подключить витрину: ${error.message}. Проверь Worker URL в admin.html.`, "error");
      }
    }

    const deliveryRates = {
      standard: { title: "Стандарт", perKg: 650, days: "20–25", base: 350 },
      fast: { title: "Быстро", perKg: 950, days: "12–18", base: 520 },
      cargo: { title: "Карго", perKg: 520, days: "25–35", base: 280 }
    };

    const SITE_CNY_RATE = 13;
    const MIN_SERVICE_FEE = 350;

    const trackingOrders = {
      "ONYX-2406": {
        code: "ONYX-2406",
        step: 3,
        status: "Склад в Китае",
        location: "Guangzhou warehouse",
        next: "Фото-проверка и упаковка",
        eta: "10–14 дней"
      },
      "ONYX-8801": {
        code: "ONYX-8801",
        step: 4,
        status: "В пути в РФ",
        location: "Карго маршрут Китай → Россия",
        next: "Прибытие на сортировку РФ",
        eta: "5–8 дней"
      },
      "ONYX-7777": {
        code: "ONYX-7777",
        step: 5,
        status: "Готов к выдаче",
        location: "Россия",
        next: "Передача клиенту",
        eta: "1–2 дня"
      }
    };

    let cart = JSON.parse(localStorage.getItem("onyx_group_cart") || "[]");
    let activeQuickFilter = "all";
    let activeCalcRoute = "standard";
    let currentProduct = null;
    let selectedSize = "";
    let selectedColor = "";
    let currentTelegramOrderMessage = "";
    let lastCalculationSummary = "";
    let introTimer = null;

    const $ = (id) => document.getElementById(id);

    const nav = $("nav");
    const burger = $("burger");
    const overlay = $("overlay");
    const productGrid = $("productGrid");
    const globalSearch = $("globalSearch");
    const mainCategoryFilter = $("mainCategoryFilter");
    const sourceFilter = $("sourceFilter");
    const priceFilter = $("priceFilter");
    const sortFilter = $("sortFilter");
    const cartCount = $("cartCount");
    const cartDrawer = $("cartDrawer");
    const cartItems = $("cartItems");
    const cartTotal = $("cartTotal");
    const productModal = $("productModal");
    const toast = $("toast");

    function formatRub(value) {
      return Math.round(Number(value) || 0).toLocaleString("ru-RU") + " ₽";
    }

    function formatCny(value) {
      return "¥" + Math.round(Number(value) || 0).toLocaleString("ru-RU");
    }

    function normalizeText(value) {
      return String(value || "").trim().toLowerCase();
    }

    function showToast(text) {
      if (!toast) return;
      toast.textContent = text;
      toast.classList.add("show");
      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
    }

    function saveCart() {
      localStorage.setItem("onyx_group_cart", JSON.stringify(cart));
    }

    function updateCartCount() {
      if (!cartCount) return;
      cartCount.textContent = cart.reduce((sum, item) => sum + item.qty, 0);
    }

    function getCartTotal() {
      return cart.reduce((sum, item) => sum + item.priceRub * item.qty, 0);
    }

    function getProductImageCandidates(product) {
      return [...new Set([...(Array.isArray(product.images) ? product.images : []), product.image].filter(Boolean))];
    }

    function handleProductImageError(img) {
      const productId = decodeURIComponent(img.dataset.productId || "");
      const product = products.find(item => String(item.id) === String(productId));
      if (!product) return;

      const candidates = getProductImageCandidates(product);
      const currentIndex = Number(img.dataset.imageIndex || 0);
      const nextIndex = currentIndex + 1;

      if (nextIndex < candidates.length) {
        img.dataset.imageIndex = String(nextIndex);
        img.src = candidates[nextIndex];
        return;
      }

      img.hidden = true;
      const shell = img.closest(".product-photo-shell");
      if (shell) shell.classList.add("is-fallback");
    }

    function makeVisualHTML(product, size = "card") {
      const candidates = getProductImageCandidates(product);
      const firstImage = candidates[0] || "";
      const label = product.visual || product.name;
      const thumbnails = size === "modal" && candidates.length > 1
        ? `<div class="modal-photo-thumbs">${candidates.map((url, index) => `<button type="button" class="modal-photo-thumb ${index === 0 ? "active" : ""}" onclick="switchProductPhoto(this, '${encodeURIComponent(url)}')"><img src="${url}" alt="Фото ${index + 1}" loading="lazy"></button>`).join("")}</div>`
        : "";
      return `
        <div class="product-photo-shell ${size === "modal" ? "product-photo-shell--modal" : ""}">
          <img
            class="product-photo"
            src="${firstImage}"
            alt="${product.name} — точное фото объявления"
            loading="${size === "modal" ? "eager" : "lazy"}"
            decoding="async"
            data-product-id="${encodeURIComponent(String(product.id))}"
            data-image-index="0"
            onerror="handleProductImageError(this)"
          >
          <div class="product-photo-fallback"><span>${label}</span><small>Фото временно недоступно — открой карточку источника</small></div>
          <div class="product-photo-note">Фото из конкретного объявления</div>
          ${thumbnails}
        </div>
      `;
    }

    function switchProductPhoto(button, encodedUrl) {
      const shell = button.closest(".product-photo-shell");
      const mainImage = shell?.querySelector(".product-photo");
      if (!mainImage) return;
      mainImage.src = decodeURIComponent(encodedUrl);
      shell.querySelectorAll(".modal-photo-thumb").forEach(item => item.classList.toggle("active", item === button));
    }

    function makeProductCard(product) {
      const encodedProductId = encodeURIComponent(String(product.id));
      const chips = [
        product.sourcePriceText,
        `${product.deliveryDays} дней`,
        "Карточка источника"
      ].filter(Boolean).map(item => `<span class="chip">${item}</span>`).join("");

      return `
        <article class="product-card reveal">
          <div class="product-media">
            <span class="product-badge">${product.badge}</span>
            <span class="source-badge">${product.source}</span>
            <div class="fake-product-visual">${makeVisualHTML(product)}</div>
          </div>

          <div class="product-body">
            <div class="product-meta">
              <span>${product.type}</span>
              <span>ориентир ${formatCny(product.priceCny)}</span>
            </div>
            <h3 class="product-title">${product.name}</h3>
            <p class="product-source-title">${product.sourceTitle}</p>
            <p class="product-desc">${product.description}</p>
            <div class="product-chips">${chips}</div>

            <div class="price-area">
              <div class="price-row">
                <strong class="price-main">${formatRub(product.priceRub)}</strong>
                <span class="price-cny">примерно с сервисом</span>
              </div>

              <button class="product-source-link" type="button" onclick="openProductSource(decodeURIComponent('${encodedProductId}'))">Открыть карточку на ${product.source} ↗</button>
              <div class="product-actions">
                <button class="secondary-btn" onclick="openProductModal(decodeURIComponent('${encodedProductId}'))">Подробнее</button>
                <button class="primary-btn" onclick="startOnyxOrder(decodeURIComponent('${encodedProductId}'))">В заявку</button>
              </div>
            </div>
          </div>
        </article>
      `;
    }

    function getFilteredProducts() {
      const search = normalizeText(globalSearch ? globalSearch.value : "");
      const category = mainCategoryFilter ? mainCategoryFilter.value : "all";
      const source = sourceFilter ? sourceFilter.value : "all";
      const price = priceFilter ? priceFilter.value : "all";
      const sort = sortFilter ? sortFilter.value : "default";

      let filtered = products.filter(product => {
        const haystack = normalizeText([
          product.name,
          product.category,
          product.source,
          product.type,
          product.badge,
          product.description,
          ...(product.tags || [])
        ].join(" "));

        const matchesSearch = !search || haystack.includes(search);
        const matchesCategory = category === "all" || product.category === category;
        const matchesSource = source === "all" || product.source === source;

        let matchesPrice = true;
        if (price === "under2000") matchesPrice = product.priceRub <= 2000;
        if (price === "under5000") matchesPrice = product.priceRub <= 5000;
        if (price === "premium") matchesPrice = product.priceRub >= 5000;

        let matchesQuick = true;
        if (activeQuickFilter !== "all") {
          if (activeQuickFilter === "low") matchesQuick = product.priceRub <= 3000;
          else matchesQuick = (product.quick || []).includes(activeQuickFilter);
        }

        return matchesSearch && matchesCategory && matchesSource && matchesPrice && matchesQuick;
      });

      if (sort === "priceAsc") filtered.sort((a, b) => a.priceRub - b.priceRub);
      if (sort === "priceDesc") filtered.sort((a, b) => b.priceRub - a.priceRub);
      if (sort === "ratingDesc") filtered.sort((a, b) => b.rating - a.rating);
      if (sort === "ordersDesc") filtered.sort((a, b) => b.orders - a.orders);

      return filtered;
    }

    function renderProducts() {
      if (!productGrid) return;

      const list = getFilteredProducts();

      if (!list.length) {
        productGrid.innerHTML = `<div class="empty-state live-catalog-empty" style="grid-column:1/-1;">
          <strong>${catalogLoadState === "ready" ? "Витрина пока пуста" : "Товары не найдены"}</strong>
          <span>${catalogLoadState === "ready" ? "Добавь объявление через импортёр — точные фотографии и данные появятся автоматически." : "Проверь подключение Worker или измени фильтры."}</span>
          <a class="primary-btn" href="admin.html">Открыть управление витриной</a>
        </div>`;
        return;
      }

      productGrid.innerHTML = list.map(makeProductCard).join("");
      applyReveal();
    }

    function openDrawer() {
      if (!cartDrawer || !overlay) return;
      cartDrawer.classList.add("open");
      overlay.classList.add("show");
      document.body.classList.add("no-scroll");
      cartDrawer.setAttribute("aria-hidden", "false");
    }

    function closeDrawer() {
      if (!cartDrawer || !overlay) return;
      cartDrawer.classList.remove("open");
      if (!productModal || !productModal.classList.contains("show")) {
        overlay.classList.remove("show");
        document.body.classList.remove("no-scroll");
      }
      cartDrawer.setAttribute("aria-hidden", "true");
    }

    function openProductModal(id) {
      const product = products.find(item => String(item.id) === String(id));
      if (!product || !productModal || !overlay) return;

      currentProduct = product;
      selectedSize = "";
      selectedColor = "";

      $("modalMedia").innerHTML = makeVisualHTML(product, "modal");
      $("modalMeta").textContent = `${product.type} · ${product.source} · реальная карточка источника`;
      $("modalTitle").textContent = product.name;
      $("modalPrice").textContent = `${formatRub(product.priceRub)} · ориентир ${formatCny(product.priceCny)}`;
      $("modalDesc").textContent = product.description;
      $("modalChips").innerHTML = (product.tags || []).map(tag => `<span class="chip">${tag}</span>`).join("");

      $("modalSourceBox").innerHTML = `
        <div class="calc-result-row">
          <span>Площадка</span>
          <strong>${product.source}</strong>
        </div>
        <div class="calc-result-row">
          <span>Карточка источника</span>
          <strong>${product.sourceTitle}</strong>
        </div>
        <div class="calc-result-row">
          <span>Цена источника</span>
          <strong>${product.sourcePriceText}</strong>
        </div>
        <div class="calc-result-row">
          <span>Расчётный срок ONYX</span>
          <strong>${product.deliveryDays} дней</strong>
        </div>
        <div class="calc-result-row total">
          <span>Предварительный итог</span>
          <strong>${formatRub(product.priceRub)}</strong>
        </div>
      `;

      renderOptions("size", product.sizes || []);
      renderOptions("color", product.colors || []);
      if ($("modalOpenSourceBtn")) $("modalOpenSourceBtn").dataset.productId = String(product.id);

      productModal.classList.add("show");
      overlay.classList.add("show");
      document.body.classList.add("no-scroll");
    }

    function closeProductModal() {
      if (!productModal || !overlay) return;
      productModal.classList.remove("show");
      if (!cartDrawer || !cartDrawer.classList.contains("open")) {
        overlay.classList.remove("show");
        document.body.classList.remove("no-scroll");
      }
      currentProduct = null;
    }

    function renderOptions(type, options) {
      const block = $(type === "size" ? "sizeBlock" : "colorBlock");
      const container = $(type === "size" ? "sizeOptions" : "colorOptions");
      const selected = type === "size" ? selectedSize : selectedColor;

      if (!block || !container) return;

      if (!options.length) {
        block.style.display = "none";
        container.innerHTML = "";
        return;
      }

      block.style.display = "block";
      container.innerHTML = options.map(option => `
        <button class="option-btn ${selected === option ? "active" : ""}" type="button" data-option-type="${type}" data-option-value="${option}">
          ${option}
        </button>
      `).join("");
    }

    function addProductToCart(product, config = {}) {
      const item = {
        id: Date.now() + Math.random(),
        productId: product.id,
        name: product.name,
        source: product.source,
        type: product.type,
        priceRub: product.priceRub,
        priceCny: product.priceCny,
        qty: 1,
        size: config.size || "",
        color: config.color || "",
        visual: product.visual
      };

      cart.push(item);
      renderCart();
      showToast("Добавлено в заявку");
    }

    function quickAdd(id) {
      const product = products.find(item => String(item.id) === String(id));
      if (!product) return;
      addProductToCart(product);
      openDrawer();
    }

    function addCurrentModalProduct() {
      if (!currentProduct) return;

      if ((currentProduct.sizes || []).length && !selectedSize) {
        showToast("Выбери размер");
        return;
      }

      if ((currentProduct.colors || []).length && !selectedColor) {
        showToast("Выбери цвет / модель");
        return;
      }

      addProductToCart(currentProduct, {
        size: selectedSize,
        color: selectedColor
      });

      closeProductModal();
      openDrawer();
    }

    function changeQty(id, direction) {
      const item = cart.find(product => product.id === id);
      if (!item) return;

      if (direction === "plus") item.qty += 1;
      if (direction === "minus") item.qty -= 1;

      cart = cart.filter(product => product.qty > 0);
      renderCart();
    }

    function removeCartItem(id) {
      cart = cart.filter(product => product.id !== id);
      renderCart();
      showToast("Удалено из заявки");
    }

    function renderCart() {
      if (!cartItems || !cartTotal) return;

      if (!cart.length) {
        cartItems.innerHTML = `<div class="empty-state">Заявка пока пустая. Добавь товары из витрины или отправь ссылку через форму.</div>`;
        cartTotal.textContent = formatRub(0);
        updateCartCount();
        saveCart();
        return;
      }

      cartItems.innerHTML = cart.map(item => {
        const props = [];
        if (item.size) props.push(`Размер: ${item.size}`);
        if (item.color) props.push(`Цвет/модель: ${item.color}`);

        return `
          <div class="cart-item">
            <div class="cart-thumb"><span>${item.visual || "ONYX"}</span></div>
            <div>
              <strong>${item.name}</strong>
              <small>${item.source} · ${item.type}</small>
              ${props.length ? `<small>${props.join(" · ")}</small>` : ""}
              <small>${formatRub(item.priceRub)} · ${formatCny(item.priceCny)}</small>
            </div>
            <div class="cart-actions">
              <div class="qty-group">
                <button class="qty-btn" onclick="changeQty(${item.id}, 'minus')">−</button>
                <span>${item.qty}</span>
                <button class="qty-btn" onclick="changeQty(${item.id}, 'plus')">+</button>
              </div>
              <button class="remove-btn" onclick="removeCartItem(${item.id})">Удалить</button>
            </div>
          </div>
        `;
      }).join("");

      cartTotal.textContent = formatRub(getCartTotal());
      updateCartCount();
      saveCart();
    }

    function buildTelegramMessage(title, fields) {
      const lines = [title, ""];
      fields.forEach(field => {
        if (field.value) lines.push(`${field.label}: ${field.value}`);
      });
      return lines.join("\n");
    }

    async function copyTextSafe(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand("copy");
        area.remove();
        return copied;
      }
    }

    function buildTelegramShareUrl(message) {
      return `https://t.me/share/url?url=${encodeURIComponent(ORDER_TELEGRAM_URL)}&text=${encodeURIComponent(message)}`;
    }

    function showTelegramHandoff(message) {
      currentTelegramOrderMessage = message;
      const modal = $("telegramHandoff");
      if ($("telegramHandoffText")) $("telegramHandoffText").value = message;
      if ($("shareTelegramOrderBtn")) $("shareTelegramOrderBtn").href = buildTelegramShareUrl(message);
      modal?.classList.add("show");
      modal?.setAttribute("aria-hidden", "false");
    }

    function closeTelegramHandoff() {
      const modal = $("telegramHandoff");
      modal?.classList.remove("show");
      modal?.setAttribute("aria-hidden", "true");
    }

    async function persistOrderRequest(payload) {
      if (!ONYX_API_BASE) return null;
      try {
        const response = await fetch(`${ONYX_API_BASE}/api/orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) return null;
        return await response.json();
      } catch (error) {
        return null;
      }
    }

    async function openTelegramOrder(message, payload = {}) {
      await copyTextSafe(message);
      await persistOrderRequest({ ...payload, message });
      showTelegramHandoff(message);
      showToast("Заявка подготовлена и скопирована");
    }

    function buildMarketplaceSearchUrl(platformId, query) {
      const marketplace = MARKETPLACES[platformId];
      if (!marketplace) return "";
      const cleanQuery = String(query || "").trim();
      return cleanQuery && marketplace.search ? marketplace.search(cleanQuery) : marketplace.home;
    }

    async function openMarketplaceSearch(platformId, query) {
      const marketplace = MARKETPLACES[platformId];
      if (!marketplace) return;
      const cleanQuery = String(query || "").trim();
      if (cleanQuery && !marketplace.search) {
        await copyTextSafe(cleanQuery);
        showToast(`Запрос скопирован. Вставь его в поиск ${marketplace.name}`);
      }
      window.open(buildMarketplaceSearchUrl(platformId, cleanQuery), "_blank", "noopener,noreferrer");
    }

    function getProductSourceUrl(product) {
      if (product?.sourceUrl) return product.sourceUrl;
      const platformId = SOURCE_TO_MARKETPLACE[product?.source] || "alibaba";
      return buildMarketplaceSearchUrl(platformId, product?.sourceSearchQuery || product?.name || "");
    }

    function openProductSource(id) {
      const product = products.find(item => String(item.id) === String(id));
      if (!product) return;
      window.open(getProductSourceUrl(product), "_blank", "noopener,noreferrer");
    }

    function startOnyxOrder(id) {
      const product = products.find(item => String(item.id) === String(id));
      if (!product) return;
      if ($("quoteLink")) $("quoteLink").value = getProductSourceUrl(product);
      if ($("quoteText")) $("quoteText").value = `Товар из витрины: ${product.name}\nПлощадка: ${product.source}\nЦена в Китае: ${formatCny(product.priceCny)}\nОриентир с доставкой: ${formatRub(product.priceRub)}\nНужны проверка, выкуп и доставка через ONYX GROUP.`;
      $("quote")?.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => $("quoteName")?.focus(), 500);
      showToast("Товар перенесён в индивидуальную заявку");
    }

    async function submitQuoteForm(event) {
      event.preventDefault();
      const message = buildTelegramMessage("🔥 Новая заявка ONYX GROUP", [
        { label: "Имя", value: $("quoteName").value.trim() },
        { label: "Контакт", value: $("quoteContact").value.trim() },
        { label: "Ссылка / товар", value: $("quoteLink").value.trim() },
        { label: "Комментарий", value: $("quoteText").value.trim() }
      ]);
      await openTelegramOrder(message, {
        type: "individual",
        customerName: $("quoteName").value.trim(),
        customerContact: $("quoteContact").value.trim(),
        productLink: $("quoteLink").value.trim()
      });
      event.target.reset();
    }

    async function submitCheckoutForm(event) {
      event.preventDefault();
      if (!cart.length) {
        showToast("Заявка пустая");
        return;
      }
      const itemsText = cart.map((item, index) => {
        const props = [];
        if (item.size) props.push(`размер ${item.size}`);
        if (item.color) props.push(`цвет/модель ${item.color}`);
        return `${index + 1}) ${item.name} — ${item.qty} шт · ${item.source} · ${formatRub(item.priceRub)}${props.length ? " · " + props.join(", ") : ""}`;
      }).join("\n");
      const message = buildTelegramMessage("🧾 Заявка из корзины ONYX GROUP", [
        { label: "Имя", value: $("customerName").value.trim() },
        { label: "Контакт", value: $("customerContact").value.trim() },
        { label: "Город", value: $("customerCity").value.trim() },
        { label: "Товары", value: "\n" + itemsText },
        { label: "Примерный итог", value: formatRub(getCartTotal()) },
        { label: "Комментарий", value: $("customerComment").value.trim() }
      ]);
      await openTelegramOrder(message, { type: "cart", total: getCartTotal(), items: cart });
      cart = [];
      renderCart();
      event.target.reset();
      setTimeout(closeDrawer, 500);
    }

    function normalizeWeight(rawWeight) {
      const value = Number(rawWeight) || 0;

      if (value > 100) {
        return {
          kg: value / 1000,
          label: `${value.toLocaleString("ru-RU")} г → ${(value / 1000).toLocaleString("ru-RU")} кг`
        };
      }

      return {
        kg: value,
        label: `${value.toLocaleString("ru-RU")} кг`
      };
    }

    function getCommissionInfo(itemRub, weightKg) {
      if (weightKg >= 20 || itemRub >= 150000) {
        return {
          percent: 0.07,
          title: "Большой товар",
          note: "7%"
        };
      }

      if (weightKg >= 5 || itemRub >= 50000) {
        return {
          percent: 0.10,
          title: "Средний товар",
          note: "10%"
        };
      }

      return {
        percent: 0.20,
        title: "Мелкий товар",
        note: "20%"
      };
    }

    function getAutoServiceFee(itemRub, weightKg) {
      const info = getCommissionInfo(itemRub, weightKg);
      return Math.max(MIN_SERVICE_FEE, itemRub * info.percent);
    }

    function calculatePrice() {
      const calcCny = $("calcCny");
      const calcWeight = $("calcWeight");
      const calcResult = $("calcResult");

      if (!calcCny || !calcWeight || !calcResult) return;

      const priceCny = Number(calcCny.value) || 0;
      const rawWeight = Number(calcWeight.value) || 0;
      const weightData = normalizeWeight(rawWeight);
      const weightKg = weightData.kg;

      const route = deliveryRates[activeCalcRoute];
      const itemRub = priceCny * SITE_CNY_RATE;
      const commissionInfo = getCommissionInfo(itemRub, weightKg);

      const chinaDeliveryRub = priceCny > 0 ? 250 : 0;
      const internationalDeliveryRub = route.base + weightKg * route.perKg;
      const serviceFee = getAutoServiceFee(itemRub, weightKg);
      const total = itemRub + chinaDeliveryRub + internationalDeliveryRub + serviceFee;

      if ($("siteRateLabel")) $("siteRateLabel").textContent = `¥1 = ${SITE_CNY_RATE} ₽`;
      if ($("siteFeeLabel")) $("siteFeeLabel").textContent = `${commissionInfo.title} · ${commissionInfo.note}`;
      if ($("siteRouteLabel")) $("siteRouteLabel").textContent = `${route.title} · ${route.days}`;

      calcResult.innerHTML = `
        <div class="calc-result-row">
          <span>Вес для расчёта</span>
          <strong>${weightData.label}</strong>
        </div>
        <div class="calc-result-row">
          <span>Товар по курсу сайта</span>
          <strong>${formatRub(itemRub)}</strong>
        </div>
        <div class="calc-result-row">
          <span>Доставка по Китаю</span>
          <strong>${formatRub(chinaDeliveryRub)}</strong>
        </div>
        <div class="calc-result-row">
          <span>Доставка Китай → РФ</span>
          <strong>${formatRub(internationalDeliveryRub)}</strong>
        </div>
        <div class="calc-result-row">
          <span>Комиссия ONYX GROUP</span>
          <strong>${formatRub(serviceFee)} · ${commissionInfo.note}</strong>
        </div>
        <div class="calc-result-row">
          <span>Категория товара</span>
          <strong>${commissionInfo.title}</strong>
        </div>
        <div class="calc-result-row">
          <span>Срок маршрута</span>
          <strong>${route.days} дней</strong>
        </div>
        <div class="calc-result-row total">
          <span>Итого примерно</span>
          <strong>${formatRub(total)}</strong>
        </div>
      `;

      lastCalculationSummary = [
        `Цена товара: ${formatCny(priceCny)}`,
        `Вес: ${weightData.label}`,
        `Маршрут: ${route.title}, ${route.days} дней`,
        `Комиссия: ${commissionInfo.note}`,
        `Предварительный итог: ${formatRub(total)}`
      ].join("\n");
    }

    function getStatusByStep(step) {
      const statuses = {
        1: {
          status: "Заявка принята",
          location: "Менеджер ONYX",
          next: "Проверка товара и расчёт"
        },
        2: {
          status: "Товар выкуплен",
          location: "Поставщик в Китае",
          next: "Доставка на склад ONYX"
        },
        3: {
          status: "Склад в Китае",
          location: "Guangzhou warehouse",
          next: "Фото-проверка и упаковка"
        },
        4: {
          status: "В пути в РФ",
          location: "Карго маршрут Китай → Россия",
          next: "Прибытие на сортировку РФ"
        },
        5: {
          status: "Готов к выдаче",
          location: "Россия",
          next: "Передача клиенту"
        }
      };

      return statuses[Number(step)] || statuses[1];
    }

    function getStoredTrackingOrders() {
      try {
        return JSON.parse(localStorage.getItem("onyx_group_tracking_orders") || "{}");
      } catch (error) {
        return {};
      }
    }

    function getAllTrackingOrders() {
      return {
        ...trackingOrders,
        ...getStoredTrackingOrders()
      };
    }

    async function fetchTrackingOrder(code) {
      if (TRACKING_API_BASE) {
        try {
          const response = await fetch(`${TRACKING_API_BASE}/api/tracking/${encodeURIComponent(code)}`);
          if (response.ok) {
            const data = await response.json();
            return data.tracking || null;
          }
          if (response.status === 404) return null;
        } catch (error) {
          console.warn("Tracking API unavailable, using browser storage", error);
        }
      }
      return getAllTrackingOrders()[code] || null;
    }

    async function saveTrackingOrder(order) {
      if (TRACKING_API_BASE) {
        const adminToken = String(localStorage.getItem("onyx_admin_token") || "").trim();
        if (adminToken) {
          try {
            const response = await fetch(`${TRACKING_API_BASE}/api/tracking/${encodeURIComponent(order.code)}`, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
              },
              body: JSON.stringify(order)
            });
            if (!response.ok) throw new Error("API save failed");
            const data = await response.json();
            return data.tracking || order;
          } catch (error) {
            console.warn("Tracking API save unavailable, using browser storage", error);
          }
        }
      }

      const stored = getStoredTrackingOrders();
      stored[order.code] = order;
      localStorage.setItem("onyx_group_tracking_orders", JSON.stringify(stored));
      return order;
    }

    function updateTrackingView(order) {
      const step = Number(order.step) || 1;
      const progress = [0, 25, 50, 75, 100][step - 1] || 0;

      document.querySelectorAll(".tracking-step").forEach(item => {
        const itemStep = Number(item.dataset.step);
        item.classList.remove("done", "active", "current");

        if (itemStep < step) item.classList.add("done");
        if (itemStep === step) item.classList.add("current");
      });

      if ($("trackingRouteFill")) $("trackingRouteFill").style.width = progress + "%";
      if ($("trackingPackage")) $("trackingPackage").style.left = progress + "%";
      if ($("trackingMapTitle")) $("trackingMapTitle").textContent = order.code;
      if ($("trackingMapStatus")) $("trackingMapStatus").textContent = order.status;
      setMapPackageByStep(step);
    }

    function renderTrackingResult(order) {
      const result = $("trackResult");
      if (!result) return;

      result.style.display = "block";
      result.innerHTML = `
        <div class="calc-result-row">
          <span>Номер</span>
          <strong>${order.code}</strong>
        </div>
        <div class="calc-result-row">
          <span>Статус</span>
          <strong>${order.status}</strong>
        </div>
        <div class="calc-result-row">
          <span>Локация</span>
          <strong>${order.location}</strong>
        </div>
        <div class="calc-result-row">
          <span>Следующий этап</span>
          <strong>${order.next}</strong>
        </div>
        <div class="calc-result-row total">
          <span>Прогноз</span>
          <strong>${order.eta || "уточняется"}</strong>
        </div>
      `;
    }

    async function submitTrackForm(event) {
      event.preventDefault();

      const raw = $("trackInput").value.trim().toUpperCase();
      const code = raw || "ONYX-2406";
      const order = await fetchTrackingOrder(code);

      if (!order) {
        const demo = {
          code,
          step: 1,
          status: "Трек-код не найден",
          location: "Нет в базе сайта",
          next: "Проверь код или напиши менеджеру",
          eta: "уточняется"
        };

        updateTrackingView(demo);
        renderTrackingResult(demo);
        showToast("Трек-код не найден");
        return;
      }

      updateTrackingView(order);
      renderTrackingResult(order);
      showToast("Статус заказа обновлён");
    }

    async function submitManagerTrackForm(event) {
      event.preventDefault();

      const code = $("managerTrackCode").value.trim().toUpperCase();
      const step = Number($("managerTrackStep").value);
      const base = getStatusByStep(step);

      const order = {
        code,
        step,
        status: base.status,
        location: $("managerTrackLocation").value.trim() || base.location,
        next: base.next,
        eta: $("managerTrackEta").value.trim() || "уточняется"
      };

      await saveTrackingOrder(order);

      if ($("trackInput")) $("trackInput").value = code;

      updateTrackingView(order);
      renderTrackingResult(order);
      showToast("Статус сохранён");

      event.target.reset();
    }

    let routeMap = null;
    let routePackageMarker = null;
    let routeAnimationFrame = null;

    function interpolateRoute(points, t) {
      const segments = points.length - 1;
      const scaled = Math.max(0, Math.min(0.999999, t)) * segments;
      const index = Math.floor(scaled);
      const local = scaled - index;
      const a = points[index];
      const b = points[index + 1];
      return [
        a[0] + (b[0] - a[0]) * local,
        a[1] + (b[1] - a[1]) * local
      ];
    }

    function initRealRouteMap() {
      const mapElement = $("realRouteMap");
      const shell = $("realMapShell");
      if (!mapElement || !window.L) return;

      const guangzhou = [23.1291, 113.2644];
      const almaty = [43.2389, 76.8897];
      const moscow = [55.7558, 37.6173];
      const routePoints = [guangzhou, almaty, moscow];

      routeMap = L.map(mapElement, {
        zoomControl: true,
        scrollWheelZoom: false,
        attributionControl: true,
        preferCanvas: true
      });

      L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap &copy; CARTO"
      }).addTo(routeMap);

      const bounds = L.latLngBounds(routePoints);
      routeMap.fitBounds(bounds, { padding: [54, 54] });

      const markerIcon = (kind) => L.divIcon({
        className: "onyx-city-marker",
        html: `<div class="onyx-pin ${kind}"></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });

      const packageIcon = L.divIcon({
        className: "onyx-package-marker",
        html: `<div class="onyx-package">📦</div>`,
        iconSize: [44, 44],
        iconAnchor: [22, 22]
      });

      const popup = (title, text) => `<div class="map-popup-title">${title}</div><div class="map-popup-text">${text}</div>`;

      L.marker(guangzhou, { icon: markerIcon("cn") }).addTo(routeMap)
        .bindPopup(popup("Гуанчжоу", "Склад ONYX: приём, фото и проверка"), { className: "onyx-map-popup" });
      L.marker(almaty, { icon: markerIcon("transit") }).addTo(routeMap)
        .bindPopup(popup("Транзитный хаб", "Перегрузка и движение по карго-маршруту"), { className: "onyx-map-popup" });
      L.marker(moscow, { icon: markerIcon("ru") }).addTo(routeMap)
        .bindPopup(popup("Москва", "Прибытие в Россию и передача клиенту"), { className: "onyx-map-popup" });

      L.polyline(routePoints, {
        color: "#ffffff",
        opacity: .72,
        weight: 12,
        lineCap: "round"
      }).addTo(routeMap);

      L.polyline(routePoints, {
        color: "#f4532d",
        opacity: .95,
        weight: 5,
        dashArray: "14 12",
        lineCap: "round"
      }).addTo(routeMap);

      routePackageMarker = L.marker(guangzhou, { icon: packageIcon, interactive: false, zIndexOffset: 1000 }).addTo(routeMap);

      let start = performance.now();
      const animate = (now) => {
        const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const duration = reduced ? 1 : 9000;
        const t = reduced ? .55 : ((now - start) % duration) / duration;
        const point = interpolateRoute(routePoints, t);
        if (routePackageMarker) routePackageMarker.setLatLng(point);
        routeAnimationFrame = requestAnimationFrame(animate);
      };
      routeAnimationFrame = requestAnimationFrame(animate);

      shell?.classList.add("map-ready");
      setTimeout(() => routeMap.invalidateSize(), 250);
    }

    function setMapPackageByStep(step) {
      if (!routePackageMarker) return;
      const points = [
        [23.1291, 113.2644],
        [28.5, 104.0],
        [36.2, 89.5],
        [43.2389, 76.8897],
        [55.7558, 37.6173]
      ];
      routePackageMarker.setLatLng(points[Math.max(0, Math.min(4, Number(step) - 1))]);
    }

    function unlockManagerPanel() {
      const pin = $("managerPin")?.value.trim();
      const form = $("managerTrackForm");
      const box = $("managerUnlockBox");
      if (pin !== MANAGER_PIN) {
        showToast("Неверный PIN менеджера");
        return;
      }
      if (form) form.hidden = false;
      if (box) box.hidden = true;
      showToast("Панель менеджера открыта");
    }

    function submitNewsletter(event) {
      event.preventDefault();

      const input = $("newsletterInput");
      const value = input.value.trim();
      const result = $("newsletterResult");

      if (!value) {
        showToast("Укажи Telegram или email");
        return;
      }

      const subscribers = JSON.parse(localStorage.getItem("onyx_group_newsletter_list") || "[]");
      subscribers.push({
        contact: value,
        date: new Date().toLocaleString("ru-RU")
      });

      localStorage.setItem("onyx_group_newsletter_list", JSON.stringify(subscribers));
      localStorage.setItem("onyx_group_newsletter", value);

      if (result) {
        result.classList.add("saved");
        result.innerHTML = `
          <div class="calc-result-row">
            <span>Контакт</span>
            <strong>${value}</strong>
          </div>
          <div class="calc-result-row">
            <span>Статус</span>
            <strong>подписка сохранена</strong>
          </div>
          <div class="calc-result-row">
            <span>Что будет приходить</span>
            <strong>подборки товаров из Китая</strong>
          </div>
          <div class="calc-result-row total">
            <span>Канал</span>
            <strong>Telegram / email</strong>
          </div>
        `;
      }

      showToast("Подписка сохранена");
      event.target.reset();
    }

    function applyReveal() {
      const items = document.querySelectorAll(".reveal");

      if (!("IntersectionObserver" in window)) {
        items.forEach(item => item.classList.add("visible"));
        return;
      }

      const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) entry.target.classList.add("visible");
        });
      }, { threshold: 0.12 });

      items.forEach(item => observer.observe(item));
    }

    function resetQuickPills() {
      document.querySelectorAll(".filter-pill").forEach(item => item.classList.remove("active"));
      const allPill = document.querySelector('.filter-pill[data-quick="all"]');
      if (allPill) allPill.classList.add("active");
      activeQuickFilter = "all";
    }

    function finishIntro() {
      const intro = $("introOverlay");
      if (!intro) return;
      intro.classList.remove("is-playing");
      intro.hidden = true;
      intro.setAttribute("aria-hidden", "true");
      document.body.classList.remove("intro-active");
    }

    function playIntro(scrollToTop = false) {
      const intro = $("introOverlay");
      if (!intro) return;

      clearTimeout(introTimer);
      intro.hidden = false;
      intro.setAttribute("aria-hidden", "false");
      intro.classList.remove("is-playing");
      void intro.offsetWidth;
      intro.classList.add("is-playing");
      document.body.classList.add("intro-active");

      if (scrollToTop) window.scrollTo({ top: 0, behavior: "smooth" });
      introTimer = setTimeout(finishIntro, 2400);
    }

    function openQuoteFromCalculation() {
      const quote = $("quote");
      const quoteText = $("quoteText");
      const quoteName = $("quoteName");

      if (quoteText && lastCalculationSummary) {
        const prefix = "Предварительный расчёт с сайта:\\n";
        if (!quoteText.value.trim()) quoteText.value = prefix + lastCalculationSummary;
      }

      quote?.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => quoteName?.focus(), 520);
    }

    function bindEvents() {
      if (burger && nav) {
        burger.addEventListener("click", () => {
          burger.classList.toggle("open");
          nav.classList.toggle("open");
        });

        nav.querySelectorAll("a").forEach(link => {
          link.addEventListener("click", () => {
            burger.classList.remove("open");
            nav.classList.remove("open");
          });
        });
      }

      if ($("brandReplay")) {
        $("brandReplay").addEventListener("click", event => {
          event.preventDefault();
          playIntro(true);
        });
      }

      if ($("calcQuoteBtn")) {
        $("calcQuoteBtn").addEventListener("click", openQuoteFromCalculation);
      }

      if ($("marketplaceSearchForm")) {
        $("marketplaceSearchForm").addEventListener("submit", event => {
          event.preventDefault();
          openMarketplaceSearch($("marketplaceSearchSelect").value, $("marketplaceSearchInput").value);
        });
      }

      document.querySelectorAll("[data-marketplace]").forEach(button => {
        button.addEventListener("click", () => {
          openMarketplaceSearch(button.dataset.marketplace, $("marketplaceSearchInput")?.value || "");
        });
      });

      document.querySelectorAll("[data-marketplace-query]").forEach(button => {
        button.addEventListener("click", () => {
          if ($("marketplaceSearchInput")) $("marketplaceSearchInput").value = button.dataset.marketplaceQuery;
          $("marketplaceSearchInput")?.focus();
        });
      });

      if ($("modalOpenSourceBtn")) {
        $("modalOpenSourceBtn").addEventListener("click", () => {
          const id = Number($("modalOpenSourceBtn").dataset.productId);
          if (id) openProductSource(id);
        });
      }

      if ($("telegramHandoffClose")) $("telegramHandoffClose").addEventListener("click", closeTelegramHandoff);
      if ($("copyTelegramOrderBtn")) $("copyTelegramOrderBtn").addEventListener("click", async () => {
        await copyTextSafe(currentTelegramOrderMessage);
        showToast("Текст заявки скопирован");
      });
      if ($("telegramHandoff")) $("telegramHandoff").addEventListener("click", event => {
        if (event.target === $("telegramHandoff")) closeTelegramHandoff();
      });

      if ($("openSearchBtn")) {
        $("openSearchBtn").addEventListener("click", () => {
          $("smart-search").scrollIntoView({ behavior: "smooth" });
          setTimeout(() => globalSearch && globalSearch.focus(), 350);
        });
      }

      if ($("searchNowBtn")) {
        $("searchNowBtn").addEventListener("click", () => {
          $("catalog").scrollIntoView({ behavior: "smooth" });
          renderProducts();
        });
      }

      if ($("openCartBtn")) $("openCartBtn").addEventListener("click", openDrawer);
      if ($("closeCartBtn")) $("closeCartBtn").addEventListener("click", closeDrawer);
      if ($("closeModalBtn")) $("closeModalBtn").addEventListener("click", closeProductModal);
      if ($("modalCloseAction")) $("modalCloseAction").addEventListener("click", closeProductModal);
      if ($("modalAddToCartBtn")) $("modalAddToCartBtn").addEventListener("click", addCurrentModalProduct);

      if (overlay) {
        overlay.addEventListener("click", () => {
          closeProductModal();
          closeDrawer();
          closeTelegramHandoff();
        });
      }

      [globalSearch, mainCategoryFilter, sourceFilter, priceFilter, sortFilter].forEach(element => {
        if (!element) return;
        element.addEventListener("input", renderProducts);
        element.addEventListener("change", renderProducts);
      });

      document.querySelectorAll(".tag-link").forEach(button => {
        button.addEventListener("click", () => {
          const value = button.dataset.search;
          const categoryMap = {
            "дом": "home",
            "авто": "auto"
          };

          if (globalSearch) globalSearch.value = "";
          if (mainCategoryFilter) mainCategoryFilter.value = "all";
          if (sourceFilter) sourceFilter.value = "all";
          if (priceFilter) priceFilter.value = "all";
          resetQuickPills();

          if (categoryMap[value]) {
            mainCategoryFilter.value = categoryMap[value];
          } else {
            globalSearch.value = value;
          }

          $("catalog").scrollIntoView({ behavior: "smooth" });
          renderProducts();
        });
      });

      document.querySelectorAll("[data-category-jump]").forEach(button => {
        button.addEventListener("click", () => {
          if (globalSearch) globalSearch.value = "";
          if (mainCategoryFilter) mainCategoryFilter.value = button.dataset.categoryJump;
          if (sourceFilter) sourceFilter.value = "all";
          if (priceFilter) priceFilter.value = "all";
          resetQuickPills();
          $("catalog").scrollIntoView({ behavior: "smooth" });
          renderProducts();
        });
      });

      document.querySelectorAll(".filter-pill").forEach(button => {
        button.addEventListener("click", () => {
          document.querySelectorAll(".filter-pill").forEach(item => item.classList.remove("active"));
          button.classList.add("active");
          activeQuickFilter = button.dataset.quick;
          renderProducts();
        });
      });

      if ($("resetFiltersBtn")) {
        $("resetFiltersBtn").addEventListener("click", () => {
          if (globalSearch) globalSearch.value = "";
          if (mainCategoryFilter) mainCategoryFilter.value = "all";
          if (sourceFilter) sourceFilter.value = "all";
          if (priceFilter) priceFilter.value = "all";
          if (sortFilter) sortFilter.value = "default";
          resetQuickPills();
          renderProducts();
          showToast("Фильтры сброшены");
        });
      }

      if ($("scrollQuoteBtn")) {
        $("scrollQuoteBtn").addEventListener("click", () => {
          $("quote").scrollIntoView({ behavior: "smooth" });
        });
      }

      document.addEventListener("click", event => {
        const option = event.target.closest(".option-btn");
        if (!option || !currentProduct) return;

        const type = option.dataset.optionType;
        const value = option.dataset.optionValue;

        if (type === "size") {
          selectedSize = value;
          renderOptions("size", currentProduct.sizes || []);
        }

        if (type === "color") {
          selectedColor = value;
          renderOptions("color", currentProduct.colors || []);
        }
      });

      document.querySelectorAll(".calc-tab").forEach(tab => {
        tab.addEventListener("click", () => {
          document.querySelectorAll(".calc-tab").forEach(item => item.classList.remove("active"));
          tab.classList.add("active");
          activeCalcRoute = tab.dataset.calcRoute;
          calculatePrice();
        });
      });

      ["calcCny", "calcWeight"].forEach(id => {
        const element = $(id);
        if (!element) return;
        element.addEventListener("input", calculatePrice);
        element.addEventListener("change", calculatePrice);
      });

      if ($("quoteForm")) $("quoteForm").addEventListener("submit", submitQuoteForm);
      if ($("checkoutForm")) $("checkoutForm").addEventListener("submit", submitCheckoutForm);
      document.querySelectorAll("[data-demo-track]").forEach(button => {
        button.addEventListener("click", async () => {
          const code = button.dataset.demoTrack;
          if ($("trackInput")) $("trackInput").value = code;
          const order = await fetchTrackingOrder(code);
          if (order) {
            updateTrackingView(order);
            renderTrackingResult(order);
            showToast(`Показан заказ ${code}`);
          }
        });
      });

      if ($("unlockManagerBtn")) $("unlockManagerBtn").addEventListener("click", unlockManagerPanel);
      if ($("trackForm")) $("trackForm").addEventListener("submit", submitTrackForm);
      if ($("managerTrackForm")) $("managerTrackForm").addEventListener("submit", submitManagerTrackForm);
      if ($("newsletterForm")) $("newsletterForm").addEventListener("submit", submitNewsletter);

      window.addEventListener("resize", () => routeMap && routeMap.invalidateSize());

      document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
          closeProductModal();
          closeDrawer();
          closeTelegramHandoff();
        }
      });
    }

    window.handleProductImageError = handleProductImageError;
    window.switchProductPhoto = switchProductPhoto;
    window.openProductModal = openProductModal;
    window.openProductSource = openProductSource;
    window.startOnyxOrder = startOnyxOrder;
    window.quickAdd = quickAdd;
    window.changeQty = changeQty;
    window.removeCartItem = removeCartItem;

    async function bootstrapOnyxSite() {
      await loadLiveCatalog();
      renderProducts();
      renderCart();
      calculatePrice();
      initRealRouteMap();
      updateTrackingView(getAllTrackingOrders()["ONYX-2406"]);
      renderTrackingResult(getAllTrackingOrders()["ONYX-2406"]);
      bindEvents();
      applyReveal();
      setTimeout(() => playIntro(false), 120);
    }

    bootstrapOnyxSite();
  