(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const data = window.DAWAEY_DATA;
  const dialog = $("#feature-dialog");
  const content = $("#feature-content");
  const search = $("#search-input");
  const featureState = {
    active: "emergency",
    voice: null,
    installPrompt: null,
    photoUrl: "",
    qrLibrary: null,
    tourStep: 0,
    tourReturnFocus: null,
    chatHistory: [],
    catalogOpen: true
  };
  const loadQrLibrary = () => {
    if (window.QRCode) return Promise.resolve(window.QRCode);
    if (featureState.qrLibrary) return featureState.qrLibrary;
    featureState.qrLibrary = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
      script.onload = () => window.QRCode ? resolve(window.QRCode) : reject(new Error("لم يتم تحميل مولد QR."));
      script.onerror = () => reject(new Error("تعذر تحميل مولد QR. استخدمي رمز التذكرة النصي."));
      document.head.append(script);
    });
    return featureState.qrLibrary;
  };
  const renderQrCodes = async () => {
    const elements = $$("[data-qr-code]", content);
    if (!elements.length) return;
    try {
      const QRCode = await loadQrLibrary();
      elements.forEach((element) => {
        if (!element.isConnected) return;
        element.replaceChildren();
        new QRCode(element, { text: `DAWAEY:${element.dataset.qrCode}`, width: 90, height: 90, colorDark: "#183834", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
      });
    } catch (error) {
      console.warn("تعذر إنشاء QR للتذكرة المحلية:", error);
      elements.forEach((element) => {
        element.textContent = element.dataset.qrCode;
        element.setAttribute("title", "رمز نصي احتياطي؛ مولد QR غير متاح.");
      });
      const message = notice("مولد QR غير متاح الآن؛ استخدمي رمز التذكرة النصي أعلاه. التذكرة في كل الأحوال محلية وليست حجزًا قابلًا للتحقق لدى صيدلية.", "warning");
      content.insertAdjacentHTML("afterbegin", message);
    }
  };
  const DB = {
    alerts: "dawaey-availability-alerts-v1",
    reservations: "dawaey-reservations-v1",
    reminders: "dawaey-reminders-v1",
    family: "dawaey-family-v1",
    transfers: "dawaey-transfers-v1",
    tour: "dawaey-tour-complete-v1"
  };

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const norm = (value) => String(value ?? "").normalize("NFKD").replace(/[\u064B-\u065F\u0670\u0640]/g, "").toLocaleLowerCase("ar").trim();
  const normalizeMedicineSearch = (value) => norm(value).replace(/[أإآ]/g, "ا").replace(/ى/g, "ي");
  const getValue = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (error) {
      console.error(`تعذر قراءة ${key}:`, error);
      return fallback;
    }
  };
  const putValue = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error(`تعذر حفظ ${key}:`, error);
      toast("تعذر الحفظ على هذا الجهاز. تحققي من مساحة المتصفح.");
      return false;
    }
  };
  const accounts = () => getValue("dawaey-accounts-v1", []);
  const currentAccount = () => {
    try {
      const id = localStorage.getItem("dawaey-active-account-v1");
      return accounts().find((account) => account.id === id) || null;
    } catch (error) {
      console.error("تعذر استعادة الحساب الحالي لأدوات المريض:", error);
      return null;
    }
  };
  const scopedKey = (key) => `${key}:${currentAccount()?.id || "guest"}`;
  const getScoped = (key) => getValue(scopedKey(key), []);
  const setScoped = (key, values) => putValue(scopedKey(key), values);
  const digits = (value) => String(value || "").replace(/[^\d+]/g, "");
  const toast = (message) => {
    const region = $("#toast-region");
    if (!region) return;
    const item = document.createElement("div");
    item.className = "toast";
    item.textContent = message;
    region.append(item);
    window.setTimeout(() => {
      item.classList.add("out");
      window.setTimeout(() => item.remove(), 230);
    }, 2600);
  };
  const showDialog = (feature, options = {}) => {
    featureState.active = feature;
    renderFeature(feature, options);
    if (!dialog.open) dialog.showModal();
  };
  const featureHeader = (kicker, title, description) => `<div class="feature-kicker">${esc(kicker)}</div><h2 class="feature-title" id="feature-title">${esc(title)}</h2><p class="feature-lede">${esc(description)}</p>`;
  const notice = (text, kind = "info") => `<div class="feature-notice ${kind}">${text}</div>`;
  const medicineSelect = (id, label = "اختاري الدواء") => `<div class="feature-field"><label for="${id}">${esc(label)}</label><select id="${id}"><option value="">${esc(label)}</option>${data.medicines.map((medicine) => `<option value="${medicine.id}">${esc(medicine.name)}${medicine.arabicNames ? ` · ${esc(medicine.arabicNames.split(",")[0].trim())}` : ""} · ${esc(medicine.category)}</option>`).join("")}</select></div>`;
  const pharmacySelect = (id, label = "اختاري الصيدلية") => `<div class="feature-field"><label for="${id}">${esc(label)}</label><select id="${id}"><option value="">${esc(label)}</option>${data.pharmacies.map((pharmacy) => `<option value="${pharmacy.id}">${esc(pharmacy.name)} · ${esc(pharmacy.address)}</option>`).join("")}</select></div>`;
  const getMedicine = (id) => data.medicines.find((item) => item.id === Number(id));
  const getPharmacy = (id) => data.pharmacies.find((item) => item.id === Number(id));
  const shareUrl = (medicine) => {
    const url = new URL(location.href);
    url.hash = "directory";
    return `${url.href}?medicine=${encodeURIComponent(medicine.name)}`;
  };
  const launchSearch = (query, view = "medicines") => {
    const tab = $(`#tab-${view}`);
    if (tab) tab.click();
    search.value = query;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    $("#directory").scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => search.focus(), 350);
  };

  const emergencyMarkup = () => {
    const top = data.pharmacies.slice(0, 5);
    return `${featureHeader("مساعدة سريعة", "وضع الطوارئ", "تواصلي بسرعة مع الإسعاف أو صيدليات من الدليل.")}<div class="emergency-panel"><h3>في خطر مباشر أو حالة طبية طارئة؟</h3><p>اتصلي بالإسعاف المصري ١٢٣ أو توجهي لأقرب قسم طوارئ. لا تنتظري الرد على الموقع.</p><a class="button button-emergency" href="tel:123" aria-label="اتصلي بالإسعاف على 123">اتصلي بالإسعاف · ١٢٣</a></div><div class="feature-notice danger">دليل الصيدليات ثابت وغير مرتبط بمخزون أو موقع مباشر. أرقام الاتصال والعناوين تحتاج تأكيدًا.</div><div class="feature-list">${top.map((pharmacy) => `<div class="emergency-pharmacy"><strong>${esc(pharmacy.name)}</strong><a class="emergency-call" href="tel:${esc(digits(pharmacy.phone.split(/[\/،,]/)[0]))}">${esc(pharmacy.phone.split(/[\/،,]/)[0])}</a><small>${esc(pharmacy.address)}</small></div>`).join("")}</div><div class="feature-actions"><button type="button" class="button button-outline" data-action="all-pharmacies">عرض كل الصيدليات</button></div>`;
  };

  const alertsMarkup = () => {
    const alerts = getScoped(DB.alerts);
    return `${featureHeader("متابعة محلية", "نبهيني لما يتوفر", "سجّلي دواءً لمتابعته. هذه النسخة تحفظ التنبيه على الجهاز وتفحص حالة الملف عند فتح الصفحة.")}<div class="feature-notice">مافيش اتصال لحظي بصيدلية: بيانات ملف الإكسل تقول «متاح» للأصناف، لكنها لا تحدد الفرع ولا تتجدد تلقائيًا. لن نرسل تنبيهًا كأنه مخزون مؤكد.</div><form class="feature-form" data-form="alert">${medicineSelect("alert-medicine")}<div class="feature-actions"><button class="button button-primary" type="submit">حفظ التنبيه</button><button class="button button-outline" type="button" data-action="enable-notifications">تفعيل إشعارات هذا الجهاز</button></div></form><h3 class="feature-subheading">تنبيهاتي المحفوظة (${alerts.length})</h3><div class="feature-list">${alerts.length ? alerts.map((alert) => {
      const medicine = getMedicine(alert.medicineId);
      return `<div class="feature-item"><span class="feature-item-main"><strong>${esc(medicine?.name || "دواء محذوف")}</strong><small>${esc(alert.status || "قيد المتابعة")} · تحديث الملف: ${esc(new Date(alert.createdAt).toLocaleDateString("ar-EG"))}</small></span><button type="button" data-remove-alert="${esc(alert.id)}">إزالة</button></div>`;
    }).join("") : notice("لسه مفيش تنبيهات محفوظة.")}</div>`;
  };

  const alternativeMarkup = (medicineId = "") => {
    const medicine = getMedicine(medicineId);
    if (!medicine) return `${featureHeader("اقتراح آمن", "بدائل الدواء", "اختاري دواء لمراجعة البيانات المتاحة في الدليل.")}<form class="feature-form" data-form="alternative">${medicineSelect("alternative-medicine")}<button class="button button-primary" type="submit">عرض معلومات الدواء</button></form>`;
    const related = data.medicines.filter((item) => item.id !== medicine.id && item.category === medicine.category).slice(0, 6);
    return `${featureHeader("اقتراح آمن", `معلومات عن ${medicine.name}`, "نوضح البيانات المتاحة، من غير اعتبار أدوية التصنيف نفسه بدائل علاجية.")}<div class="feature-stat"><strong>${esc(medicine.category)}</strong><small>التصنيف كما ورد في ملف المصدر</small></div>${notice("ملفك لا يحتوي على المادة الفعالة أو التركيز أو الشكل الصيدلي أو الأسعار. لذلك لا يمكن تأكيد بديل مكافئ أو مقارنة سعر بأمان. التشابه في التصنيف لا يعني أن الأدوية بدائل لبعضها.", "danger")}<h3 class="feature-subheading">أصناف في التصنيف نفسه — ليست توصية بالاستبدال</h3><div class="feature-list">${related.map((item) => `<div class="feature-item"><span class="feature-item-main"><strong>${esc(item.name)}</strong><small>${esc(item.category)} · السعر غير مسجل · راجعي الصيدلي</small></span><button type="button" data-share-medicine="${item.id}">مشاركة</button></div>`).join("") || notice("لا توجد أصناف أخرى في التصنيف نفسه.")}<div class="feature-actions"><button class="button button-outline" type="button" data-action="change-alternative">اختيار دواء آخر</button></div>`;
  };

  const interactionsMarkup = () => `${featureHeader("سلامتك أولًا", "فاحص التداخلات الدوائية", "أضيفي الأدوية التي تستخدمينها لبدء مراجعة إرشادية آمنة.")}${notice("التحقق الطبي يتطلب المادة الفعالة والتركيز والجرعة والعمر والحالة الصحية. هذه المعلومات غير موجودة في الملف؛ لن نعطي نتيجة «آمن» أو «خطر» تخمينية.", "danger")}<form class="feature-form" data-form="interaction"><div class="feature-grid">${medicineSelect("interaction-medicine-a", "الدواء الأول")}${medicineSelect("interaction-medicine-b", "الدواء الثاني")}</div><div class="feature-field"><label for="interaction-extra">أدوية أخرى أو ملاحظات للصيدلي (اختياري)</label><textarea id="interaction-extra" placeholder="اكتبي اسم المكمل أو الدواء كما على العبوة"></textarea></div><button class="button button-primary" type="submit">تجهيز قائمة أسأل عنها الصيدلي</button></form><div id="interaction-result"></div>`;

  const networkMarkup = () => {
    const requests = getScoped(DB.transfers);
    return `${featureHeader("شبكة التواصل", "طلب تحويل دواء بين الصيدليات", "جهّزي طلبًا محليًا لتوضيح الدواء والصيدليتين. الإرسال الحقيقي يحتاج حسابات صيدليات وخادمًا.")}${notice("دليلنا لا يربط المخزون بالفروع؛ إنشاء الطلب لا يؤكد توفر الدواء أو موافقة الصيدلية.", "warning")}<form class="feature-form" data-form="transfer">${medicineSelect("transfer-medicine")}<div class="feature-grid">${pharmacySelect("transfer-from", "من صيدلية")}${pharmacySelect("transfer-to", "إلى صيدلية")}</div><div class="feature-field"><label for="transfer-note">ملاحظة للصيدلي</label><textarea id="transfer-note" placeholder="الكمية أو تفاصيل التواصل"></textarea></div><button class="button button-primary" type="submit">إنشاء طلب تحويل تجريبي</button></form><h3 class="feature-subheading">طلباتي ومحادثاتي المحلية (${requests.length})</h3><div class="feature-list">${requests.length ? requests.map((request) => {
      const medicine = getMedicine(request.medicineId);
      const from = getPharmacy(request.fromId);
      const to = getPharmacy(request.toId);
      return `<div class="feature-item"><span class="feature-item-main"><strong>${esc(medicine?.name)} · ${esc(request.status)}</strong><small>من ${esc(from?.name)} إلى ${esc(to?.name)} · ${new Date(request.createdAt).toLocaleString("ar-EG")}</small><small>${request.messages.length ? request.messages.map((message) => `${esc(message.author)}: ${esc(message.text)}`).join(" | ") : "لا توجد رسائل بعد."}</small></span><button type="button" data-chat-transfer="${esc(request.id)}">رسالة</button></div>`;
    }).join("") : notice("مفيش طلبات تحويل محلية لحد دلوقتي.")}</div>`;
  };

  const shortageMarkup = () => {
    const total = data.medicines.reduce((sum, medicine) => sum + Number(medicine.quantity || 0), 0);
    const minimum = data.medicines.filter((medicine) => Number(medicine.quantity) <= Number(medicine.minimum));
    const areas = [...new Set(data.pharmacies.map((pharmacy) => pharmacy.address))];
    return `${featureHeader("صورة بيانات الملف", "مؤشرات النواقص والمخزون", "نفصل بين رصيد المستودع في الملف وبين المخزون الفعلي المتغير لكل صيدلية.")}<div class="feature-result-grid"><div class="feature-stat"><strong>${total.toLocaleString("ar-EG")}</strong><small>إجمالي الكميات المسجلة، بوحدات متنوعة</small></div><div class="feature-stat"><strong>${minimum.length.toLocaleString("ar-EG")}</strong><small>أصناف دون/عند الحد الأدنى المسجل (من ${data.medicines.length})</small></div><div class="feature-stat"><strong>${data.pharmacies.length.toLocaleString("ar-EG")}</strong><small>سجل صيدلية من دون إحداثيات دقيقة</small></div><div class="feature-stat"><strong>${areas.length.toLocaleString("ar-EG")}</strong><small>صيغة عنوان مختلفة في بيانات الصيدليات</small></div></div>${notice("لا يمكن رسم Heatmap للنواقص حسب الخريطة دون إحداثيات الصيدليات وكمية كل دواء في كل فرع. يعرض الملف كل الأصناف على أنها متاحة فوق الحد الأدنى، وليس فيه تاريخ مبيعات.", "danger")}<h3 class="feature-subheading">أقل الكميات المسجلة — ليست توقعًا بالنفاد</h3><div class="feature-list">${[...data.medicines].sort((a, b) => a.quantity - b.quantity).slice(0, 5).map((medicine) => `<div class="feature-item"><span class="feature-item-main"><strong>${esc(medicine.name)} · ${Number(medicine.quantity).toLocaleString("ar-EG")} ${esc(medicine.unit)}</strong><small>الحد الأدنى ${Number(medicine.minimum).toLocaleString("ar-EG")} · التوريد المقترح ${Number(medicine.suggestedSupply).toLocaleString("ar-EG")}</small><span class="stock-bar"><span style="width:${Math.min(100, Math.max(5, Number(medicine.quantity) / Math.max(1, medicine.minimum) * 10))}%"></span></span></span></div>`).join("")}</div><h3 class="feature-subheading">توقع النفاد</h3>${notice("غير متاح: نحتاج سجل مبيعات/صرف يومي ورصيدًا محدثًا لكل فرع، مع وحدة قياس موحدة. الكمية المقترحة للتوريد ليست توقعًا زمنيًا.")}`;
  };

  const reservationsMarkup = () => {
    const reservations = getScoped(DB.reservations);
    const now = Date.now();
    return `${featureHeader("تذكرة محلية", "حجوزاتي", "إنشاء تذكرة تجريبية بعمر ساعتين للعرض. لن تحجز الدواء فعليًا لدى الصيدلية.")}${notice("رمز التذكرة محلي وغير متصل بنظام صيدلية، ولا يوجد مسح QR أو تحقق حقيقي لدى الفرع.", "warning")}<form class="feature-form" data-form="reservation">${medicineSelect("reservation-medicine")}${pharmacySelect("reservation-pharmacy")}<button class="button button-primary" type="submit">إنشاء تذكرة تجريبية</button></form><h3 class="feature-subheading">التذاكر المحفوظة (${reservations.length})</h3><div class="feature-list">${reservations.length ? reservations.map((reservation) => {
      const medicine = getMedicine(reservation.medicineId);
      const pharmacy = getPharmacy(reservation.pharmacyId);
      const remaining = reservation.expiresAt - now;
      return `<div class="reservation-ticket"><div class="reservation-qr" data-qr-code="${esc(reservation.token)}" aria-label="رمز QR محلي للتذكرة"></div><span><strong>${esc(medicine?.name)} · ${esc(pharmacy?.name)}</strong><small>${esc(reservation.token)} · ${remaining > 0 ? "صالحة مؤقتًا (تجريبي)" : "انتهت صلاحيتها"}</small>${remaining > 0 ? `<div class="countdown" data-countdown="${esc(reservation.id)}" data-expires="${reservation.expiresAt}">--:--:--</div>` : ""}</span><div class="feature-actions"><button class="button button-outline" type="button" data-share-medicine="${reservation.medicineId}">مشاركة الدواء</button><button class="button button-outline" type="button" data-remove-reservation="${esc(reservation.id)}">إزالة</button></div></div>`;
    }).join("") : notice("مفيش تذاكر حجز محفوظة.")}</div>`;
  };

  const careMarkup = (tab = "reminders") => {
    const reminders = getScoped(DB.reminders);
    const family = getScoped(DB.family);
    const panel = tab === "reminders"
      ? `<h3 class="feature-subheading">تذكير جرعة أو تجديد</h3>${notice("التذكير يعمل على هذا المتصفح عند بقاء الموقع مفتوحًا، وليس بديلًا عن تطبيق دوائي معتمد أو وصفة الطبيب.")}<form class="feature-form" data-form="reminder">${medicineSelect("reminder-medicine")}<div class="feature-grid"><div class="feature-field"><label for="reminder-time">وقت التذكير</label><input id="reminder-time" type="time" required></div><div class="feature-field"><label for="reminder-kind">نوع التذكير</label><select id="reminder-kind"><option value="جرعة">جرعة</option><option value="تجديد">تجديد</option></select></div></div>${family.length ? `<div class="feature-field"><label for="reminder-family">لمن التذكير؟</label><select id="reminder-family"><option value="">أنا</option>${family.map((member) => `<option value="${esc(member.id)}">${esc(member.name)} · ${esc(member.relation)}</option>`).join("")}</select></div>` : ""}<div class="feature-actions"><button class="button button-primary" type="submit">حفظ التذكير</button><button class="button button-outline" type="button" data-action="enable-notifications">تفعيل إشعارات الجهاز</button></div></form><div class="feature-list">${reminders.length ? reminders.map((reminder) => `<div class="feature-item"><span class="feature-item-main"><strong>${esc(getMedicine(reminder.medicineId)?.name)} · ${esc(reminder.kind)} · ${esc(reminder.time)}</strong><small>حساب ${esc(reminder.familyName || "أنا")}</small></span><button type="button" data-remove-reminder="${esc(reminder.id)}">إزالة</button></div>`).join("") : notice("لسه مفيش تذكيرات.")}</div>`
      : `<h3 class="feature-subheading">ملفات العائلة</h3>${notice("الملفات محلية على هذا الجهاز. اكتفي باسم أو صلة القرابة، وتجنبي تخزين معلومات حساسة.", "warning")}<form class="feature-form" data-form="family"><div class="feature-grid"><div class="feature-field"><label for="family-name">الاسم</label><input id="family-name" required maxlength="60" placeholder="اسم مختصر"></div><div class="feature-field"><label for="family-relation">صلة القرابة</label><input id="family-relation" required maxlength="40" placeholder="مثال: أمي"></div></div><button class="button button-primary" type="submit">إضافة فرد</button></form><div class="feature-list">${family.length ? family.map((member) => `<div class="feature-item"><span class="feature-item-main"><strong>${esc(member.name)}</strong><small>${esc(member.relation)} · ملف محلي</small></span><button type="button" data-remove-family="${esc(member.id)}">إزالة</button></div>`).join("") : notice("أضيفي ملفًا عائليًا للتنظيم.")}</div>`;
    return `${featureHeader("رعاية أسهل", "التذكيرات والعائلة", "نظّمي تذكيراتك وملفات العائلة محليًا على هذا الجهاز.")}<div class="care-tabs"><button type="button" class="care-tab ${tab === "reminders" ? "active" : ""}" data-care-tab="reminders">تذكيراتي</button><button type="button" class="care-tab ${tab === "family" ? "active" : ""}" data-care-tab="family">العائلة (${family.length})</button></div><div class="care-panel">${panel}</div>`;
  };

  const installMarkup = () => `${featureHeader("دوائي على جهازك", "تثبيت واستخدام دون اتصال", "يمكن تثبيت الموقع كـ PWA على المتصفحات الداعمة بعد زيارة الموقع عبر HTTPS أو localhost.")}${notice("سيتم حفظ ملفات الواجهة وقائمة الأدوية للعمل دون اتصال جزئيًا. البحث والدليل يعملان من البيانات المدمجة. إرسال SMS أو تنبيهات Push من الخادم غير متاح في النسخة الثابتة.")}<div class="feature-actions"><button type="button" class="button button-primary" data-action="install-confirm">تثبيت التطبيق</button><button type="button" class="button button-outline" data-action="enable-notifications">تفعيل إشعارات الجهاز</button></div><div class="feature-list"><div class="feature-item"><span class="feature-item-main"><strong>على iPhone / iPad</strong><small>من Safari اختاري مشاركة ثم «إضافة إلى الشاشة الرئيسية».</small></span></div><div class="feature-item"><span class="feature-item-main"><strong>على Android</strong><small>استخدمي خيار تثبيت التطبيق في قائمة Chrome، إذا ظهر.</small></span></div></div>`;

  const renderFeature = (feature, options = {}) => {
    if (!data) return;
    if (feature === "emergency") content.innerHTML = emergencyMarkup();
    else if (feature === "alerts") content.innerHTML = alertsMarkup();
    else if (feature === "alternatives") content.innerHTML = alternativeMarkup(options.medicineId || "");
    else if (feature === "interactions") content.innerHTML = interactionsMarkup();
    else if (feature === "network") content.innerHTML = networkMarkup();
    else if (feature === "shortages") content.innerHTML = shortageMarkup();
    else if (feature === "reservations") content.innerHTML = reservationsMarkup();
    else if (feature === "care") content.innerHTML = careMarkup(options.tab || "reminders");
    else if (feature === "install") content.innerHTML = installMarkup();
    else if (feature === "assistant") content.innerHTML = assistantMarkup();
    else if (feature === "palette") content.innerHTML = paletteMarkup(options.query || "");
    else if (feature === "image") content.innerHTML = imageMarkup();
    else if (feature === "tour") content.innerHTML = tourContentMarkup();
    refreshCountdowns();
    if (feature === "reservations") renderQrCodes();
  };

  const assistantMarkup = () => {
    const history = getScoped("dawaey-assistant-chat-v1");
    const messages = history.length ? history : [{ role: "assistant", text: "أهلًا! اسأليني عن اسم دواء أو صيدلية. أقدر أبحث في الدليل، لكن ما بقدمش تشخيصًا أو جرعات." }];
    return `${featureHeader("المساعد دوّي", "اسأليني عن أي دواء أو صيدلية", "اكتبي اسم الدواء بالعربي أو بالإنجليزي، ومش محتاجة صورة.")}<div class="chat-log" id="assistant-log">${messages.map((message) => `<div class="chat-message ${message.role === "user" ? "user" : ""}">${esc(message.text)}${message.medicineId ? `<button class="chat-medicine-details" type="button" data-chat-medicine="${Number(message.medicineId)}">عرض تفاصيل الدواء كاملة</button>` : ""}</div>`).join("")}</div><form class="feature-form" data-form="assistant"><div class="feature-field"><label for="assistant-message">اكتبي سؤالك</label><input id="assistant-message" maxlength="160" autocomplete="off" placeholder="مثال: بانادول أو Panadol"></div><button class="button button-primary" type="submit">إرسال السؤال</button></form>${notice("المساعد يوضح الاستخدام العام حسب تصنيف الدليل، وليس تشخيصًا أو نصيحة جرعات. اسألي صيدليًا أو طبيبًا عن استخدامك الشخصي.", "warning")}`;
  };
  const paletteMarkup = (query = "") => {
    const actions = [
      ["البحث عن دواء", "search"], ["البحث عن صيدلية", "pharmacies"], ["وضع الطوارئ", "emergency"],
      ["تذكيراتي والعائلة", "care"], ["فاحص التداخلات", "interactions"], ["طلب تحويل", "network"],
      ["حجوزاتي", "reservations"], ["بدائل الدواء", "alternatives"], ["مساعدة دوّي", "assistant"]
    ];
    const term = norm(query);
    const filtered = actions.filter(([label]) => !term || norm(label).includes(term));
    return `${featureHeader("تنقّل سريع · Ctrl+K", "إيه اللي محتاجاه؟", "ابحثي عن صفحة أو اختاري أداة من القائمة.")}<div class="feature-field"><label class="sr-only" for="palette-search">ابحثي عن أداة</label><input id="palette-search" type="search" value="${esc(query)}" placeholder="اكتبي: بحث، طوارئ، تذكير..."></div><div class="palette-results" id="palette-results">${filtered.map(([label, action]) => `<button type="button" class="palette-action" data-palette-action="${action}">${esc(label)}</button>`).join("") || notice("مفيش نتيجة، جرّبي كلمة مختلفة.")}</div>`;
  };
  const imageMarkup = () => `${featureHeader("بحث بالصورة", "صورة دواء أو روشتة", "ارفعي صورة واضحة؛ سيحاول المتصفح قراءة النص إذا كانت ميزة OCR متاحة.")}${notice("لا نرفع الصورة لأي خدمة. إذا لم يدعم متصفحك OCR، اكتبي اسم الدواء يدويًا. لا تشاركي روشتة تحتوي بيانات شخصية.", "warning")}<div class="feature-field"><label for="image-search-dialog">اختيار صورة</label><input id="image-search-dialog" type="file" accept="image/*" capture="environment"></div><img id="search-image-preview" alt="معاينة صورة البحث" hidden style="display:block;max-height:190px;max-width:100%;margin:10px auto;border-radius:10px"><div class="feature-field"><label for="image-search-text">اسم الدواء أو النص المقروء</label><input id="image-search-text" type="search" placeholder="اكتبي الاسم الظاهر على العلبة أو الروشتة"></div><div class="feature-actions"><button type="button" class="button button-primary" data-action="image-search-submit">ابحثي عن الدواء</button></div><div id="image-search-message" class="feature-notice info" hidden></div>`;

  const medicinePurpose = (medicine) => {
    const category = norm(medicine.category);
    if (category.includes("مضاد حيوي")) return "مضاد حيوي يُستخدم لعلاج بعض العدوى البكتيرية بوصفة مختص، ولا يعالج نزلات البرد الفيروسية.";
    if (category.includes("صفائح")) return "مرتبط بتقليل تجمع الصفائح الدموية في حالات يحددها الطبيب؛ لا تستخدميه لهذا الغرض دون وصفة.";
    if (category.includes("مسكن") && category.includes("حرارة")) return "مسكن وخافض للحرارة؛ مثل المساعدة في تخفيف الصداع وبعض الآلام وخفض الحرارة.";
    if (category.includes("مسكن")) return "مسكن يُستخدم لتخفيف بعض أنواع الألم، وقد يكون له استعمالات أخرى حسب المادة الفعالة.";
    if (category.includes("حساسية")) return "يُستخدم عادةً لتخفيف أعراض الحساسية، وقد يختلف الاستخدام حسب المادة الفعالة.";
    if (category.includes("برد") || category.includes("انفلونزا")) return "يُستخدم لتخفيف بعض أعراض البرد أو الإنفلونزا، وليس علاجًا لكل أسبابها.";
    if (category.includes("حموضة") || category.includes("ارتجاع")) return "يُستخدم عادةً لتخفيف الحموضة أو أعراض الارتجاع.";
    if (category.includes("إسهال") || category.includes("أمعاء") || category.includes("بروبيوتك")) return "يُستخدم لبعض اضطرابات الجهاز الهضمي، ويعتمد الاستخدام على السبب والحالة.";
    if (category.includes("تقلصات")) return "يُستخدم لتخفيف بعض التقلصات أو المغص، مع اختلاف السبب والاستعمال من دواء لآخر.";
    if (category.includes("قيء")) return "يُستخدم لتخفيف الغثيان أو القيء في حالات معينة، ويعتمد الاستخدام على السبب.";
    if (category.includes("سكري") || category.includes("انسولين")) return "دواء مرتبط بعلاج السكري وتنظيم سكر الدم، ويجب استخدامه حسب وصف الطبيب فقط.";
    if (category.includes("ضغط") || category.includes("قلب") || category.includes("مدر للبول")) return "دواء مرتبط بعلاج ضغط الدم أو القلب؛ لا توقفيه أو تغيّري استخدامه من نفسك.";
    if (category.includes("ربو") || category.includes("تنفسي") || category.includes("الشعب")) return "يُستخدم لبعض حالات الجهاز التنفسي أو لتخفيف أعراضها، وفق إرشادات الطبيب.";
    if (category.includes("كحة") || category.includes("بلغم")) return "يُستخدم لتخفيف الكحة أو المساعدة على إخراج البلغم حسب نوع المستحضر.";
    if (category.includes("أنف") || category.includes("احتقان")) return "يُستخدم عادةً لتخفيف احتقان الأنف أو ترطيبه حسب نوع المستحضر.";
    if (category.includes("جفاف")) return "محلول لتعويض الماء والأملاح المفقودة في حالات مثل الإسهال، ويجب طلب المشورة الطبية عند الجفاف الشديد.";
    if (category.includes("غدة درقية")) return "يُستخدم لعلاج بعض اضطرابات الغدة الدرقية، بمتابعة الطبيب.";
    if (category.includes("مضاد فطريات")) return "مضاد للفطريات، ويختلف الاستخدام حسب مكان ونوع العدوى.";
    if (category.includes("مضاد فيروسات")) return "مضاد للفيروسات لحالات محددة، ويُستخدم بتوجيه طبي.";
    if (category.includes("طفيليات")) return "يُستخدم لعلاج بعض العدوى الطفيلية، ويجب تحديد الدواء المناسب بواسطة مختص.";
    if (category.includes("عين")) return "قطرة أو مستحضر للعين؛ يختلف الغرض بين ترطيب العين وعلاج الالتهاب أو العدوى حسب التصنيف والمادة الفعالة.";
    if (category.includes("جلدي") || category.includes("الجلد")) return "مستحضر موضعي لحالات جلدية محددة؛ راجعي الصيدلي أو الطبيب لتحديد الاستخدام المناسب.";
    if (category.includes("الصرع") || category.includes("العصبي")) return "دواء مرتبط بحالات الجهاز العصبي، وبعضها لعلاج نوبات الصرع؛ يُستخدم بوصفة ومتابعة الطبيب.";
    if (category.includes("كورتيزون")) return "دواء من فئة الكورتيزون لتخفيف الالتهاب في استعمالات محددة؛ يُستخدم وفق وصف الطبيب.";
    if (category.includes("فيتامين") || category.includes("مكمل") || category.includes("كالسيوم") || category.includes("حديد")) return "فيتامين أو مكمل غذائي؛ الحاجة إليه وطريقة استخدامه تعتمد على الحالة وتوجيه المختص.";
    return `تصنيفه في الدليل هو «${medicine.category}»، لكن البيانات لا تحدد استخدامًا أدق أو المادة الفعالة.`;
  };
  const findMedicine = (question) => {
    const term = normalizeMedicineSearch(question);
    return data.medicines
      .map((item) => ({
        item,
        aliases: [item.name, ...(item.arabicNames || "").split(/[،,;؛|]/)]
          .map(normalizeMedicineSearch)
          .filter((alias) => alias.length >= 3)
      }))
      .map(({ item, aliases }) => ({
        item,
        score: Math.max(0, ...aliases.map((alias) => term.includes(alias) ? alias.length : 0))
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)[0]?.item;
  };
  const assistantReply = (question, medicine = findMedicine(question)) => {
    const term = normalizeMedicineSearch(question);
    const pharmacy = data.pharmacies.find((item) => norm(item.name).includes(term) || norm(item.address).includes(term));
    const account = currentAccount();
    const pharmacyInventory = account?.role === "pharmacy" && Array.isArray(account.pharmacyInventory)
      ? account.pharmacyInventory
      : [];
    const asksAboutPharmacyStock = /ادوي|ادويه|متاح|متوفر|مخزون|رصيد|موجود|يوجد|صيدلي|عندي|لدي|available|availability|stock|inventory|pharmacy/.test(term);
    if (account?.role === "pharmacy" && asksAboutPharmacyStock && medicine) {
      const ownStock = pharmacyInventory.find((entry) => entry.medicineId === medicine.id);
      if (!ownStock) {
        return `${medicine.name} غير مسجل في مخزون ${account.pharmacyName} حتى الآن. هذا لا يؤكد عدم توفره؛ حدّثي مخزون الصيدلية أو تحققي منها مباشرة.`;
      }
      return ownStock.quantity > 0
        ? `${medicine.name} متاح في مخزون ${account.pharmacyName} حسب آخر تحديث: ${ownStock.quantity} ${medicine.unit}. اتصلي بالصيدلية للتأكد من الكمية الحالية.`
        : `${medicine.name} مسجل كغير متوفر حاليًا في مخزون ${account.pharmacyName} حسب آخر تحديث.`;
    }
    if (account?.role === "pharmacy" && asksAboutPharmacyStock) {
      const available = pharmacyInventory
        .filter((entry) => entry.quantity > 0)
        .map((entry) => {
          const item = data.medicines.find((candidate) => candidate.id === entry.medicineId);
          return item ? `${item.name}${item.arabicNames ? ` (${item.arabicNames.split(/[،,]/)[0].trim()})` : ""}: ${entry.quantity} ${item.unit}` : "";
        })
        .filter(Boolean);
      return available.length
        ? `الأدوية المتاحة حسب آخر تحديث لمخزون ${account.pharmacyName}:\n• ${available.join("\n• ")}\nتحققي من الكمية مع الصيدلية قبل الاعتماد عليها.`
        : `لا توجد أدوية مسجلة كمتاحة في مخزون ${account.pharmacyName} حاليًا. حدّثي القائمة من ملف حساب الصيدلية.`;
    }
    if (medicine) {
      return `تفاصيل ${medicine.name}${medicine.arabicNames ? ` (${medicine.arabicNames})` : ""}:\n• التصنيف: ${medicine.category}.\n• الاستخدام العام: ${medicinePurpose(medicine)}\n• الكمية المسجلة: ${medicine.quantity} ${medicine.unit} — ${medicine.stockStatus} حسب الملف.\n• الحد الأدنى المسجل: ${medicine.minimum} ${medicine.unit}.\n• كمية التوريد المقترحة: ${medicine.suggestedSupply} ${medicine.unit}.\n• كود الصنف: ${medicine.code}.\nالكمية معلومات عامة وليست مخزونًا مباشرًا لدى فرع. الدليل لا يتضمن المادة الفعالة أو الجرعة أو التحذيرات؛ راجعي النشرة أو الصيدلي/الطبيب، ولا تعتمدي على التصنيف لتحديد علاجك الشخصي.`;
    }
    if (pharmacy) return `لقيت ${pharmacy.name} في ${pharmacy.address}. رقم التواصل كما في الملف: ${pharmacy.phone}. تحققي من الرقم ومواعيد العمل قبل الزيارة.`;
    if (/جرع|استخدم|اخد|اخذ|تداخل|بديل|حامل|طفل|اعراض|أعراض/.test(term)) return "ما أقدرش أحدد جرعة أو بديل أو تداخل أو تشخيص. اسألي الصيدلي أو الطبيب مع العبوة وقائمة أدويتك.";
    return "تنبيه: الدواء غير موجود في قاعدة بيانات دوائي حاليًا. ده لا يثبت إنه غير متوفر في السوق؛ ما عندناش بيانات مباشرة عن السوق أو مخزون كل الصيدليات. اسألي صيدلية قريبة للتأكد، أو راجعي الإدارة لإضافة الدواء للدليل. تقدري تكتبي اسمه بالعربي أو بالإنجليزي من غير صورة.";
  };
  const saveChat = (history) => {
    putValue(scopedKey("dawaey-assistant-chat-v1"), history.slice(-30));
  };

  const beginTour = () => {
    featureState.tourReturnFocus = document.activeElement;
    featureState.tourStep = 0;
    $("#tour-shade").hidden = false;
    renderTourStep();
  };
  const tourSteps = [
    { selector: "#search-input", title: "١. ابحثي بالطريقة الأسهل", body: "اكتبي اسم الدواء، استخدمي البحث الصوتي، أو اختاري صورة. النتائج من الدليل المدمج." },
    { selector: ".patient-tools", title: "٢. أدوات المريض", body: "تنبيهات وتذكيرات وعائلة ومعلومات صيدليات — بعضها تجريبي لأن الدليل لا يتصل بمخزون مباشر." },
    { selector: "#auth-open", title: "٣. احفظي بياناتك", body: "أنشئي حسابًا محليًا للاحتفاظ بقائمة أدويتك على هذا المتصفح فقط." }
  ];
  const renderTourStep = () => {
    $$(".tour-card").forEach((item) => item.remove());
    const step = tourSteps[featureState.tourStep];
    if (!step) return endTour(true);
    const target = $(step.selector);
    const card = document.createElement("section");
    card.className = "tour-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "جولة تعريفية");
    card.innerHTML = `<h3>${esc(step.title)}</h3><p>${esc(step.body)}</p><div class="tour-card-actions"><span>${featureState.tourStep + 1} / ${tourSteps.length}</span><button type="button" data-tour-next>${featureState.tourStep === tourSteps.length - 1 ? "إنهاء" : "التالي"}</button><button type="button" class="tour-skip" data-tour-skip>تخطي الجولة</button></div>`;
    document.body.append(card);
    const rect = target?.getBoundingClientRect();
    if (rect && innerWidth > 620) {
      card.style.top = `${Math.min(innerHeight - card.offsetHeight - 16, Math.max(12, rect.bottom + 12))}px`;
      card.style.right = `${Math.max(16, innerWidth - rect.right)}px`;
    }
    card.querySelector("[data-tour-next]").focus();
    card.addEventListener("click", (event) => {
      if (event.target.closest("[data-tour-skip]")) endTour(true);
      else if (event.target.closest("[data-tour-next]")) {
        featureState.tourStep++;
        renderTourStep();
      }
    });
  };
  const endTour = (done) => {
    $("#tour-shade").hidden = true;
    $$(".tour-card").forEach((item) => item.remove());
    if (done) putValue(DB.tour, true);
    featureState.tourReturnFocus?.focus?.();
  };
  const tourContentMarkup = () => `${featureHeader("تعريف سريع", "جولة دوائي", "هنتعرف على البحث والأدوات وحساب المريض.")}<div class="feature-actions"><button type="button" class="button button-primary" data-action="start-tour">ابدئي الجولة</button><button type="button" class="button button-outline" data-action="finish-tour">مش دلوقتي</button></div>`;

  const renderTransferChat = (id) => {
    const requests = getScoped(DB.transfers);
    const request = requests.find((item) => item.id === id);
    if (!request) return;
    const medicine = getMedicine(request.medicineId);
    const from = getPharmacy(request.fromId);
    const to = getPharmacy(request.toId);
    content.innerHTML = `${featureHeader("محادثة محلية", `طلب ${medicine?.name || "تحويل"}`, "رسائل محفوظة على هذا الجهاز فقط، وليست محادثة مباشرة مع الصيدلية.")}<div class="feature-notice warning">${esc(from?.name)} ←→ ${esc(to?.name)} · الحالة: ${esc(request.status)}</div><div class="chat-log">${request.messages.map((message) => `<div class="chat-message ${message.author === "أنت" ? "user" : ""}"><strong>${esc(message.author)}:</strong> ${esc(message.text)}</div>`).join("") || `<div class="chat-message">دوائي: طلب التحويل محفوظ محليًا. لم يتم إرساله للصيدلية.</div>`}</div><form class="feature-form" data-form="transfer-chat" data-id="${esc(request.id)}"><div class="feature-field"><label for="transfer-chat-message">رسالتك</label><input id="transfer-chat-message" maxlength="180" placeholder="اكتبي رسالة توضيحية"></div><button class="button button-primary" type="submit">حفظ الرسالة على الجهاز</button></form><div class="feature-actions"><button class="button button-outline" type="button" data-feature-back="network">رجوع لطلبات التحويل</button></div>`;
  };

  const refreshCountdowns = () => {
    $$(".countdown[data-expires]", content).forEach((clock) => {
      const remaining = Math.max(0, Number(clock.dataset.expires) - Date.now());
      const hours = Math.floor(remaining / 3600000);
      const minutes = Math.floor(remaining % 3600000 / 60000);
      const seconds = Math.floor(remaining % 60000 / 1000);
      clock.textContent = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      if (!remaining) clock.closest(".reservation-ticket").classList.add("expired");
    });
  };
  window.setInterval(refreshCountdowns, 1000);

  const updateSearchStatus = (text) => {
    const status = $("#instant-search-status");
    if (status) status.textContent = text;
  };
  const startVoiceSearch = () => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      updateSearchStatus("البحث الصوتي غير مدعوم في هذا المتصفح. استخدمي البحث الكتابي أو بالصورة.");
      return toast("المتصفح لا يدعم البحث الصوتي.");
    }
    const recognition = new Recognition();
    featureState.voice = recognition;
    recognition.lang = "ar-EG";
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    updateSearchStatus("بسمعك... قولي اسم الدواء.");
    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1][0];
      search.value = result.transcript;
      search.dispatchEvent(new Event("input", { bubbles: true }));
      updateSearchStatus(event.results[event.results.length - 1].isFinal ? `بحثنا عن «${result.transcript}».` : `سمعت: ${result.transcript}`);
    };
    recognition.onerror = (event) => {
      console.warn("توقف البحث الصوتي:", event.error);
      updateSearchStatus(event.error === "not-allowed" ? "اسمحي للمتصفح باستخدام الميكروفون للبحث بالصوت." : "ماسمعتش الاسم بوضوح. جرّبي مرة تانية أو اكتبيه.");
    };
    recognition.onend = () => { if (featureState.voice === recognition) featureState.voice = null; };
    try { recognition.start(); } catch (error) {
      console.error("تعذر بدء البحث الصوتي:", error);
      updateSearchStatus("تعذر بدء الميكروفون. اكتبي اسم الدواء بدلًا من ذلك.");
    }
  };

  const handleSearchImage = async (file) => {
    if (!file || !file.type.startsWith("image/")) return toast("اختاري صورة بصيغة مدعومة.");
    if (file.size > 8 * 1024 * 1024) return toast("الصورة كبيرة. اختاري صورة أقل من ٨ ميجابايت.");
    if (featureState.photoUrl) URL.revokeObjectURL(featureState.photoUrl);
    featureState.photoUrl = URL.createObjectURL(file);
    const preview = $("#search-image-preview");
    preview.src = featureState.photoUrl;
    preview.hidden = false;
    $("#image-search-message").hidden = false;
    $("#image-search-message").textContent = "جاري محاولة القراءة محليًا على الجهاز...";
    if ("TextDetector" in window) {
      try {
        const detector = new TextDetector();
        const bitmap = await createImageBitmap(file);
        const blocks = await detector.detect(bitmap);
        const text = blocks.map((block) => block.rawValue).join(" ").trim();
        bitmap.close();
        if (text) {
          $("#image-search-text").value = text;
          $("#image-search-message").textContent = `اتقرأ النص محليًا: ${text.slice(0, 180)}`;
        } else {
          $("#image-search-message").textContent = "ما ظهرش نص واضح. اكتبي اسم الدواء كما على العلبة.";
        }
      } catch (error) {
        console.warn("فشل OCR المحلي:", error);
        $("#image-search-message").textContent = "تعذرت قراءة النص تلقائيًا. اكتبي الاسم الظاهر يدويًا.";
      }
    } else {
      $("#image-search-message").textContent = "المتصفح لا يدعم قراءة النص من الصور محليًا. الصورة لم تغادر جهازك؛ اكتبي اسم الدواء يدويًا.";
    }
  };

  const enableNotifications = async () => {
    if (!("Notification" in window)) return toast("المتصفح لا يدعم الإشعارات.");
    try {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        toast("تم تفعيل إشعارات الجهاز المحلية. لا توجد إشعارات دفع من خادم.");
        return permission;
      }
      toast(permission === "denied" ? "الإشعارات مرفوضة من إعدادات المتصفح." : "لم يتم تفعيل الإشعارات.");
      return permission;
    } catch (error) {
      console.error("تعذر طلب الإشعارات:", error);
      toast("تعذر طلب إذن الإشعارات.");
      return "error";
    }
  };
  const showLocalNotification = async (title, body, tag) => {
    if (!("Notification" in window)) return false;
    if (Notification.permission !== "granted") return false;
    try {
      if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
        const registration = await navigator.serviceWorker.ready;
        await registration.showNotification(title, { body, icon: "./logo-mark.png", tag });
      } else new Notification(title, { body, icon: "./logo-mark.png", tag });
      return true;
    } catch (error) {
      console.error("تعذر إظهار إشعار محلي:", error);
      return false;
    }
  };

  const handleFeatureSubmit = async (form) => {
    if (form.dataset.form === "alert") {
      const id = Number($("#alert-medicine").value);
      if (!id) return toast("اختاري الدواء الأول.");
      const alerts = getScoped(DB.alerts);
      if (alerts.some((alert) => alert.medicineId === id)) return toast("التنبيه ده محفوظ بالفعل.");
      alerts.push({ id: `alert-${crypto.randomUUID?.() || Date.now()}`, medicineId: id, status: "قيد المتابعة محليًا", createdAt: new Date().toISOString() });
      if (setScoped(DB.alerts, alerts)) {
        renderFeature("alerts");
        toast("اتحفظ التنبيه على هذا الجهاز.");
      }
    } else if (form.dataset.form === "alternative") {
      const id = Number($("#alternative-medicine").value);
      if (!id) return toast("اختاري الدواء الأول.");
      renderFeature("alternatives", { medicineId: id });
    } else if (form.dataset.form === "interaction") {
      const a = getMedicine($("#interaction-medicine-a").value);
      const b = getMedicine($("#interaction-medicine-b").value);
      if (!a || !b) return toast("اختاري دواءين لمراجعة القائمة.");
      $("#interaction-result").innerHTML = notice(`<strong>لم يتم تأكيد السلامة أو التداخل.</strong><br>${esc(a.name)} + ${esc(b.name)}: دليلنا لا يحتوي المادة الفعالة أو التركيز. اعرضي العبوتين على صيدلي أو طبيب قبل الجمع بينهما.`, "danger");
    } else if (form.dataset.form === "transfer") {
      const medicineId = Number($("#transfer-medicine").value);
      const fromId = Number($("#transfer-from").value);
      const toId = Number($("#transfer-to").value);
      if (!medicineId || !fromId || !toId) return toast("اختاري الدواء والصيدليتين.");
      if (fromId === toId) return toast("اختاري صيدليتين مختلفتين.");
      const requests = getScoped(DB.transfers);
      requests.unshift({ id: `transfer-${crypto.randomUUID?.() || Date.now()}`, medicineId, fromId, toId, note: $("#transfer-note").value.trim(), status: "مسودة محلية — لم تُرسل", createdAt: new Date().toISOString(), messages: [] });
      if (setScoped(DB.transfers, requests)) {
        renderFeature("network");
        toast("اتحفظت مسودة طلب التحويل على هذا الجهاز.");
      }
    } else if (form.dataset.form === "transfer-chat") {
      const requests = getScoped(DB.transfers);
      const item = requests.find((request) => request.id === form.dataset.id);
      const message = $("#transfer-chat-message").value.trim();
      if (!item || !message) return toast("اكتبي الرسالة الأول.");
      item.messages.push({ author: "أنت", text: message, createdAt: new Date().toISOString() });
      setScoped(DB.transfers, requests);
      renderTransferChat(item.id);
    } else if (form.dataset.form === "reservation") {
      const medicineId = Number($("#reservation-medicine").value);
      const pharmacyId = Number($("#reservation-pharmacy").value);
      if (!medicineId || !pharmacyId) return toast("اختاري الدواء والصيدلية.");
      const reservations = getScoped(DB.reservations);
      reservations.unshift({ id: `reservation-${crypto.randomUUID?.() || Date.now()}`, token: `DW-${Math.random().toString(36).slice(2, 10).toUpperCase()}`, medicineId, pharmacyId, createdAt: Date.now(), expiresAt: Date.now() + 2 * 60 * 60 * 1000 });
      if (setScoped(DB.reservations, reservations)) {
        renderFeature("reservations");
        toast("اتعملت تذكرة محلية، لكنها ليست حجزًا فعليًا.");
      }
    } else if (form.dataset.form === "reminder") {
      const medicineId = Number($("#reminder-medicine").value);
      const time = $("#reminder-time").value;
      if (!medicineId || !time) return toast("اختاري الدواء ووقت التذكير.");
      const reminders = getScoped(DB.reminders);
      const memberId = $("#reminder-family")?.value || "";
      const member = getScoped(DB.family).find((item) => item.id === memberId);
      reminders.push({ id: `reminder-${crypto.randomUUID?.() || Date.now()}`, medicineId, time, kind: $("#reminder-kind").value, familyName: member?.name || "أنا", lastNotifiedDate: "", createdAt: new Date().toISOString() });
      if (setScoped(DB.reminders, reminders)) {
        renderFeature("care");
        toast("اتحفظ التذكير. هيظهر إشعار محلي وقت بقاء الموقع مفتوحًا.");
      }
    } else if (form.dataset.form === "family") {
      const name = $("#family-name").value.trim();
      const relation = $("#family-relation").value.trim();
      if (!name || !relation) return toast("اكتبي الاسم وصلة القرابة.");
      const family = getScoped(DB.family);
      family.push({ id: `family-${crypto.randomUUID?.() || Date.now()}`, name, relation, createdAt: new Date().toISOString() });
      if (setScoped(DB.family, family)) renderFeature("care", { tab: "family" });
    } else if (form.dataset.form === "assistant") {
      const question = $("#assistant-message").value.trim();
      if (!question) return;
      const history = getScoped("dawaey-assistant-chat-v1");
      const medicine = findMedicine(question);
      history.push(
        { role: "user", text: question },
        { role: "assistant", text: assistantReply(question, medicine), ...(medicine ? { medicineId: medicine.id } : {}) }
      );
      saveChat(history);
      renderFeature("assistant");
      $("#assistant-log").scrollTop = $("#assistant-log").scrollHeight;
      $("#assistant-message").focus();
    }
  };

  const handleAction = async (action) => {
    if (action === "all-pharmacies") {
      dialog.close();
      $("#tab-pharmacies").click();
    } else if (action === "enable-notifications") {
      await enableNotifications();
    } else if (action === "change-alternative") {
      renderFeature("alternatives");
    } else if (action === "install-confirm") {
      if (featureState.installPrompt) {
        featureState.installPrompt.prompt();
        const choice = await featureState.installPrompt.userChoice;
        featureState.installPrompt = null;
        $("#install-app").setAttribute("aria-label", choice.outcome);
      } else {
        toast("من قائمة Chrome اختاري «تثبيت دوائي» أو «إضافة إلى الشاشة الرئيسية».");
      }
    } else if (action === "image-search-submit") {
      const query = $("#image-search-text").value.trim();
      if (!query) return toast("اكتبي اسم الدواء المقروء من الصورة.");
      dialog.close();
      launchSearch(query);
    } else if (action === "start-tour") {
      dialog.close();
      beginTour();
    } else if (action === "finish-tour") {
      putValue(DB.tour, true);
      dialog.close();
    } else if (action === "search") {
      dialog.close();
      launchSearch("");
    } else if (action === "pharmacies") {
      dialog.close();
      $("#tab-pharmacies").click();
    } else if (["emergency", "care", "interactions", "network", "reservations", "alternatives", "assistant"].includes(action)) {
      showDialog(action);
    }
  };

  content.addEventListener("submit", (event) => {
    event.preventDefault();
    handleFeatureSubmit(event.target).catch((error) => {
      console.error("تعذر تنفيذ أداة المريض:", error);
      toast("تعذر تنفيذ الخطوة. حاولي مرة تانية.");
    });
  });
  content.addEventListener("click", (event) => {
    const medicineDetails = event.target.closest("[data-chat-medicine]");
    if (medicineDetails) {
      dialog.close();
      window.dispatchEvent(new CustomEvent("dawaey:medicine-detail", {
        detail: { id: Number(medicineDetails.dataset.chatMedicine) }
      }));
      return;
    }
    const featureButton = event.target.closest("[data-feature]");
    if (featureButton) return showDialog(featureButton.dataset.feature);
    const actionButton = event.target.closest("[data-action]");
    if (actionButton) return handleAction(actionButton.dataset.action);
    const tab = event.target.closest("[data-care-tab]");
    if (tab) return renderFeature("care", { tab: tab.dataset.careTab });
    const paletteButton = event.target.closest("[data-palette-action]");
    if (paletteButton) {
      const action = paletteButton.dataset.paletteAction;
      if (action === "search" || action === "pharmacies") return handleAction(action);
      return handleAction(action);
    }
    const backButton = event.target.closest("[data-feature-back]");
    if (backButton) return renderFeature(backButton.dataset.featureBack);
    const chatButton = event.target.closest("[data-chat-transfer]");
    if (chatButton) return renderTransferChat(chatButton.dataset.chatTransfer);
    const removeAlert = event.target.closest("[data-remove-alert]");
    if (removeAlert) {
      const alerts = getScoped(DB.alerts).filter((item) => item.id !== removeAlert.dataset.removeAlert);
      if (setScoped(DB.alerts, alerts)) renderFeature("alerts");
      return;
    }
    const removeReservation = event.target.closest("[data-remove-reservation]");
    if (removeReservation) {
      const reservations = getScoped(DB.reservations).filter((item) => item.id !== removeReservation.dataset.removeReservation);
      if (setScoped(DB.reservations, reservations)) renderFeature("reservations");
      return;
    }
    const removeReminder = event.target.closest("[data-remove-reminder]");
    if (removeReminder) {
      const reminders = getScoped(DB.reminders).filter((item) => item.id !== removeReminder.dataset.removeReminder);
      if (setScoped(DB.reminders, reminders)) renderFeature("care");
      return;
    }
    const removeFamily = event.target.closest("[data-remove-family]");
    if (removeFamily) {
      const family = getScoped(DB.family).filter((item) => item.id !== removeFamily.dataset.removeFamily);
      if (setScoped(DB.family, family)) renderFeature("care", { tab: "family" });
      return;
    }
    const shareButton = event.target.closest("[data-share-medicine]");
    if (shareButton) {
      const medicine = getMedicine(shareButton.dataset.shareMedicine);
      if (medicine) shareMedicine(medicine);
    }
  });
  content.addEventListener("input", (event) => {
    if (event.target.id === "palette-search") {
      const cursor = event.target.selectionStart;
      renderFeature("palette", { query: event.target.value });
      const input = $("#palette-search");
      input.focus();
      input.setSelectionRange(cursor, cursor);
    }
  });
  content.addEventListener("change", (event) => {
    if (event.target.id === "image-search-dialog" && event.target.files?.[0]) {
      handleSearchImage(event.target.files[0]).catch((error) => {
        console.error("تعذر تجهيز صورة البحث:", error);
        $("#image-search-message").hidden = false;
        $("#image-search-message").textContent = "تعذر فتح الصورة؛ جربي صورة أخرى.";
      });
    }
  });
  const shareMedicine = async (medicine) => {
    const url = shareUrl(medicine);
    const message = `دواء ${medicine.name} في دليل دوائي: ${url} — تحققي من التوفر مع الصيدلية.`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `دوائي · ${medicine.name}`, text: `بيانات ${medicine.name} في دليل دوائي. تحققي من التوفر.`, url });
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
        console.warn("تعذرت المشاركة المباشرة:", error);
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  };

  $("#voice-search").addEventListener("click", startVoiceSearch);
  $("#image-search").addEventListener("change", (event) => {
    if (event.target.files?.[0]) {
      showDialog("image");
      const copy = new DataTransfer();
      copy.items.add(event.target.files[0]);
      $("#image-search-dialog").files = copy.files;
      handleSearchImage(event.target.files[0]).catch((error) => {
        console.error("تعذر فتح صورة البحث:", error);
        toast("تعذر فتح الصورة.");
      });
    }
  });
  $$(".patient-tool[data-feature]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.feature === "tour") {
      showDialog("tour");
      return;
    }
    showDialog(button.dataset.feature);
  }));
  $("#emergency-open").addEventListener("click", () => showDialog("emergency"));
  dialog.querySelector(".feature-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  $("#assistant-open").addEventListener("click", () => showDialog("assistant"));
  document.addEventListener("dawaey:feature", (event) => {
    if (event.detail?.feature) showDialog(event.detail.feature, event.detail.options || {});
  });

  const beforeInstall = (event) => {
    event.preventDefault();
    featureState.installPrompt = event;
    $("#install-app").hidden = false;
  };
  window.addEventListener("beforeinstallprompt", beforeInstall);
  window.addEventListener("appinstalled", () => {
    featureState.installPrompt = null;
    toast("دوائي اتثبت على جهازك.");
  });
  $("#install-app").addEventListener("click", () => showDialog("install"));

  const updateReminders = async () => {
    const reminders = getScoped(DB.reminders);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    let changed = false;
    for (const reminder of reminders) {
      if (reminder.time <= currentTime && reminder.lastNotifiedDate !== today) {
        const medicine = getMedicine(reminder.medicineId);
        const sent = await showLocalNotification("تذكير من دوائي", `${reminder.kind}: راجعي تعليمات ${medicine?.name || "دوائك"} مع مختصك.`, reminder.id);
        if (sent) {
          reminder.lastNotifiedDate = today;
          changed = true;
        }
      }
    }
    if (changed) setScoped(DB.reminders, reminders);
  };
  window.setInterval(() => { updateReminders().catch((error) => console.error("تعذر فحص تذكيرات الجرعات:", error)); }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) updateReminders().catch((error) => console.error("تعذر تحديث التذكيرات:", error));
  });

  let hotTourShown = false;
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      showDialog("palette", { query: "" });
      window.setTimeout(() => $("#palette-search")?.focus(), 50);
    } else if (event.key === "Escape" && !dialog.open) {
      if (!$("#tour-shade").hidden) endTour(true);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches(".tour-card [data-tour-next]")) {
      featureState.tourStep++;
      renderTourStep();
    }
  });
  if (!getValue(DB.tour, false)) {
    window.setTimeout(() => {
      if (hotTourShown || dialog.open) return;
      hotTourShown = true;
      beginTour();
    }, 1200);
  }

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").then((registration) => {
      registration.update().catch((error) => console.warn("تعذر فحص تحديث تطبيق دوائي:", error));
    }).catch((error) => {
      console.warn("تعذر تسجيل تطبيق العمل دون اتصال:", error);
      $("#instant-search-status").textContent = "يمكن استخدام الموقع الآن؛ لم يتم تفعيل التخزين دون اتصال.";
    });
  }
})();
