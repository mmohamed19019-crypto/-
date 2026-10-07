(() => {
  "use strict";

  const data = window.DAWAEY_DATA;
  if (!data || !Array.isArray(data.medicines) || !Array.isArray(data.pharmacies)) {
    document.getElementById("results-count").textContent = "تعذر تحميل البيانات. تأكد من وجود ملف data.js بجوار الصفحة.";
    return;
  }

  const pageSize = 12;
  const state = { view: "medicines", query: "", category: "", region: "", sort: "name", favoritesOnly: false, visible: pageSize };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const grid = $("#results-grid");
  const search = $("#search-input");
  const dialog = $("#detail-dialog");
  const favoritesKey = "dawaey-favorites-v1";
  const authDialog = $("#auth-dialog");
  const authContent = $("#auth-content");
  const accountStoreKey = "dawaey-accounts-v1";
  const activeAccountKey = "dawaey-active-account-v1";
  let authMode = "choice";
  let selectedRole = "patient";
  let pendingMedicineId = null;
  let pendingOtp = "";
  let mapInstance = null;
  let mapMarker = null;
  let mapLoading = null;
  let mapPosition = null;

  const readFavorites = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(favoritesKey) || "[]");
      return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []);
    } catch (error) {
      console.warn("تعذر قراءة المفضلة المحفوظة:", error);
      return new Set();
    }
  };
  const favorites = readFavorites();
  const readAccounts = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(accountStoreKey) || "[]");
      return Array.isArray(parsed) ? parsed.filter((account) => account && typeof account === "object") : [];
    } catch (error) {
      console.error("تعذر قراءة الحسابات المحفوظة:", error);
      return [];
    }
  };
  let accounts = readAccounts();
  let currentUser = null;
  const saveFavorites = () => {
    try {
      localStorage.setItem(favoritesKey, JSON.stringify([...favorites]));
    } catch (error) {
      console.error("تعذر حفظ المفضلة:", error);
      showToast("تعذر حفظ المفضلة على هذا الجهاز.");
    }
  };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const normalized = (value) => String(value ?? "").normalize("NFKD").replace(/[\u064B-\u065F\u0670\u0640]/g, "").toLocaleLowerCase("ar").trim();
  const phoneHref = (value) => {
    const phone = String(value ?? "").split(/[\/،,]/)[0].replace(/[^\d+]/g, "");
    return phone ? `tel:${phone}` : "";
  };
  const whatsappHref = (value) => {
    const phone = normalizeContact(value);
    return /^01[0125]\d{8}$/.test(phone) ? `https://wa.me/20${phone.slice(1)}` : "";
  };
  const pharmacyRegion = (item) => {
    if (item.governorate) return item.governorate;
    const address = String(item.address ?? "");
    const governorate = address.match(/محافظة\s+([^،,-]+)/);
    return (governorate?.[1] || address.split(" - ")[0]).trim();
  };
  const unique = (items) => [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b, "ar"));

  $("#year").textContent = new Date().getFullYear();
  $("#stat-medicines").textContent = data.medicines.length.toLocaleString("ar-EG");
  $("#stat-pharmacies").textContent = data.pharmacies.length.toLocaleString("ar-EG");
  $("#stat-categories").textContent = unique(data.medicines.map((item) => item.category)).length.toLocaleString("ar-EG");
  $("#tab-medicine-count").textContent = data.medicines.length.toLocaleString("ar-EG");
  $("#tab-pharmacy-count").textContent = data.pharmacies.length.toLocaleString("ar-EG");
  $("#category-filter").innerHTML += unique(data.medicines.map((item) => item.category)).map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
  $("#region-filter").innerHTML += unique(data.pharmacies.map(pharmacyRegion)).map((region) => `<option value="${escapeHtml(region)}">${escapeHtml(region)}</option>`).join("");

  const getItems = () => {
    const source = state.view === "medicines" ? data.medicines : data.pharmacies;
    const term = normalized(state.query);
    let items = source.filter((item) => {
      const haystack = state.view === "medicines"
        ? normalized([item.name, item.arabicNames, item.code, item.category, item.unit].join(" "))
        : normalized([item.name, item.address, item.phone, item.governorate].join(" "));
      return (!term || haystack.includes(term))
        && (!state.category || state.view !== "medicines" || item.category === state.category)
        && (!state.region || state.view !== "pharmacies" || pharmacyRegion(item) === state.region)
        && (!state.favoritesOnly || favorites.has(`${state.view}:${item.id}`));
    });
    if (state.sort === "name") items = [...items].sort((a, b) => a.name.localeCompare(b.name, "ar"));
    if (state.view === "medicines" && state.sort === "quantity-desc") items = [...items].sort((a, b) => b.quantity - a.quantity);
    if (state.view === "medicines" && state.sort === "quantity-asc") items = [...items].sort((a, b) => a.quantity - b.quantity);
    return items;
  };

  const medicineCard = (item, index) => {
    const favorite = favorites.has(`medicines:${item.id}`);
    return `<article class="result-card" style="animation-delay:${Math.min(index * 35, 280)}ms">
      <div class="card-topline"><span class="product-icon" aria-hidden="true">✚</span><button class="favorite-button ${favorite ? "is-favorite" : ""}" data-favorite="medicines:${item.id}" aria-label="${favorite ? "إزالة من" : "إضافة إلى"} المفضلة" aria-pressed="${favorite}">${favorite ? "★" : "☆"}</button></div>
      <h4 class="card-title" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h4><p class="card-subtitle">${item.arabicNames ? `${escapeHtml(item.arabicNames.split(",")[0].trim())} · ` : ""}${escapeHtml(item.category)}</p>
      <div class="card-details"><span class="tag stock-tag"><span>✓</span> متاح حسب الملف</span><span class="tag">${escapeHtml(item.unit)}</span></div>
      <div class="card-footer"><span class="card-ref">${escapeHtml(item.code)} · ${Number(item.quantity).toLocaleString("ar-EG")}</span><span class="card-inline-actions"><button class="text-action" data-share-search="${item.id}" aria-label="مشاركة ${escapeHtml(item.name)} على واتساب">واتساب</button><button class="text-action" data-detail="${item.id}">التفاصيل <span>←</span></button></span></div>
    </article>`;
  };
  const pharmacyCard = (item, index) => {
    const favorite = favorites.has(`pharmacies:${item.id}`);
    const href = phoneHref(item.phone);
    const whatsapp = whatsappHref(item.whatsapp);
    const mapHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${item.name} ${item.address}`)}`;
    return `<article class="result-card pharmacy-result" style="animation-delay:${Math.min(index * 35, 280)}ms">
      <div class="card-topline"><span class="pharmacy-icon" aria-hidden="true">⌖</span><button class="favorite-button ${favorite ? "is-favorite" : ""}" data-favorite="pharmacies:${item.id}" aria-label="${favorite ? "إزالة من" : "إضافة إلى"} المفضلة" aria-pressed="${favorite}">${favorite ? "★" : "☆"}</button></div>
      <h4 class="card-title" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h4><p class="card-subtitle">${escapeHtml(item.address)}</p>
      <div class="pharmacy-telephone"><span>هاتف</span> ${href ? `<a href="${escapeHtml(href)}" aria-label="اتصل بـ ${escapeHtml(item.name)}" dir="ltr">${escapeHtml(item.phone)}</a>` : escapeHtml(item.phone)}</div>
      <div class="pharmacy-card-actions">
        ${href ? `<a class="pharmacy-action" href="${escapeHtml(href)}" aria-label="اتصل بـ ${escapeHtml(item.name)}"><span aria-hidden="true">☎</span> اتصال</a>` : ""}
        ${whatsapp ? `<a class="pharmacy-action" href="${escapeHtml(whatsapp)}" target="_blank" rel="noopener noreferrer" aria-label="راسل ${escapeHtml(item.name)} على واتساب"><span aria-hidden="true">◉</span> واتساب</a>` : ""}
        <a class="pharmacy-action" href="${escapeHtml(mapHref)}" target="_blank" rel="noopener noreferrer" aria-label="افتح موقع ${escapeHtml(item.name)} على الخرائط"><span aria-hidden="true">⌖</span> خريطة</a>
        <button class="pharmacy-action" type="button" data-detail="${item.id}"><span aria-hidden="true">ⓘ</span> التفاصيل</button>
      </div>
      <div class="card-footer"><span class="card-ref">صيدلية ${String(item.id).padStart(3, "0")}</span></div>
    </article>`;
  };

  const render = () => {
    const items = getItems();
    const visibleItems = items.slice(0, state.visible);
    const renderCard = state.view === "medicines" ? medicineCard : pharmacyCard;
    grid.innerHTML = visibleItems.map(renderCard).join("");
    grid.hidden = items.length === 0;
    $("#empty-state").hidden = items.length !== 0;
    $("#load-more").hidden = items.length <= state.visible;
    $("#results-title").textContent = state.view === "medicines" ? "الأدوية" : "الصيدليات";
    $("#results-count").textContent = `عرض ${visibleItems.length.toLocaleString("ar-EG")} من ${items.length.toLocaleString("ar-EG")} نتيجة`;
    $("#category-filter-wrap").hidden = state.view !== "medicines";
    $("#region-filter-wrap").hidden = state.view !== "pharmacies";
    $("#category-filter").value = state.category;
    $("#region-filter").value = state.region;
    $("#clear-search").hidden = !state.query;
    $$(".nav-link[data-view], .search-tab[data-view], .mobile-nav-item[data-view]").forEach((button) => {
      const active = button.dataset.view === state.view;
      button.classList.toggle("active", active);
      if (button.hasAttribute("aria-selected")) button.setAttribute("aria-selected", String(active));
    });
  };

  const showToast = (message) => {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    $("#toast-region").append(toast);
    window.setTimeout(() => {
      toast.classList.add("out");
      window.setTimeout(() => toast.remove(), 220);
    }, 2300);
  };

  const toggleFavorite = (key) => {
    if (favorites.has(key)) {
      favorites.delete(key);
      showToast("اتشالت من المفضلة.");
    } else {
      favorites.add(key);
      showToast("اتضافت للمفضلة.");
    }
    saveFavorites();
    render();
  };

  const detailMarkup = (item) => {
    if (state.view === "medicines") {
      return `<div class="dialog-heading"><span class="detail-hero-icon">✚</span><h2 id="dialog-title">${escapeHtml(item.name)}</h2><p>${escapeHtml(item.category)}</p></div>
        <div class="detail-grid">
          <div class="detail-cell"><small>كود الصنف</small><strong>${escapeHtml(item.code)}</strong></div>
          <div class="detail-cell"><small>الكمية المسجلة</small><strong>${Number(item.quantity).toLocaleString("ar-EG")} ${escapeHtml(item.unit)}</strong></div>
          <div class="detail-cell"><small>حالة المخزون بالملف</small><strong>${escapeHtml(item.stockStatus)}</strong></div>
          <div class="detail-cell"><small>الحد الأدنى المسجل</small><strong>${Number(item.minimum).toLocaleString("ar-EG")} ${escapeHtml(item.unit)}</strong></div>
          <div class="detail-cell"><small>كمية التوريد المقترحة</small><strong>${Number(item.suggestedSupply).toLocaleString("ar-EG")} ${escapeHtml(item.unit)}</strong></div>
          <div class="detail-cell"><small>طبيعة الدواء</small><strong>${escapeHtml(item.category)}</strong></div>
        </div>
        <p class="detail-disclaimer">الكمية والحالة من ملف المشروع، وليستا رصيدًا مباشرًا أو مرتبطًا بصيدلية بعينها. تواصل مع الصيدلية للتحقق قبل الزيارة، واستشر الطبيب أو الصيدلي بخصوص الاستخدام.</p>
        <div class="dialog-actions"><button class="button button-primary" data-add-needed="${item.id}" type="button">${currentUser?.role === "patient" && currentUser.requestedMedicineIds?.includes(item.id) ? "✓ ضمن أدويتك المطلوبة" : "＋ أضف لقائمة أدويتي"}</button><button class="button button-outline" data-open-feature="alerts" type="button">🔔 نبهني</button><button class="button button-outline" data-share-search="${item.id}" type="button">مشاركة على واتساب</button><button class="button button-outline" data-find-pharmacies type="button">استكشف الصيدليات</button><button class="button button-outline" data-favorite="medicines:${item.id}" type="button">${favorites.has(`medicines:${item.id}`) ? "★ محفوظ في المفضلة" : "☆ أضف للمفضلة"}</button></div>`;
    }
    const href = phoneHref(item.phone);
    const whatsapp = whatsappHref(item.whatsapp);
    const mapQuery = encodeURIComponent(`${item.name} ${item.address}`);
    return `<div class="dialog-heading"><span class="detail-hero-icon" style="background:#edf2fc;color:#527ac5">⌖</span><h2 id="dialog-title">${escapeHtml(item.name)}</h2><p>دليل الصيدليات · سجل رقم ${Number(item.id).toLocaleString("ar-EG")}</p></div>
      <div class="detail-grid">
        <div class="detail-cell"><small>العنوان كما ورد في الملف</small><strong>${escapeHtml(item.address)}</strong></div>
        <div class="detail-cell"><small>رقم التواصل</small><strong dir="ltr">${escapeHtml(item.phone)}</strong></div>
        ${item.openingTime && item.closingTime ? `<div class="detail-cell"><small>مواعيد العمل</small><strong dir="ltr">${escapeHtml(item.openingTime)} – ${escapeHtml(item.closingTime)}</strong></div>` : ""}
      </div>
      <p class="detail-disclaimer">العنوان ورقم التواصل من الملف المرفق. يُرجى التأكد من دقتهما ومواعيد العمل قبل التوجه للصيدلية.</p>
      <div class="dialog-actions">${href ? `<a class="button button-primary" href="${escapeHtml(href)}">☎ اتصل بالصيدلية</a>` : ""}${whatsapp ? `<a class="button button-outline" href="${escapeHtml(whatsapp)}" target="_blank" rel="noopener noreferrer">◉ واتساب</a>` : ""}<a class="button button-outline" href="https://www.google.com/maps/search/?api=1&query=${mapQuery}" target="_blank" rel="noopener noreferrer">⌖ افتح الخرائط</a><button class="button button-outline" data-favorite="pharmacies:${item.id}" type="button">${favorites.has(`pharmacies:${item.id}`) ? "★ محفوظة" : "☆ أضف للمفضلة"}</button></div>`;
  };

  const openDetail = (id) => {
    const source = state.view === "medicines" ? data.medicines : data.pharmacies;
    const item = source.find((entry) => entry.id === Number(id));
    if (!item) return;
    $("#dialog-content").innerHTML = detailMarkup(item);
    dialog.showModal();
  };

  const setView = (view) => {
    if (view !== "medicines" && view !== "pharmacies") return;
    if (view !== state.view) {
      state.category = "";
      state.region = "";
      $("#category-filter").value = "";
      $("#region-filter").value = "";
    }
    state.view = view;
    state.visible = pageSize;
    state.favoritesOnly = false;
    $("#favorites-filter").setAttribute("aria-pressed", "false");
    render();
    $("#directory").scrollIntoView({ behavior: "smooth", block: "start" });
  };

  window.addEventListener("dawaey:medicine-detail", (event) => {
    const medicineId = Number(event.detail?.id);
    if (!data.medicines.some((item) => item.id === medicineId)) return;
    state.query = "";
    state.category = "";
    state.region = "";
    search.value = "";
    setView("medicines");
    openDetail(medicineId);
  });

  $$(".nav-link[data-view], .search-tab[data-view], .mobile-nav-item[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#category-filter").addEventListener("change", (event) => { state.category = event.target.value; state.visible = pageSize; render(); });
  $("#region-filter").addEventListener("change", (event) => { state.region = event.target.value; state.visible = pageSize; render(); });
  $("#sort-filter").addEventListener("change", (event) => { state.sort = event.target.value; state.visible = pageSize; render(); });
  $("#favorites-filter").addEventListener("click", (event) => {
    state.favoritesOnly = !state.favoritesOnly;
    event.currentTarget.setAttribute("aria-pressed", String(state.favoritesOnly));
    state.visible = pageSize;
    render();
  });
  search.addEventListener("input", () => { state.query = search.value; state.visible = pageSize; render(); });
  $("#clear-search").addEventListener("click", () => { search.value = ""; state.query = ""; state.visible = pageSize; render(); search.focus(); });
  $("#load-more").addEventListener("click", () => { state.visible += pageSize; render(); });
  $("#reset-search").addEventListener("click", () => {
    state.query = ""; state.category = ""; state.region = ""; state.favoritesOnly = false; state.visible = pageSize;
    search.value = ""; $("#favorites-filter").setAttribute("aria-pressed", "false");
    render();
  });
  grid.addEventListener("click", (event) => {
    const favoriteButton = event.target.closest("[data-favorite]");
    if (favoriteButton) return toggleFavorite(favoriteButton.dataset.favorite);
    const detailButton = event.target.closest("[data-detail]");
    if (detailButton) openDetail(detailButton.dataset.detail);
    const shareButton = event.target.closest("[data-share-search]");
    if (shareButton) {
      const medicine = data.medicines.find((item) => item.id === Number(shareButton.dataset.shareSearch));
      if (medicine) {
        const url = new URL(window.location.href);
        url.hash = "directory";
        url.searchParams.set("medicine", medicine.name);
        const text = `دواء ${medicine.name} في دليل دوائي: ${url.href} — تحققي من التوفر مع الصيدلية.`;
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
      }
    }
  });
  $("#dialog-content").addEventListener("click", (event) => {
    const openFeature = event.target.closest("[data-open-feature]");
    if (openFeature) {
      window.dispatchEvent(new CustomEvent("dawaey:feature", { detail: { feature: openFeature.dataset.openFeature } }));
      return;
    }
    const shareButton = event.target.closest("[data-share-search]");
    if (shareButton) {
      const medicine = data.medicines.find((item) => item.id === Number(shareButton.dataset.shareSearch));
      if (medicine) {
        const url = new URL(window.location.href);
        url.hash = "directory";
        url.searchParams.set("medicine", medicine.name);
        window.open(`https://wa.me/?text=${encodeURIComponent(`دواء ${medicine.name} في دليل دوائي: ${url.href} — تحققي من التوفر مع الصيدلية.`)}`, "_blank", "noopener,noreferrer");
      }
      return;
    }
    const favoriteButton = event.target.closest("[data-favorite]");
    if (favoriteButton) {
      const key = favoriteButton.dataset.favorite;
      toggleFavorite(key);
      const id = Number(key.split(":")[1]);
      const item = key.startsWith("medicines:") ? data.medicines.find((entry) => entry.id === id) : data.pharmacies.find((entry) => entry.id === id);
      if (item) $("#dialog-content").innerHTML = detailMarkup(item);
    }
    if (event.target.closest("[data-find-pharmacies]")) {
      dialog.close();
      setView("pharmacies");
    }
  });
  $(".dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  $("#go-search").addEventListener("click", () => { $("#directory").scrollIntoView({ behavior: "smooth" }); window.setTimeout(() => search.focus(), 350); });
  $("#hero-search").addEventListener("click", () => { setView("medicines"); window.setTimeout(() => search.focus(), 350); });
  $("#hero-pharmacies").addEventListener("click", () => setView("pharmacies"));
  $("#callout-search").addEventListener("click", () => { setView("medicines"); window.setTimeout(() => search.focus(), 350); });
  $("#mobile-search").addEventListener("click", () => { $("#directory").scrollIntoView({ behavior: "smooth" }); window.setTimeout(() => search.focus(), 350); });
  $("#back-to-top").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

  const setTheme = (theme) => {
    document.body.classList.toggle("dark", theme === "dark");
    try { localStorage.setItem("dawaey-theme", theme); } catch (error) { console.warn("تعذر حفظ تفضيل المظهر:", error); }
    $("#theme-toggle").setAttribute("aria-label", theme === "dark" ? "تفعيل الوضع النهاري" : "تفعيل الوضع الليلي");
  };
  let savedTheme = "light";
  try { savedTheme = localStorage.getItem("dawaey-theme") || "light"; } catch (error) { console.warn("تعذر قراءة تفضيل المظهر:", error); }
  setTheme(savedTheme);
  const toggleTheme = () => setTheme(document.body.classList.contains("dark") ? "light" : "dark");
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#mobile-theme").addEventListener("click", toggleTheme);
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      $("#directory").scrollIntoView({ behavior: "smooth" });
      window.setTimeout(() => search.focus(), 350);
    }
    if (event.key === "Escape" && dialog.open) dialog.close();
  });

  $("#export-data").addEventListener("click", () => {
    const items = getItems();
    const rows = state.view === "medicines"
      ? [["رقم", "اسم الدواء", "الكود", "التصنيف", "الوحدة", "الكمية المسجلة", "الحالة", "الحد الأدنى", "كمية التوريد المقترحة"],
        ...items.map((item) => [item.id, item.name, item.code, item.category, item.unit, item.quantity, item.stockStatus, item.minimum, item.suggestedSupply])]
      : [["رقم", "اسم الصيدلية", "العنوان", "رقم التواصل"], ...items.map((item) => [item.id, item.name, item.address, item.phone])];
    const csv = "\uFEFF" + rows.map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = state.view === "medicines" ? "dawaey-medicines.csv" : "dawaey-pharmacies.csv";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`جهزنا ملف CSV فيه ${items.length.toLocaleString("ar-EG")} نتيجة.`);
  });

  const escapeAttr = escapeHtml;
  const egyptGovernorates = ["القاهرة", "الجيزة", "الإسكندرية", "القليوبية", "الشرقية", "الدقهلية", "البحيرة", "الغربية", "المنوفية", "كفر الشيخ", "دمياط", "بورسعيد", "الإسماعيلية", "السويس", "شمال سيناء", "جنوب سيناء", "الفيوم", "بني سويف", "المنيا", "أسيوط", "سوهاج", "قنا", "الأقصر", "أسوان", "البحر الأحمر", "الوادي الجديد", "مطروح"];
  const authStory = (kicker, title, description) => `<aside class="auth-story">
    <div class="auth-story-brand"><span class="brand-mark"><img src="logo-mark.png" alt=""></span> دوائي · أقرب لسلامتك</div>
    <div class="auth-story-copy"><span class="auth-story-kicker"><span>✦</span> ${escapeHtml(kicker)}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>
    <div class="auth-story-art" aria-hidden="true"><span class="story-orbit"></span><span class="story-map-line"></span><span class="story-pin"><span>✚</span></span><span class="story-capsule"></span></div>
    <div class="auth-story-foot">حسابك وبياناتك محفوظة على خادم دوائي المركزي.</div>
  </aside>`;
  const authLayout = (kicker, title, description, content) => `<div class="auth-layout">${authStory(kicker, title, description)}<section class="auth-main">${content}</section></div>`;
  const authHeader = (kicker, title, description) => `<div class="auth-kicker">${escapeHtml(kicker)}</div><h1 class="auth-title" id="auth-title">${escapeHtml(title)}</h1><p class="auth-description">${escapeHtml(description)}</p>`;
  const authField = (id, label, options = {}) => {
    const { type = "text", placeholder = "", required = true, autocomplete = "", value = "", hint = "", attrs = "" } = options;
    return `<div class="auth-field"><label for="${id}">${escapeHtml(label)}${required ? " *" : ""}</label><input id="${id}" name="${id}" type="${type}" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" ${required ? "required" : ""} ${autocomplete ? `autocomplete="${autocomplete}"` : ""} ${attrs}><span class="field-error" data-error-for="${id}"></span>${hint ? `<small class="password-hint">${hint}</small>` : ""}</div>`;
  };
  const passwordField = (id, label, autocomplete) => `<div class="auth-field"><label for="${id}">${escapeHtml(label)} *</label><div class="password-wrap"><input id="${id}" name="${id}" type="password" required autocomplete="${autocomplete}" minlength="8" placeholder="٨ أحرف على الأقل"><button class="password-toggle" type="button" data-toggle-password="${id}">إظهار</button></div><div class="password-meter" data-meter-for="${id}" data-strength="0"><i></i><i></i><i></i><i></i></div><span class="field-error" data-error-for="${id}"></span><small class="password-hint" data-password-hint="${id}">استخدمي حروفًا وأرقامًا لزيادة قوة كلمة المرور.</small></div>`;
  const governorateOptions = (selected = "") => `<option value="">اختاري المحافظة</option>${egyptGovernorates.map((name) => `<option value="${escapeAttr(name)}" ${selected === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
  const contactInput = (label = "الموبايل أو البريد الإلكتروني") => authField("contact", label, { placeholder: "01xxxxxxxxx أو name@email.com", autocomplete: "username", attrs: 'inputmode="email"' });
  const backLink = (mode = "choice", label = "رجوع") => `<button class="auth-link auth-back" type="button" data-auth-mode="${mode}">→ ${escapeHtml(label)}</button>`;

  const showAuth = (mode = "choice") => {
    authMode = mode;
    authDialog.showModal();
    renderAuth();
  };
  const openRoleAccount = (role) => {
    if (currentUser?.role === role) {
      authMode = "account";
      authDialog.showModal();
      renderAuth();
      return;
    }
    showAuth(`${role}-login`);
  };
  const renderAuth = () => {
    if (authMode === "choice") {
      authContent.innerHTML = authLayout("أهلاً بيك في دوائي", "نبدأ من هنا؟", "اختاري نوع الحساب المناسب؛ تقدري تعملي حسابًا للمريض وحسابًا مستقلًا للصيدلية حتى لو بنفس رقم الموبايل.", `${authHeader("حساب جديد أو مسجل", "اختاري نوع الحساب", "بيانات المريض وبيانات الصيدلية تُحفظ في ملفين منفصلين. اختاري نوع الحساب عند التسجيل أو الدخول.")}<div class="account-choice-grid"><button class="account-choice patient" type="button" data-auth-mode="patient-signup"><span class="account-choice-icon">♡</span><strong>تسجيل حساب مريض جديد</strong><small>ابحثي عن دوائك واحتفظي بقائمة أدويتك المطلوبة.</small></button><button class="account-choice pharmacy" type="button" data-auth-mode="pharmacy-signup"><span class="account-choice-icon">✚</span><strong>تسجيل صيدلية جديدة</strong><small>أنشئي حسابًا للصيدلية وقدّمي طلب الانضمام للمراجعة.</small></button></div><div class="account-login-grid"><button class="button button-outline" type="button" data-auth-mode="patient-login">عندي حساب مريض بالفعل — تسجيل الدخول</button><button class="button button-outline" type="button" data-auth-mode="pharmacy-login">عندي حساب صيدلية بالفعل — تسجيل الدخول</button></div>`);
    } else if (authMode === "login") {
      authContent.innerHTML = authLayout("نورت دوائي", "تسجيل الدخول", "ادخلي بيانات الحساب للوصول إلى أدويتك ومعلوماتك المحفوظة.", `${backLink("choice")}${authHeader("أهلاً بعودتك", "سجّلي الدخول", "استخدمي رقم الموبايل أو البريد وكلمة المرور.")}<form class="auth-form" id="login-form" novalidate>${contactInput()}${passwordField("login-password", "كلمة المرور", "current-password")}<div class="auth-actions"><button class="auth-link" type="button" data-auth-mode="forgot-request">نسيت كلمة المرور؟</button><button class="auth-link" type="button" data-auth-mode="otp-request">الدخول بكود OTP</button></div><button class="button button-primary auth-submit" type="submit">دخول آمن</button></form><div class="auth-separator" style="margin:16px 0">أو</div><button class="google-button" type="button" data-auth-mode="google"><span class="google-g">G</span> المتابعة باستخدام Google</button><p class="auth-switch">لسه معندكيش حساب؟ <button class="auth-link" type="button" data-auth-mode="choice">إنشاء حساب جديد</button></p>`);
    } else if (authMode === "patient-login") {
      authContent.innerHTML = authLayout("حساب المريض", "مرحبًا بعودتك", "ادخلي إلى حساب المريض المسجل لمتابعة بياناتك وأدويتك المحفوظة.", `${backLink("choice")}${authHeader("مريض / مستخدم مسجل", "دخول حساب المريض", "استخدمي رقم الموبايل أو البريد وكلمة المرور المسجلين.")}<form class="auth-form" id="patient-login-form" novalidate>${contactInput()}${passwordField("login-password", "كلمة المرور", "current-password")}<div class="auth-actions"><button class="auth-link" type="button" data-auth-mode="forgot-request">نسيت كلمة المرور؟</button><button class="auth-link" type="button" data-auth-mode="otp-request">الدخول بكود OTP</button></div><button class="button button-primary auth-submit" type="submit">دخول إلى حسابي</button></form><p class="auth-switch">أول مرة؟ <button class="auth-link" type="button" data-auth-mode="patient-signup">إنشاء حساب مريض جديد</button></p>`);
    } else if (authMode === "pharmacy-login") {
      authContent.innerHTML = authLayout("حساب الصيدلية", "مرحبًا بعودتك", "سجّلي الدخول ببيانات الحساب التي أنشأتها الصيدلية.", `${backLink("choice")}${authHeader("صيدلية مسجلة", "دخول حساب الصيدلية", "استخدمي رقم الموبايل المسجل وكلمة المرور.")}<form class="auth-form" id="pharmacy-login-form" novalidate>${contactInput("رقم موبايل الصيدلية")}${passwordField("login-password", "كلمة المرور", "current-password")}<button class="button button-primary auth-submit" type="submit">دخول إلى ملف الصيدلية</button></form><p class="auth-switch">أول مرة؟ <button class="auth-link" type="button" data-auth-mode="pharmacy-signup">تسجيل صيدلية جديدة</button></p>`);
    } else if (authMode === "patient-signup") {
      authContent.innerHTML = authLayout("حساب المريض", "حسابك الصحي يبدأ هنا", "سجّلي بياناتك الأساسية، وبعدها نجهّزلك إعداداتك وأدويتك المطلوبة.", `${backLink("choice")}${authHeader("إنشاء حساب مريض", "بياناتك الأساسية", "الحقول بعلامة * مطلوبة.")}<form class="auth-form" id="patient-signup-form" novalidate>
        ${authField("patient-name", "الاسم بالكامل", { placeholder: "الاسم كما تحبين أن يظهر", autocomplete: "name", attrs: 'minlength="2"' })}
        ${contactInput()}
        ${passwordField("patient-password", "كلمة المرور", "new-password")}
        ${authField("patient-password-confirm", "تأكيد كلمة المرور", { type: "password", placeholder: "أعيدي كتابة كلمة المرور", autocomplete: "new-password", attrs: 'minlength="8"' })}
        <div class="auth-row"><div class="auth-field"><label for="patient-governorate">المحافظة *</label><select id="patient-governorate" name="patient-governorate" required>${governorateOptions()}</select><span class="field-error" data-error-for="patient-governorate"></span></div>${authField("patient-area", "المنطقة / الحي", { placeholder: "مثال: مدينة نصر", autocomplete: "address-level3", required: false })}</div>
        <label class="auth-check"><input type="checkbox" id="privacy-consent" required><span>أوافق على <button type="button" class="auth-link" data-privacy>سياسة الخصوصية</button> وأفهم أن بيانات الحساب تحفظ في قاعدة دوائي المركزية. *</span></label><span class="field-error" data-error-for="privacy-consent"></span>
        <button class="button button-primary auth-submit" type="submit">إنشاء الحساب والمتابعة</button></form><p class="auth-switch">عندك حساب مريض؟ <button class="auth-link" type="button" data-auth-mode="patient-login">سجّلي الدخول</button></p>`);
    } else if (authMode === "pharmacy-signup") {
      authContent.innerHTML = authLayout("حساب الصيدلية", "انضمي لدليل دوائي", "أكملي بيانات الصيدلية؛ هتفضل قيد المراجعة لحد اعتمادها من الإدارة.", `${backLink("choice")}${authHeader("طلب انضمام صيدلية", "بيانات الصيدلية", "كل البيانات المطلوبة تساعدنا نراجع الطلب.")}<form class="auth-form" id="pharmacy-signup-form" novalidate>
        <div class="pharmacy-form-grid">
          ${authField("pharmacy-name", "اسم الصيدلية بالكامل كما في الترخيص", { placeholder: "اكتبي الاسم التجاري كاملًا دون اختصار", autocomplete: "organization", attrs: 'minlength="3" maxlength="120"' })}
          ${authField("pharmacy-license", "رقم الترخيص / السجل", { placeholder: "رقم الترخيص الرسمي" })}
          ${authField("pharmacy-phone", "رقم الموبايل", { placeholder: "01xxxxxxxxx", autocomplete: "tel", attrs: 'inputmode="tel"' })}
          ${authField("pharmacy-whatsapp", "رقم واتساب", { placeholder: "01xxxxxxxxx", autocomplete: "tel", attrs: 'inputmode="tel"' })}
          ${passwordField("pharmacy-password", "كلمة مرور حساب الصيدلية", "new-password")}
          ${authField("pharmacy-password-confirm", "تأكيد كلمة المرور", { type: "password", placeholder: "أعيدي كتابة كلمة المرور", autocomplete: "new-password", attrs: 'minlength="8"' })}
          <div class="auth-field"><label for="pharmacy-governorate">المحافظة *</label><select id="pharmacy-governorate" name="pharmacy-governorate" required>${governorateOptions()}</select><span class="field-error" data-error-for="pharmacy-governorate"></span></div>
          <div class="auth-field"><label for="pharmacy-area">المنطقة / الحي *</label><input id="pharmacy-area" name="pharmacy-area" required placeholder="المنطقة أو الحي"><span class="field-error" data-error-for="pharmacy-area"></span></div>
          ${authField("pharmacy-address", "العنوان بالتفصيل", { placeholder: "الشارع ورقم العقار وعلامة مميزة" })}
          <div class="auth-field"><label for="pharmacy-opening">مواعيد العمل *</label><div class="auth-row"><input id="pharmacy-opening" type="time" required aria-label="موعد فتح الصيدلية"><input id="pharmacy-closing" type="time" required aria-label="موعد إغلاق الصيدلية"></div><span class="field-error" data-error-for="pharmacy-opening"></span></div>
          <div class="auth-field wide"><span class="auth-label">موقع الصيدلية على الخريطة (اختياري)</span><div class="map-picker" id="pharmacy-map"><div class="map-placeholder"><span>⌖</span><strong>حددي موقع الصيدلية لو حابة</strong><small>اختاري نقطة على الخريطة؛ التسجيل ممكن من غيرها</small></div></div><div class="map-coordinates"><span id="map-coordinates-label">لم يتم تحديد الموقع (اختياري)</span><button class="location-button" type="button" id="use-pharmacy-location">استخدمي موقعي</button></div><span class="field-error" data-error-for="pharmacy-location"></span></div>
          <div class="auth-field wide"><label class="auth-check"><input type="checkbox" id="pharmacy-consent" required><span>أقر بصحة البيانات وأوافق على مراجعتها قبل نشر الصيدلية. *</span></label><span class="field-error" data-error-for="pharmacy-consent"></span></div>
        </div><div class="auth-notice">النجمة (*) تعني أن الحقل مطلوب. بعد الإرسال سيظهر الطلب «قيد المراجعة»، ولن تظهر الصيدلية في الدليل إلا بعد اعتماد الإدارة. رفع صورة غير مطلوب.</div><button class="button button-primary auth-submit" type="submit">إرسال طلب المراجعة</button></form>`);
      setupPharmacyMap();
    } else if (authMode === "otp-request" || authMode === "forgot-request") {
      const forgot = authMode === "forgot-request";
      authContent.innerHTML = authLayout("حساب مركزي", forgot ? "استعادة كلمة المرور" : "دخول برمز الموبايل", forgot ? "استعادة الحساب تحتاج ربط مزود رسائل موثوق." : "رمز OTP غير متاح حتى ربط مزود SMS بالخادم.", `${backLink("login")}${authHeader(forgot ? "استعادة الحساب" : "دخول بدون كلمة مرور", forgot ? "استعادة آمنة" : "تسجيل دخول آمن")}<div class="auth-notice warning">${forgot ? "لا نعرض رمز استعادة وهميًا ولا نغيّر كلمة المرور محليًا. تواصلي مع مسؤول النظام لاستعادة الحساب." : "لأمان الحساب المركزي، لا نستخدم رمزًا تجريبيًا يمكن توليده داخل المتصفح. استخدمي كلمة المرور حاليًا."}</div><button class="button button-primary auth-submit" type="button" data-auth-mode="login">العودة لتسجيل الدخول</button>`);
    } else if (authMode === "otp-verify" || authMode === "reset-password") {
      const reset = authMode === "reset-password";
      authContent.innerHTML = authLayout(reset ? "تأكيد استعادة الحساب" : "التحقق من رقم الموبايل", reset ? "اختاري كلمة مرور جديدة" : "اكتبي كود التحقق", reset ? "بعد التحقق، كلمة المرور القديمة لن تعود صالحة." : "الكود مخصص لهذه المحاكاة ويظهر أدناه بدل رسالة SMS.", `${backLink(reset ? "forgot-request" : "otp-request")}${authHeader(reset ? "استعادة كلمة المرور" : "كود التحقق", reset ? "تغيير كلمة المرور" : "تحققي من الكود", `رقم الموبايل: ${escapeHtml(authState.contact || "")}`)}<div class="demo-otp">كود المحاكاة لهذا الجهاز: <strong dir="ltr">${escapeHtml(pendingOtp)}</strong></div><form class="auth-form" id="${reset ? "reset-password-form" : "otp-verify-form"}" novalidate>${reset ? `${passwordField("reset-password", "كلمة المرور الجديدة", "new-password")}${authField("reset-password-confirm", "تأكيد كلمة المرور", { type: "password", placeholder: "أعيدي كتابة كلمة المرور", autocomplete: "new-password" })}` : authField("otp-code", "كود التحقق", { placeholder: "أدخلي الكود المكوّن من ٦ أرقام", attrs: 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })}<button class="button button-primary auth-submit" type="submit">${reset ? "حفظ كلمة المرور الجديدة" : "تحقق ودخول"}</button></form>`);
      if (reset) {
        $("#reset-password-form").insertAdjacentHTML("afterbegin", authField("otp-code", "كود التحقق", { placeholder: "أدخلي الكود المكوّن من ٦ أرقام", attrs: 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"' }));
      }
    } else if (authMode === "google") {
      authContent.innerHTML = authLayout("تسجيل مركزي", "المتابعة باستخدام Google", "تسجيل Google يحتاج إعداد OAuth حقيقي لدى مزود الهوية.", `${backLink("login")}${authHeader("OAuth غير مفعّل", "المتابعة غير متاحة حاليًا", "لمنع إنشاء حسابات غير موثقة، لا نقبل بريدًا مكتوبًا يدويًا كدخول Google.")}<div class="auth-notice warning">استخدمي البريد أو الموبايل وكلمة المرور، أو اربطي مزود Google قبل تفعيل هذا الخيار.</div><button class="button button-primary auth-submit" type="button" data-auth-mode="login">العودة لتسجيل الدخول</button>`);
    } else if (authMode === "onboarding") {
      renderOnboarding();
    } else if (authMode === "account") {
      renderAccount();
    }
  };
  const authState = { contact: "", flow: "login", onboardingStep: 0 };

  const persistAccounts = () => {
    try {
      localStorage.setItem(accountStoreKey, JSON.stringify(accounts));
      return true;
    } catch (error) {
      console.error("تعذر حفظ بيانات الحساب في التخزين المحلي:", error);
      showToast("تعذر حفظ الحساب؛ مساحة التخزين المحلية غير متاحة.");
      return false;
    }
  };
  const saveCurrentUser = async (updates = {}) => {
    if (!currentUser) throw new Error("سجّلي الدخول أولًا لحفظ بيانات الحساب.");
    const accountId = currentUser.id;
    const allowedFields = ["name", "governorate", "area", "onboardingComplete", "notificationPreference", "notificationPermission", "location", "requestedMedicineIds", "chronicMedicineIds"];
    const profile = Object.fromEntries(allowedFields
      .filter((key) => key in updates)
      .map((key) => [key, updates[key]]));
    const { user } = await apiRequest("/api/profile", {
      method: "PUT",
      body: JSON.stringify({ profile })
    });
    if (currentUser?.id !== accountId) throw new Error("تغير الحساب قبل اكتمال الحفظ. سجّلي الدخول مجددًا للتحقق من بياناتك.");
    setCurrentUser({ ...currentUser, ...user });
    return true;
  };
  const apiRequest = async (path, options = {}) => {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
    });
    const responseText = await response.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error(response.ok
        ? "استجابة الخادم غير صالحة. حدّثي الصفحة وحاولي مرة أخرى."
        : `الخدمة المطلوبة غير متاحة على الخادم (HTTP ${response.status}).`);
    }
    if (!response.ok) throw new Error(result.error || "تعذر الاتصال بالخادم.");
    return result;
  };
  const normalizeContact = (value) => {
    const westernDigits = String(value).replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
    const trimmed = westernDigits.trim().toLowerCase();
    if (trimmed.includes("@")) return trimmed;
    const digits = trimmed.replace(/\D/g, "");
    if (digits.startsWith("20") && digits.length === 12) return `0${digits.slice(2)}`;
    if (digits.length === 10 && /^1[0125]/.test(digits)) return `0${digits}`;
    return digits;
  };
  const isValidContact = (value) => {
    const normalizedValue = normalizeContact(value);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedValue) || /^(?:\+?20)?0?1[0125]\d{8}$/.test(normalizedValue);
  };
  const isValidEgyptianMobile = (value) => /^(?:\+?20)?0?1[0125]\d{8}$/.test(normalizeContact(value));
  const strengthOf = (value) => {
    let score = 0;
    if (value.length >= 8) score++;
    if (/[a-z]/.test(value)) score++;
    if (/[A-Z]/.test(value)) score++;
    if (/\d/.test(value)) score++;
    if (/[^A-Za-z0-9]/.test(value)) score++;
    return Math.min(score, 4);
  };
  const passwordMeetsPolicy = (value) => value.length >= 8 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
  const setFieldError = (id, message = "") => {
    const input = document.getElementById(id);
    const error = authContent.querySelector(`[data-error-for="${id}"]`);
    if (input) input.setAttribute("aria-invalid", String(Boolean(message)));
    if (error) error.textContent = message;
  };
  const validateAuthForm = (form, onlyInput = null) => {
    let valid = true;
    form.querySelectorAll("input,select,textarea").forEach((input) => {
      if (onlyInput && input !== onlyInput) return;
      if (input.type === "checkbox") {
        const checked = input.checked;
        setFieldError(input.id, input.required && !checked ? "الموافقة مطلوبة للمتابعة." : "");
        if (input.required && !checked) valid = false;
        return;
      }
      const value = input.value.trim();
      let message = "";
      if (input.required && !value) message = "الحقل ده مطلوب.";
      else if (input.id === "contact" && value && !isValidContact(value)) message = "اكتبي رقم موبايل مصري صحيح أو بريد إلكتروني صحيح.";
      else if (input.id === "otp-contact" && value && !isValidEgyptianMobile(value)) message = "اكتبي رقم موبايل مصري صحيح.";
      else if (input.id === "pharmacy-phone" && value && !isValidEgyptianMobile(value)) message = "اكتبي رقم موبايل مصري صحيح.";
      else if (input.id === "pharmacy-whatsapp" && value && !isValidEgyptianMobile(value)) message = "اكتبي رقم واتساب مصري صحيح.";
      else if (input.type === "email" && value && !input.validity.valid) message = "اكتبي بريدًا إلكترونيًا صحيحًا.";
      else if (input.minLength > 0 && value.length < input.minLength) message = `استخدمي ${input.minLength} أحرف على الأقل.`;
      else if (input.id.includes("password") && value && input.id !== "login-password" && input.id !== "otp-code" && !passwordMeetsPolicy(value)) message = "استخدمي ٨ أحرف على الأقل مع حروف كبيرة وصغيرة ورقم.";
      else if (input.id === "patient-password-confirm" && value !== $("#patient-password")?.value) message = "تأكيد كلمة المرور غير مطابق.";
      else if (input.id === "reset-password-confirm" && value !== $("#reset-password")?.value) message = "تأكيد كلمة المرور غير مطابق.";
      else if (input.id === "otp-code" && value !== pendingOtp) message = "كود التحقق غير صحيح.";
      else if (input.id === "pharmacy-opening" && value && $("#pharmacy-closing").value && value >= $("#pharmacy-closing").value) message = "موعد الإغلاق لازم يكون بعد موعد الفتح.";
      else if (form.id === "patient-signup-form" && input.id === "contact" && value && isContactTaken(value, "patient")) message = "وسيلة التواصل دي مسجلة بالفعل لحساب مريض. سجّلي الدخول بدل إنشاء حساب مكرر.";
      else if (form.id === "pharmacy-signup-form" && input.id === "pharmacy-phone" && value && isContactTaken(value, "pharmacy")) message = "رقم الموبايل مسجل بالفعل لحساب صيدلية.";
      else if (form.id === "pharmacy-signup-form" && input.id === "pharmacy-whatsapp" && value && isContactTaken(value, "pharmacy")) message = "رقم واتساب مسجل بالفعل لحساب صيدلية.";
      else if (input.id === "pharmacy-password-confirm" && value !== $("#pharmacy-password")?.value) message = "تأكيد كلمة المرور غير مطابق.";
      setFieldError(input.id, message);
      if (message) valid = false;
    });
    return valid;
  };
  const derivePasswordHash = async (password, saltHex) => {
    if (!crypto?.subtle || !crypto?.getRandomValues) throw new Error("يلزم فتح الموقع عبر localhost أو HTTPS لتفعيل حماية كلمة المرور.");
    const salt = saltHex ? Uint8Array.from(saltHex.match(/.{2}/g).map((byte) => parseInt(byte, 16))) : crypto.getRandomValues(new Uint8Array(16));
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, material, 256);
    return { salt: [...salt].map((byte) => byte.toString(16).padStart(2, "0")).join(""), hash: [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
  };
  const verifyPassword = async (password, user) => {
    if (!user.passwordHash || !user.passwordSalt) return false;
    const derived = await derivePasswordHash(password, user.passwordSalt);
    return derived.hash === user.passwordHash;
  };
  const findAccount = (contact, role = null) => accounts.find((account) =>
    (!role || account.role === role)
    && [account.contact, account.phone].some((stored) => stored && normalizeContact(stored) === normalizeContact(contact))
  );
  const isContactTaken = (contact, role) => accounts.some((account) =>
    account.role === role
    && [account.contact, account.phone, account.whatsapp].some((stored) => stored && normalizeContact(stored) === normalizeContact(contact))
  );
  const updateAuthButton = () => {
    const button = $("#auth-open");
    if (!button) return;
    const roleLabel = currentUser?.role === "pharmacy" ? "حساب صيدلية"
      : currentUser?.role === "patient" ? "حساب مريض" : "";
    button.textContent = currentUser
      ? `${roleLabel} · ${String(currentUser.name || currentUser.pharmacyName || "").split(" ")[0]}`
      : "دخول / حساب جديد";
    button.setAttribute("aria-label", currentUser ? "فتح حسابي" : "تسجيل الدخول أو إنشاء حساب");
    authDialog.querySelector(".auth-close").hidden = false;
    $$("[data-account-role]").forEach((roleButton) => {
      const role = roleButton.dataset.accountRole;
      const active = currentUser?.role === role;
      roleButton.classList.toggle("account-role-current", active);
      roleButton.setAttribute("aria-label", active
        ? `حساب ${role === "patient" ? "المريض" : "الصيدلية"} الحالي`
        : `دخول أو إنشاء حساب ${role === "patient" ? "مريض" : "صيدلية"}`);
    });
  };
  const setCurrentUser = (user) => {
    currentUser = user;
    try {
      if (user) {
        const existingIndex = accounts.findIndex((account) => account.id === user.id);
        if (existingIndex < 0) accounts.push(user);
        else accounts[existingIndex] = { ...accounts[existingIndex], ...user };
        persistAccounts();
        localStorage.setItem(activeAccountKey, user.id);
      }
      else localStorage.removeItem(activeAccountKey);
    } catch (error) {
      console.warn("تعذر حفظ جلسة الحساب:", error);
    }
    updateAuthButton();
    window.dispatchEvent(new CustomEvent("dawaey:account-changed", { detail: { user } }));
  };
  const finishLogin = (user) => {
    setCurrentUser(user);
    authMode = "account";
    if (user.role === "patient" || user.role === "pharmacy") renderAuth();
    else authDialog.close();
    showToast(user.role === "pharmacy" && user.status === "pending"
      ? "تم تسجيل الدخول. طلب الصيدلية ما زال قيد المراجعة."
      : "تم تسجيل الدخول بنجاح.");
    if (user.role === "patient" && pendingMedicineId) {
      addRequestedMedicine(pendingMedicineId);
      pendingMedicineId = null;
    }
  };
  const createAccountId = () => `usr_${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  const addRequestedMedicine = (medicineId) => {
    if (!currentUser || currentUser.role !== "patient") {
      pendingMedicineId = medicineId;
      showAuth(currentUser ? "account" : "choice");
      showToast("سجّلي دخولك كمريض عشان نحفظ الدواء في قائمتك.");
      return;
    }
    const requestedMedicineIds = [...new Set([...(currentUser.requestedMedicineIds || []), medicineId])];
    saveCurrentUser({ requestedMedicineIds }).then(() => {
      renderAuth();
      showToast("اتحفظ الدواء في قائمة أدويتك المطلوبة.");
    }).catch((error) => {
      console.error("تعذر حفظ الدواء في ملف المريض:", error);
      showToast(error.message || "تعذر حفظ الدواء على الخادم. حاولي مرة تانية.");
    });
  };

  const renderOnboarding = () => {
    if (!currentUser || currentUser.role !== "patient") return;
    const step = authState.onboardingStep;
    const progress = `<div class="onboarding-progress">${[0, 1, 2].map((index) => `<i class="${index <= step ? "done" : ""}"></i>`).join("")}</div>`;
    if (step === 0) {
      authContent.innerHTML = authLayout("إعداد حسابك · ١ من ٣", "نحدد منطقتك؟", "موقعك يساعدك تعرفي نطاق البحث؛ تقدري ترفضي أو تتخطي الخطوة.", `${authHeader("اختياري", "اختاري منطقتك", "مشاركة الموقع اختيارية، وتقدري تكملي بالمحافظة والمنطقة اللي سجلتيهم.")}${progress}<div class="auth-notice">إذا شاركتِ موقعك الدقيق فسيُحفظ ضمن ملفك على الخادم المركزي.</div><div class="auth-actions" style="margin-top:18px"><button class="button button-primary" type="button" data-onboarding-location>استخدمي موقعي الحالي</button><button class="auth-link" type="button" data-onboarding-next>التالي</button></div><button class="auth-link" type="button" data-onboarding-skip>تخطي الإعداد</button>`);
    } else if (step === 1) {
      const picks = data.medicines.map((medicine) => `<label class="onboarding-medicine" data-medicine-name="${escapeAttr(normalized(`${medicine.name} ${medicine.arabicNames || ""}`))}"><input type="checkbox" value="${medicine.id}" ${currentUser.chronicMedicineIds?.includes(medicine.id) ? "checked" : ""}><span>${escapeHtml(medicine.name)}${medicine.arabicNames ? ` · ${escapeHtml(medicine.arabicNames.split(",")[0].trim())}` : ""}</span></label>`).join("");
      authContent.innerHTML = authLayout("إعداد حسابك · ٢ من ٣", "بتتابعي أدوية مزمنة؟", "اختاري الأدوية اللي بتحبي تفضلي شايفاها في حسابك. تقدري تعدلي القائمة بعدين.", `${authHeader("اختياري", "أدويتك المزمنة", "دي قائمة تذكيرية شخصية وليست وصفة طبية.")}${progress}<div class="auth-field" style="margin-bottom:9px"><label class="sr-only" for="onboarding-medicine-search">ابحثي في قائمة الأدوية</label><input id="onboarding-medicine-search" type="search" placeholder="ابحثي في قائمة الأدوية..." autocomplete="off"></div><div class="onboarding-choice-list">${picks}</div><div class="auth-actions" style="margin-top:17px"><button class="auth-link" type="button" data-onboarding-prev>السابق</button><button class="button button-primary" type="button" data-onboarding-next>حفظ ومتابعة</button></div><button class="auth-link" type="button" data-onboarding-skip>تخطي الإعداد</button>`);
    } else {
      authContent.innerHTML = authLayout("إعداد حسابك · ٣ من ٣", "تحبي نفعّل التنبيهات؟", "اختاري لو حابة تستقبلي تنبيهات على هذا الجهاز. تقدري تغيري الاختيار بعدين.", `${authHeader("آخر خطوة", "تنبيهات دوائي", "المتصفح قد يطلب إذنًا لإظهار الإشعارات.")}${progress}<div class="onboarding-options"><label class="onboarding-option"><input type="checkbox" id="onboarding-notifications"><span>تفعيل إشعارات التوفر والتذكير</span></label></div><div class="auth-actions" style="margin-top:18px"><button class="auth-link" type="button" data-onboarding-prev>السابق</button><button class="button button-primary" type="button" data-onboarding-finish>إنهاء</button></div><button class="auth-link" type="button" data-onboarding-skip>تخطي الإعداد</button>`);
    }
  };
  const renderAccount = () => {
    if (!currentUser) {
      authMode = "choice";
      return renderAuth();
    }
    if (currentUser.role === "pharmacy") return renderAuthForPharmacy();
    const requested = new Set(currentUser.requestedMedicineIds || []);
    const medicineList = [...requested].map((id) => data.medicines.find((item) => item.id === id)).filter(Boolean);
    const chronicList = [...(currentUser.chronicMedicineIds || [])].map((id) => data.medicines.find((item) => item.id === id)).filter(Boolean);
    authContent.innerHTML = authLayout("ملفك الشخصي", `أهلاً ${currentUser.name.split(" ")[0]}`, "بيانات حسابك وقائمة أدويتك محفوظة في قاعدة الخادم المركزي.", `<div class="auth-kicker">حساب مريض</div><h1 class="auth-title" id="auth-title">${escapeHtml(currentUser.name)}</h1><p class="auth-description">${escapeHtml(currentUser.contact)} · ${escapeHtml(currentUser.governorate || "")}${currentUser.area ? ` · ${escapeHtml(currentUser.area)}` : ""}</p><h3 style="font-size:13px;margin:20px 0 7px">أدويتي المطلوبة <span class="results-count">(${medicineList.length})</span></h3>${medicineList.length ? `<div class="account-medicine-list">${medicineList.map((medicine) => `<div class="account-medicine-item"><span>✚ ${escapeHtml(medicine.name)}</span><button type="button" data-remove-medicine="${medicine.id}">إزالة</button></div>`).join("")}</div>` : `<div class="auth-notice">لسه مفيش أدوية في قائمتك. افتحي تفاصيل أي دواء واضغطي «أضف لقائمة أدويتي».</div>`}<h3 style="font-size:12px;margin:18px 0 7px">الأدوية المزمنة</h3><p class="auth-description">${chronicList.length ? chronicList.map((medicine) => escapeHtml(medicine.name)).join("، ") : "لم تختاري أدوية مزمنة في الإعداد."}</p><div class="auth-actions"><button class="button button-primary" type="button" data-account-search>ابحثي عن دواء</button><button class="button button-outline" type="button" data-signout>تسجيل الخروج</button></div><p class="auth-switch">بيانات الحساب تُحفظ في قاعدة بيانات الخادم المركزي.</p>`);
  };
  const refreshPharmacyOrders = async () => {
    const target = $("#pharmacy-orders", authContent);
    if (!target || currentUser?.role !== "pharmacy") return;
    try {
      const { user } = await apiRequest("/api/auth/session");
      setCurrentUser({ ...currentUser, ...user });
    } catch (error) {
      console.error("تعذر تحديث حالة حساب الصيدلية:", error);
      target.innerHTML = `<div class="auth-notice warning">${escapeHtml(error.message || "تعذر التحقق من حالة الصيدلية.")}</div>`;
      return;
    }
    if (currentUser.status !== "approved") {
      target.innerHTML = `<div class="auth-notice">تظهر طلبات المرضى بعد اعتماد الصيدلية.</div>`;
      return;
    }
    target.textContent = "جارٍ تحميل الطلبات...";
    try {
      const { orders } = await apiRequest("/api/orders");
      const statusLabels = {
        pending: "بانتظار قرار الصيدلية",
        accepted: "محجوز · بانتظار الاستلام",
        rejected: "مرفوض",
        fulfilled: "تم الاستلام",
        cancelled: "ملغي"
      };
      target.innerHTML = orders.length ? orders.map((order) => {
        const patientPhone = order.patientPhone || order.patientContact;
        const contactLink = /^01[0125]\d{8}$/.test(normalizeContact(patientPhone))
          ? `<a href="${escapeHtml(phoneHref(patientPhone))}">اتصال بالمريض · ${escapeHtml(patientPhone)}</a>`
          : `<span>${escapeHtml(patientPhone || "لا يوجد رقم هاتف")}</span>`;
        const controls = order.status === "pending"
          ? `<button class="button button-primary" type="button" data-pharmacy-order="${escapeHtml(order.id)}" data-order-status="accepted">قبول وحجز</button><button class="button button-outline" type="button" data-pharmacy-order="${escapeHtml(order.id)}" data-order-status="rejected">رفض الطلب</button>`
          : order.status === "accepted"
            ? `<button class="button button-outline" type="button" data-pharmacy-order="${escapeHtml(order.id)}" data-order-status="fulfilled">تأكيد الاستلام</button>`
            : "";
        return `<article class="pharmacy-inventory-item"><span><strong>${escapeHtml(order.medicineName)} · ${Number(order.quantity).toLocaleString("ar-EG")} ${escapeHtml(order.unit)}</strong><small>${escapeHtml(statusLabels[order.status] || order.status)} · ${escapeHtml(order.patientName || "مريض")} · ${new Date(order.createdAt).toLocaleString("ar-EG")}</small>${order.note ? `<small>ملاحظة المريض: ${escapeHtml(order.note)}</small>` : ""}<small>${contactLink}</small></span><div class="auth-actions">${controls}</div></article>`;
      }).join("") : `<div class="auth-notice">لا توجد طلبات حجز حتى الآن.</div>`;
    } catch (error) {
      console.error("تعذر تحميل طلبات المرضى للصيدلية:", error);
      target.innerHTML = `<div class="auth-notice warning">${escapeHtml(error.message || "تعذر تحميل طلبات الحجز. حاولي تحديث الصفحة.")}</div>`;
    }
  };
  const renderAuthForPharmacy = () => {
    if (!currentUser) return;
    const inventory = Array.isArray(currentUser.pharmacyInventory) ? currentUser.pharmacyInventory : [];
    const inventoryMarkup = inventory.length
      ? `<div class="pharmacy-inventory-list">${inventory.map((entry) => {
        const medicine = data.medicines.find((item) => item.id === entry.medicineId);
        if (!medicine) return "";
        const available = entry.quantity > 0;
        return `<article class="pharmacy-inventory-item"><span><strong>${escapeHtml(medicine.name)}${medicine.arabicNames ? ` · ${escapeHtml(medicine.arabicNames.split(/[،,]/)[0].trim())}` : ""}</strong><small>${available ? `متاح · الكمية التي أدخلتها الصيدلية: ${entry.quantity} ${escapeHtml(medicine.unit)}` : "غير متوفر حسب آخر تحديث من الصيدلية"}</small></span><button class="auth-link" type="button" data-remove-inventory="${entry.medicineId}">إزالة</button></article>`;
      }).join("")}</div>`
      : `<div class="auth-notice">لم تضيفي أدوية لمخزون الصيدلية بعد. اختاري دواءً وسجلي الكمية المتوفرة لديك.</div>`;
    const medicineOptions = data.medicines
      .map((medicine) => `<option value="${medicine.id}">${escapeHtml(medicine.name)}${medicine.arabicNames ? ` · ${escapeHtml(medicine.arabicNames.split(/[،,]/)[0].trim())}` : ""}</option>`)
      .join("");
    const region = currentUser.governorate;
    const area = normalized(currentUser.area);
    const nearbyInGovernorate = data.pharmacies
      .filter((item) => pharmacyRegion(item) === region && !(item.name === currentUser.pharmacyName && normalizeContact(item.phone) === normalizeContact(currentUser.phone)))
      .map((item) => ({ item, areaMatch: Boolean(area && normalized(item.address).includes(area)) }))
      .sort((a, b) => Number(b.areaMatch) - Number(a.areaMatch) || a.item.name.localeCompare(b.item.name, "ar"));
    const nearby = nearbyInGovernorate.slice(0, 5);
    const nearbyMarkup = nearby.length
      ? `<div class="pharmacy-nearby-list">${nearby.map(({ item, areaMatch }) => {
        const phone = phoneHref(item.phone);
        return `<article class="pharmacy-nearby-item"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.address)}${areaMatch ? " · في نفس الحي حسب العنوان" : ""}</small><div>${phone ? `<a href="${escapeHtml(phone)}">اتصال ${escapeHtml(item.phone)}</a>` : ""}<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${item.name} ${item.address}`)}" target="_blank" rel="noopener noreferrer">الخريطة</a></div></article>`;
      }).join("")}</div>`
      : `<div class="auth-notice">لا توجد فروع أخرى مسجلة في محافظة ${escapeHtml(region)} حاليًا.</div>`;
    const content = `<div class="review-status"><span class="review-status-icon">${currentUser.status === "approved" ? "✓" : currentUser.status === "rejected" ? "!" : "◷"}</span><span><strong>${currentUser.status === "approved" ? "تم اعتماد الصيدلية" : currentUser.status === "rejected" ? "تم رفض الطلب" : "الحساب اتسجل والطلب قيد المراجعة"}</strong><small>${currentUser.status === "rejected" ? escapeHtml(currentUser.rejectionReason || "راجعي الإدارة لمعرفة التفاصيل.") : currentUser.status === "approved" ? "الصيدلية تظهر الآن في دليل دوائي." : "بياناتك محفوظة. ستظهر الصيدلية في الدليل بعد اعتماد الإدارة."}</small></span></div>
      <h2 class="auth-title" id="auth-title" style="margin-top:20px">${escapeHtml(currentUser.pharmacyName)}</h2>
      <div class="pharmacy-profile-grid">
        <div><small>رقم الترخيص</small><strong>${escapeHtml(currentUser.license)}</strong></div>
        <div><small>رقم الموبايل</small><strong dir="ltr">${escapeHtml(currentUser.phone)}</strong></div>
        <div><small>واتساب</small><strong dir="ltr">${escapeHtml(currentUser.whatsapp)}</strong></div>
        <div><small>الموقع</small><strong>${escapeHtml(currentUser.governorate)} · ${escapeHtml(currentUser.area)}</strong></div>
        <div class="wide"><small>العنوان بالتفصيل</small><strong>${escapeHtml(currentUser.address)}</strong></div>
        <div><small>موعد الفتح</small><strong dir="ltr">${escapeHtml(currentUser.openingTime)}</strong></div>
        <div><small>موعد الإغلاق</small><strong dir="ltr">${escapeHtml(currentUser.closingTime)}</strong></div>
      </div>
      ${currentUser.location ? `<a class="auth-link" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${currentUser.location.lat},${currentUser.location.lng}`)}" target="_blank" rel="noopener noreferrer">فتح موقع صيدليتي على الخريطة ↗</a>` : ""}
      <h3 class="feature-subheading">أدوية الصيدلية (${inventory.filter((item) => item.quantity > 0).length} متاحة)</h3>
      <p class="auth-description">حدّثي الكميات بنفسك. الأدوية التي كميتها صفر تظهر كغير متوفرة حسب آخر تحديث منك، وليست بيانًا عن السوق كله.</p>
      ${inventoryMarkup}
      <h3 class="feature-subheading">طلبات حجز المرضى</h3>
      <p class="auth-description">قبول الطلب يعني حجزه للصرف. راجعي الكمية الفعلية قبل القبول، واتصلي بالمريض عند الحاجة.</p>
      <div class="pharmacy-inventory-list" id="pharmacy-orders"><div class="auth-notice">جارٍ تحميل الطلبات...</div></div>
      <form class="pharmacy-inventory-form" id="pharmacy-inventory-form">
        <label class="auth-field"><span class="auth-label">الدواء من دليل دوائي</span><select id="inventory-medicine" required><option value="">اختاري الدواء</option>${medicineOptions}</select></label>
        <label class="auth-field"><span class="auth-label">الكمية المتوفرة في صيدليتك</span><input id="inventory-quantity" type="number" min="0" max="1000000" step="1" value="1" required></label>
        <button class="button button-primary" type="submit">حفظ المخزون</button>
      </form>
      <h3 class="feature-subheading">صيدليات مسجلة في ${escapeHtml(currentUser.governorate)} (${nearbyInGovernorate.length})</h3>
      <p class="auth-description">مرتبة حسب تطابق الحي مع العنوان، ثم المحافظة. لا تتوفر إحداثيات لكل الفروع، لذلك الترتيب تقريبي وليس قياس مسافة.</p>
      ${nearbyMarkup}
      <div class="auth-actions"><button class="button button-primary" type="button" data-pharmacy-directory>عرض دليل صيدليات المحافظة</button><button class="button button-outline" type="button" data-signout>تسجيل الخروج</button></div>`;
    authContent.innerHTML = authLayout("ملف الصيدلية", "ملف حساب الصيدلية", "بيانات الحساب وحالة طلب الانضمام محفوظة في النظام المركزي.", content);
    refreshPharmacyOrders();
  };
  const completeOnboarding = async (skip = false) => {
    if (!currentUser) return;
    const profile = { onboardingComplete: true };
    if (skip) {
      profile.chronicMedicineIds = currentUser.chronicMedicineIds || [];
    } else {
      profile.chronicMedicineIds = currentUser.chronicMedicineIds || [];
      profile.notificationPreference = Boolean($("#onboarding-notifications")?.checked);
      if (profile.notificationPreference && "Notification" in window && Notification.permission === "default") {
        try {
          profile.notificationPermission = await Notification.requestPermission();
        } catch (error) {
          console.warn("تعذر طلب إذن الإشعارات:", error);
        }
      }
    }
    try {
      await saveCurrentUser(profile);
    } catch (error) {
      console.error("تعذر حفظ إعداد الحساب:", error);
      showToast(error.message || "تعذر حفظ إعدادات الحساب. تحققي من الاتصال وحاولي مجددًا.");
      return;
    }
    authMode = "account";
    renderAuth();
    if (pendingMedicineId) {
      const id = pendingMedicineId;
      pendingMedicineId = null;
      addRequestedMedicine(id);
    }
  };

  const setupPharmacyMap = () => {
    mapPosition = null;
    mapInstance = null;
    mapMarker = null;
    const updateMapPosition = (lat, lng) => {
      mapPosition = { lat, lng };
      $("#map-coordinates-label").textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      setFieldError("pharmacy-location");
      if (mapInstance && window.L) {
        if (mapMarker) mapMarker.setLatLng([lat, lng]);
        else mapMarker = window.L.marker([lat, lng]).addTo(mapInstance);
        mapInstance.setView([lat, lng], Math.max(mapInstance.getZoom(), 15));
      }
    };
    const loadLeaflet = () => {
      if (window.L) return Promise.resolve(window.L);
      if (mapLoading) return mapLoading;
      mapLoading = new Promise((resolve, reject) => {
        const stylesheet = document.createElement("link");
        stylesheet.rel = "stylesheet";
        stylesheet.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.append(stylesheet);
        const script = document.createElement("script");
        script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
        script.onload = () => window.L ? resolve(window.L) : reject(new Error("لم يتم تحميل مكتبة الخريطة."));
        script.onerror = () => reject(new Error("تعذر تحميل الخريطة. استخدمي تحديد الموقع أو تحققي من الاتصال."));
        document.head.append(script);
      });
      return mapLoading;
    };
    loadLeaflet().then((leaflet) => {
      if (!$("#pharmacy-map") || !authDialog.open || authMode !== "pharmacy-signup") return;
      const placeholder = $("#pharmacy-map .map-placeholder");
      if (placeholder) placeholder.remove();
      mapInstance = leaflet.map("pharmacy-map").setView([30.0444, 31.2357], 10);
      leaflet.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>' }).addTo(mapInstance);
      mapInstance.on("click", (event) => updateMapPosition(event.latlng.lat, event.latlng.lng));
      if (mapPosition) updateMapPosition(mapPosition.lat, mapPosition.lng);
      window.setTimeout(() => mapInstance?.invalidateSize(), 150);
    }).catch((error) => {
      console.error("تعذر تجهيز خريطة تسجيل الصيدلية:", error);
      const placeholder = $("#pharmacy-map .map-placeholder");
      if (placeholder) placeholder.innerHTML = `<span>⌖</span><strong>تعذر تحميل الخريطة</strong><small>${escapeHtml(error.message)} يمكنك إكمال التسجيل دون تحديد الموقع.</small>`;
    });
    authContent.querySelector("#use-pharmacy-location")?.addEventListener("click", () => {
      if (!navigator.geolocation) {
        setFieldError("pharmacy-location", "المتصفح لا يدعم تحديد الموقع؛ حددي نقطة على الخريطة.");
        return;
      }
      navigator.geolocation.getCurrentPosition((position) => updateMapPosition(position.coords.latitude, position.coords.longitude), (error) => {
        console.warn("تعذر تحديد موقع الصيدلية:", error);
        setFieldError("pharmacy-location", "لم نتمكن من تحديد موقعك. اسمحي بالوصول للموقع أو اضغطي على الخريطة.");
      }, { enableHighAccuracy: true, timeout: 10000 });
    });
  };

  const startOtp = (contact, flow) => {
    authState.contact = contact;
    authState.flow = flow;
    pendingOtp = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
    authMode = flow === "reset" ? "reset-password" : "otp-verify";
    renderAuth();
  };
  const beginOnboarding = (user) => {
    authState.onboardingStep = 0;
    user.onboardingComplete = false;
    authMode = "onboarding";
    renderAuth();
  };
  const registerPatient = async (form) => {
    if (!validateAuthForm(form)) return;
    const contact = $("#contact").value.trim();
    if (isContactTaken(contact, "patient")) {
      setFieldError("contact", "وسيلة التواصل دي مسجلة بالفعل لحساب مريض. سجّلي الدخول بدل إنشاء حساب مكرر.");
      return;
    }
    const { user } = await apiRequest("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        role: "patient", contact, password: $("#patient-password").value,
        profile: { name: $("#patient-name").value.trim(), governorate: $("#patient-governorate").value, area: $("#patient-area").value.trim(), requestedMedicineIds: [], chronicMedicineIds: [] }
      })
    });
    setCurrentUser(user);
    authDialog.close();
    showToast("تم إنشاء حسابك وتسجيل دخولك بنجاح.");
  };
  const registerPharmacy = async (form) => {
    if (!validateAuthForm(form)) return;
    const phone = normalizeContact($("#pharmacy-phone").value);
    if (findAccount(phone, "pharmacy")) {
      setFieldError("pharmacy-phone", "رقم الموبايل مسجل بالفعل لحساب صيدلية.");
      return;
    }
    if (isContactTaken($("#pharmacy-whatsapp").value, "pharmacy")) {
      setFieldError("pharmacy-whatsapp", "رقم واتساب مسجل بالفعل لحساب صيدلية.");
      return;
    }
    const { user } = await apiRequest("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        role: "pharmacy", contact: phone, password: $("#pharmacy-password").value,
        profile: {
          phone, whatsapp: normalizeContact($("#pharmacy-whatsapp").value),
          pharmacyName: $("#pharmacy-name").value.trim(), license: $("#pharmacy-license").value.trim(),
          governorate: $("#pharmacy-governorate").value, area: $("#pharmacy-area").value.trim(), address: $("#pharmacy-address").value.trim(),
          openingTime: $("#pharmacy-opening").value, closingTime: $("#pharmacy-closing").value,
          ...(mapPosition ? { location: mapPosition } : {})
        }
      })
    });
    setCurrentUser(user);
    authMode = "account";
    renderAuth();
    showToast("اتسجل حساب الصيدلية بنجاح. حالة الطلب: قيد المراجعة.");
  };
  const updatePharmacyInventory = async (medicineId, quantity) => {
    if (!currentUser || currentUser.role !== "pharmacy") {
      showToast("تحديث المخزون متاح بعد تسجيل الدخول بحساب الصيدلية.");
      return;
    }
    const inventory = Array.isArray(currentUser.pharmacyInventory) ? currentUser.pharmacyInventory : [];
    const nextInventory = inventory.filter((entry) => entry.medicineId !== medicineId);
    if (quantity !== null) nextInventory.push({ medicineId, quantity });
    const { user } = await apiRequest("/api/profile", {
      method: "PUT",
      body: JSON.stringify({ profile: { pharmacyInventory: nextInventory } })
    });
    setCurrentUser(user);
    authMode = "account";
    renderAuth();
    showToast(quantity === null ? "تمت إزالة الدواء من قائمة مخزون الصيدلية." : "تم حفظ مخزون الصيدلية على الخادم.");
  };
  const handleAuthSubmit = async (form) => {
    if (form.id === "pharmacy-inventory-form") {
      if (!form.reportValidity()) return;
      const medicineId = Number($("#inventory-medicine").value);
      const quantity = Number($("#inventory-quantity").value);
      if (!Number.isInteger(medicineId) || !Number.isInteger(quantity)) {
        showToast("اختاري دواءً وحددي كمية صحيحة.");
        return;
      }
      return updatePharmacyInventory(medicineId, quantity);
    }
    if (form.id === "patient-signup-form") return registerPatient(form);
    if (form.id === "pharmacy-signup-form") return registerPharmacy(form);
    if (form.id === "login-form" || form.id === "patient-login-form" || form.id === "pharmacy-login-form") {
      if (!validateAuthForm(form)) return;
      let result;
      try {
        const expectedRole = form.id === "pharmacy-login-form" ? "pharmacy"
          : form.id === "patient-login-form" ? "patient" : null;
        result = await apiRequest("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({
            contact: $("#contact").value.trim(), password: $("#login-password").value,
            ...(expectedRole ? { expectedRole } : {})
          })
        });
      } catch (error) {
        setFieldError("contact", error.message);
        return;
      }
      const user = result.user;
      if (user.role !== "admin") {
        const local = accounts.find((account) => account.id === user.id);
        if (local) Object.assign(user, local, result.user);
      }
      finishLogin(user);
      return;
    }
    if (form.id === "otp-request-form") {
      return;
    }
    if (form.id === "otp-verify-form") {
      if (!validateAuthForm(form)) return;
      const user = findAccount(authState.contact, "patient");
      if (!user) {
        authMode = "choice";
        renderAuth();
        return showToast("الحساب مش موجود؛ سجّلي الدخول أو أنشئي حسابًا جديدًا.");
      }
      return finishLogin(user);
    }
    if (form.id === "reset-password-form") {
      if (!validateAuthForm(form)) return;
      const user = findAccount(authState.contact, "patient");
      if (!user) return showToast("لم يتم العثور على الحساب.");
      const credentials = await derivePasswordHash($("#reset-password").value);
      user.passwordSalt = credentials.salt;
      user.passwordHash = credentials.hash;
      if (persistAccounts()) finishLogin(user);
      return;
    }
    if (form.id === "google-form") {
      return showToast("دخول Google غير متاح قبل ربط OAuth موثوق.");
    }
  };

  authContent.addEventListener("click", async (event) => {
    const pharmacyOrderButton = event.target.closest("[data-pharmacy-order]");
    if (pharmacyOrderButton) {
      try {
        await apiRequest(`/api/orders/${encodeURIComponent(pharmacyOrderButton.dataset.pharmacyOrder)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: pharmacyOrderButton.dataset.orderStatus })
        });
        await refreshPharmacyOrders();
        showToast(pharmacyOrderButton.dataset.orderStatus === "accepted" ? "تم قبول الطلب وحجزه." : "تم تحديث حالة طلب الحجز.");
      } catch (error) {
        showToast(error.message || "تعذر تحديث الطلب.");
      }
      return;
    }
    const removeInventoryButton = event.target.closest("[data-remove-inventory]");
    if (removeInventoryButton) {
      try {
        await updatePharmacyInventory(Number(removeInventoryButton.dataset.removeInventory), null);
      } catch (error) {
        console.error("تعذر تحديث مخزون الصيدلية:", error);
        showToast(error.message || "تعذر حفظ تعديل المخزون. حاولي مرة تانية.");
      }
      return;
    }
    const modeButton = event.target.closest("[data-auth-mode]");
    if (modeButton) {
      const nextMode = modeButton.dataset.authMode;
      authMode = nextMode;
      renderAuth();
      return;
    }
    if (event.target.closest("[data-pharmacy-directory]")) {
      authDialog.close();
      setView("pharmacies");
      state.region = currentUser?.governorate || "";
      $("#region-filter").value = state.region;
      render();
      return;
    }
    const toggleButton = event.target.closest("[data-toggle-password]");
    if (toggleButton) {
      const input = $(`#${toggleButton.dataset.togglePassword}`);
      input.type = input.type === "password" ? "text" : "password";
      toggleButton.textContent = input.type === "password" ? "إظهار" : "إخفاء";
      return;
    }
    if (event.target.closest("[data-privacy]")) {
      showToast("تُحفظ بيانات الحساب في قاعدة الخادم. راجعي سياسة الخصوصية قبل إضافة بيانات صحية حساسة.");
      return;
    }
    if (event.target.closest("[data-signout]")) {
      try {
        await apiRequest("/api/auth/logout", { method: "POST", body: "{}" });
      } catch (error) {
        console.error("تعذر إنهاء جلسة الخادم:", error);
        return showToast("تعذر تسجيل الخروج من الخادم. تحققي من الاتصال وحاولي مجددًا.");
      }
      setCurrentUser(null);
      authMode = "choice";
      renderAuth();
      showToast("تم تسجيل الخروج من هذا الجهاز.");
      return;
    }
    if (event.target.closest("[data-account-search]")) {
      authDialog.close();
      setView("medicines");
      window.setTimeout(() => search.focus(), 350);
      return;
    }
    const removeButton = event.target.closest("[data-remove-medicine]");
    if (removeButton && currentUser) {
      const id = Number(removeButton.dataset.removeMedicine);
      const requestedMedicineIds = currentUser.requestedMedicineIds.filter((medicineId) => medicineId !== id);
      try {
        await saveCurrentUser({ requestedMedicineIds });
        renderAuth();
        showToast("تم تحديث قائمة أدويتك.");
      } catch (error) {
        console.error("تعذر تحديث قائمة أدوية المريض:", error);
        showToast(error.message || "تعذر تحديث القائمة على الخادم. حاولي مرة تانية.");
      }
      return;
    }
    const locationButton = event.target.closest("[data-onboarding-location]");
    if (locationButton) {
      if (!navigator.geolocation) {
        showToast("المتصفح لا يدعم تحديد الموقع؛ تقدري تكملي بدونه.");
        return;
      }
      navigator.geolocation.getCurrentPosition(async (position) => {
        try {
          await saveCurrentUser({ location: { lat: position.coords.latitude, lng: position.coords.longitude } });
          showToast("اتحفظ موقعك الدقيق في ملفك على الخادم المركزي.");
        } catch (error) {
          console.error("تعذر حفظ موقع المستخدم:", error);
          showToast(error.message || "تعذر حفظ موقعك على الخادم. حاولي مرة تانية.");
        }
      }, (error) => {
        console.warn("تعذر تحديد موقع المستخدم:", error);
        showToast("لم نتمكن من تحديد الموقع. تقدري تكملي أو تتخطي الخطوة.");
      }, { enableHighAccuracy: true, timeout: 10000 });
      return;
    }
    if (event.target.closest("[data-onboarding-next]")) {
      if (authState.onboardingStep === 1) currentUser.chronicMedicineIds = [...authContent.querySelectorAll(".onboarding-medicine input:checked")].map((input) => Number(input.value));
      authState.onboardingStep = Math.min(2, authState.onboardingStep + 1);
      renderAuth();
      return;
    }
    if (event.target.closest("[data-onboarding-prev]")) {
      authState.onboardingStep = Math.max(0, authState.onboardingStep - 1);
      renderAuth();
      return;
    }
    if (event.target.closest("[data-onboarding-skip]")) return completeOnboarding(true);
    if (event.target.closest("[data-onboarding-finish]")) return completeOnboarding(false);
  });
  authContent.addEventListener("submit", (event) => {
    event.preventDefault();
    handleAuthSubmit(event.target).catch((error) => {
      console.error("تعذر إكمال خطوة تسجيل الحساب:", error);
      const notice = authContent.querySelector(".auth-notice");
      if (notice) {
        notice.classList.add("error");
        notice.textContent = error.message || "حصلت مشكلة أثناء حفظ الحساب. حاولي مرة تانية.";
      } else showToast(error.message || "حصلت مشكلة أثناء حفظ الحساب. حاولي مرة تانية.");
    });
  });
  authContent.addEventListener("input", (event) => {
    const input = event.target;
    if (input.id === "onboarding-medicine-search") {
      const term = normalized(input.value);
      authContent.querySelectorAll(".onboarding-medicine").forEach((label) => {
        label.hidden = term && !label.dataset.medicineName.includes(term);
      });
    }
    if (input.matches("[data-password-meter],#patient-password,#pharmacy-password,#reset-password")) {
      const meter = authContent.querySelector(`[data-meter-for="${input.id}"]`);
      const hint = authContent.querySelector(`[data-password-hint="${input.id}"]`);
      const strength = strengthOf(input.value);
      if (meter) meter.dataset.strength = String(strength);
      if (hint) hint.textContent = ["ابدئي بحروف وأرقام.", "قوة ضعيفة — زوّدي طول كلمة المرور.", "مقبولة، أضيفي رمزًا لزيادة الأمان.", "قوية — أحسنتِ.", "قوية جدًا."][strength];
    }
    if (input.id && input.dataset.touched === "true") {
      const temporaryForm = input.closest("form");
      if (temporaryForm) validateAuthForm(temporaryForm, input);
    }
  });
  authContent.addEventListener("focusout", (event) => {
    const input = event.target;
    if (input.matches("input,select,textarea") && input.id) {
      input.dataset.touched = "true";
      const form = input.closest("form");
      if (form) validateAuthForm(form, input);
    }
  });
  authDialog.addEventListener("click", (event) => {
    if (event.target === authDialog) authDialog.close();
  });
  authDialog.addEventListener("cancel", () => authDialog.close());
  authDialog.querySelector(".auth-close").addEventListener("click", () => {
    authDialog.close();
  });
  $("#auth-open").addEventListener("click", () => {
    if (currentUser) {
      authMode = "account";
      authDialog.showModal();
      renderAuth();
    } else showAuth("choice");
  });
  $$("[data-account-role]").forEach((button) => {
    button.addEventListener("click", () => openRoleAccount(button.dataset.accountRole));
  });

  updateAuthButton();
  renderAuth();
  apiRequest("/api/auth/session").then(({ user }) => {
    const local = accounts.find((account) => account.id === user.id) || {};
    setCurrentUser({ ...local, ...user });
    authMode = user.role === "patient" && !user.onboardingComplete ? "onboarding" : "account";
    if (authMode === "onboarding") {
      authDialog.showModal();
      renderAuth();
    }
  }).catch((error) => {
    if (!error.message.includes("سجّلي الدخول")) console.warn("تعذر استعادة جلسة المستخدم:", error);
    setCurrentUser(null);
    authMode = "choice";
    renderAuth();
    if (!error.message.includes("سجّلي الدخول")) {
      const main = authContent.querySelector(".auth-main");
      main?.insertAdjacentHTML("afterbegin", `<div class="auth-notice warning">تعذر الاتصال بخادم دوائي. يمكنكِ استعراض الموقع، لكن تسجيل الحساب وحفظ البيانات يحتاجان اتصال الخادم.</div>`);
    }
    authDialog.showModal();
  });
  window.setInterval(() => {
    if (document.visibilityState === "visible" && authDialog.open && currentUser?.role === "pharmacy") {
      refreshPharmacyOrders();
    }
  }, 30000);
  $("#dialog-content").addEventListener("click", (event) => {
    const neededButton = event.target.closest("[data-add-needed]");
    if (neededButton) {
      const medicineId = Number(neededButton.dataset.addNeeded);
      if (currentUser?.role === "patient" && currentUser.requestedMedicineIds?.includes(medicineId)) {
        authMode = "account";
        authDialog.showModal();
        renderAuth();
      } else addRequestedMedicine(medicineId);
    }
  });

  render();
})();
