(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const content = $("#admin-content");
  const labels = {
    pharmacy_application_submitted: "استلام طلب انضمام صيدلية",
    pharmacy_approved: "قبول طلب صيدلية",
    pharmacy_rejected: "رفض طلب صيدلية",
    user_status_changed: "تغيير حالة مستخدم",
    medicine_updated: "تعديل بيانات دواء",
    shortage_report_added: "إضافة بلاغ نقص",
    shortage_report_deleted: "حذف بلاغ نقص",
    order_created: "طلب حجز جديد",
    order_accepted: "قبول وحجز طلب",
    order_rejected: "رفض طلب حجز",
    order_fulfilled: "تأكيد استلام طلب",
    order_cancelled: "إلغاء طلب حجز",
    pharmacy_inventory_updated: "تحديث مخزون صيدلية"
  };
  const state = { overview: null, tab: "pharmacies", rejectingId: null };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const dateText = (value) => value ? new Date(value).toLocaleString("ar-EG") : "—";
  const toast = (text) => {
    const item = document.createElement("div");
    item.className = "admin-toast";
    item.textContent = text;
    $("#admin-toast").append(item);
    window.setTimeout(() => item.remove(), 3200);
  };
  const request = async (url, options = {}) => {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
    });
    const result = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(result.error || "تعذر إكمال الطلب.");
    return result;
  };
  const showLogin = (error = "") => {
    $("#admin-login").hidden = false;
    $("#admin-dashboard").hidden = true;
    const message = $("#admin-login-error");
    message.hidden = !error;
    message.textContent = error;
  };
  const loadOverview = async () => {
    const response = await request("/api/admin/overview");
    state.overview = response;
    const unread = (response.notifications || []).filter((item) => !item.readAt).length;
    const badge = $("#admin-notification-count");
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? "99+" : String(unread);
    $("#admin-notifications-open").setAttribute("aria-label", unread
      ? `الإشعارات، ${unread} غير مقروء`
      : "الإشعارات");
    renderTab();
  };
  const countStat = (number, label) => `<div class="admin-stat"><strong>${number.toLocaleString("ar-EG")}</strong><small>${escapeHtml(label)}</small></div>`;
  const statusBadge = (status) => `<span class="admin-badge ${escapeHtml(status)}">${({
    pending: "قيد المراجعة", approved: "مقبولة", rejected: "مرفوضة",
    accepted: "محجوز", fulfilled: "تم الاستلام", cancelled: "ملغي",
    active: "نشط", suspended: "موقوف", unavailable: "غير متوفر", shortage: "نقص"
  })[status] || "متاح"}</span>`;

  const renderPharmacies = () => {
    const users = state.overview.users.filter((user) => user.role === "pharmacy");
    const pending = users.filter((user) => user.status === "pending");
    const pharmacyDetails = (user) => `<div class="admin-meta">
      <span>المحافظة: ${escapeHtml(user.governorate)}</span><span>المنطقة: ${escapeHtml(user.area)}</span>
      <span>الترخيص: ${escapeHtml(user.license)}</span><span>الهاتف: ${escapeHtml(user.phone)}</span>
      <span>واتساب: ${escapeHtml(user.whatsapp)}</span><span>الدوام: ${escapeHtml(user.openingTime)}–${escapeHtml(user.closingTime)}</span>
    </div><p>${escapeHtml(user.address)}</p>${user.location
      ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${user.location.lat},${user.location.lng}`)}" target="_blank" rel="noopener noreferrer">فتح موقع الصيدلية على الخريطة</a>`
      : `<p>لم يتم تحديد الموقع على الخريطة.</p>`}`;
    return `${countStat(pending.length, "طلبات تنتظر القرار")}${pending.length ? `<div class="admin-list">${pending.map((user) => `<article class="admin-card">
      <div>${statusBadge(user.status)}</div><h3>${escapeHtml(user.pharmacyName)}</h3>${pharmacyDetails(user)}
      <div class="admin-actions"><button class="admin-approve" type="button" data-review="${escapeHtml(user.id)}" data-decision="approved">قبول الطلب</button><button class="admin-reject" type="button" data-start-reject="${escapeHtml(user.id)}">رفض مع ذكر السبب</button></div>${state.rejectingId === user.id ? `<form class="admin-form-box" data-reject-form="${escapeHtml(user.id)}"><div class="admin-field"><label for="rejection-reason">سبب الرفض الذي سيظهر للصيدلية</label><textarea id="rejection-reason" required maxlength="500"></textarea></div><div class="admin-actions"><button class="admin-reject" type="submit">تأكيد الرفض</button><button type="button" data-cancel-reject>إلغاء</button></div></form>` : ""}</article>`).join("")}</div>` : `<div class="admin-empty">لا توجد طلبات صيدليات قيد المراجعة.</div>`}
      <h3>الطلبات التي تمت مراجعتها</h3><div class="admin-list">${users.filter((user) => user.status !== "pending").map((user) => `<article class="admin-card"><h3>${escapeHtml(user.pharmacyName)}</h3>${statusBadge(user.status)}${pharmacyDetails(user)}<small>تاريخ التسجيل: ${dateText(user.createdAt)}</small>${user.rejectionReason ? `<p>سبب الرفض: ${escapeHtml(user.rejectionReason)}</p>` : ""}</article>`).join("") || `<div class="admin-empty">لا توجد طلبات سابقة.</div>`}</div>`;
  };

  const renderUsers = () => {
    const users = state.overview.users;
    return `${countStat(users.length, "حسابات المستخدمين والصيدليات")}<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>الاسم / الصيدلية</th><th>النوع</th><th>وسيلة التواصل</th><th>المحافظة</th><th>الحالة</th><th>تاريخ الإنشاء</th><th>إجراء</th></tr></thead><tbody>${users.map((user) => {
      const name = user.role === "pharmacy" ? user.pharmacyName : user.name;
      const action = user.status === "suspended" ? (user.role === "pharmacy" ? "approved" : "active") : "suspended";
      return `<tr><td>${escapeHtml(name || "—")}<br><small>${escapeHtml(user.id)}</small></td><td>${user.role === "patient" ? "مريض" : "صيدلية"}</td><td>${escapeHtml(user.contact)}</td><td>${escapeHtml(user.governorate || "—")}</td><td>${statusBadge(user.status)}</td><td>${dateText(user.createdAt)}</td><td><button type="button" class="admin-save" data-user-status="${escapeHtml(user.id)}" data-status="${action}">${action === "suspended" ? "إيقاف الحساب" : "إعادة التفعيل"}</button></td></tr>`;
    }).join("")}</tbody></table></div><p>الإيقاف قابل للعكس، وتبقى سجلات المراجعة محفوظة في سجل العمليات.</p>`;
  };

  const renderMedicines = () => `<p>أضيفي أسماء الدواء العربية مفصولة بفواصل؛ تصبح قابلة للبحث فور الحفظ. الأرقام هنا من ملف المصدر وليست أرصدة فروع مباشرة.</p><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>الاسم الأساسي</th><th>الأسماء بالعربية</th><th>التصنيف</th><th>الكمية العامة</th><th>الحد الأدنى</th><th></th></tr></thead><tbody>${state.overview.medicines.map((medicine) => `<tr data-medicine-row="${medicine.id}"><td><input data-field="name" value="${escapeHtml(medicine.name)}" aria-label="الاسم الأساسي"></td><td><input class="alias-input" data-field="arabicNames" value="${escapeHtml(medicine.arabicNames)}" placeholder="بانادول، بنادول" aria-label="الأسماء العربية مفصولة بفواصل"></td><td><input data-field="category" value="${escapeHtml(medicine.category)}" aria-label="التصنيف"></td><td><input data-field="quantity" type="number" min="0" value="${medicine.quantity}" aria-label="الكمية"></td><td><input data-field="minimum" type="number" min="0" value="${medicine.minimum}" aria-label="الحد الأدنى"></td><td><button type="button" class="admin-save" data-save-medicine="${medicine.id}">حفظ</button></td></tr>`).join("")}</tbody></table></div>`;

  const renderHeatmap = () => {
    const reports = state.overview.reports;
    const stats = new Map();
    for (const report of reports) {
      const key = report.governorate;
      const current = stats.get(key) || { count: 0, unavailable: 0, medicines: new Set() };
      current.count++;
      if (report.severity === "unavailable") current.unavailable++;
      current.medicines.add(report.medicineName);
      stats.set(key, current);
    }
    const cells = state.overview.governorates.map((governorate) => {
      const value = stats.get(governorate);
      const level = !value ? "none" : value.unavailable >= 3 || value.count >= 6 ? "high" : value.unavailable || value.count >= 3 ? "medium" : "low";
      return `<div class="heat-cell" data-level="${level}"><strong>${escapeHtml(governorate)}</strong>${value ? `<b>${value.count.toLocaleString("ar-EG")} بلاغ</b><small>${value.unavailable.toLocaleString("ar-EG")} بلاغات بعدم التوفر</small><small>${escapeHtml([...value.medicines].slice(0, 3).join("، "))}${value.medicines.size > 3 ? "…" : ""}</small>` : `<small>لا توجد بلاغات مسجلة</small>`}</div>`;
    }).join("");
    return `<p>تعرض الخريطة البلاغات المسجلة حسب المحافظة، ولا تعتبر عدم وجود بلاغ دليلًا على توفر الدواء. أرفقي مصدرًا يمكن مراجعته عند تسجيل أي بلاغ.</p><div class="shortage-heatmap">${cells}</div>
      <section class="admin-form-box"><h3>تسجيل بلاغ نقص موثق</h3><form id="shortage-form" class="admin-grid">
      <div class="admin-field"><label for="shortage-medicine">الدواء</label><select id="shortage-medicine" required><option value="">اختاري الدواء</option>${state.overview.medicines.map((medicine) => `<option value="${medicine.id}">${escapeHtml(medicine.name)}</option>`).join("")}</select></div>
      <div class="admin-field"><label for="shortage-governorate">المحافظة</label><select id="shortage-governorate" required><option value="">اختاري المحافظة</option>${state.overview.governorates.map((name) => `<option>${escapeHtml(name)}</option>`).join("")}</select></div>
      <div class="admin-field"><label for="shortage-severity">الحالة المبلّغ عنها</label><select id="shortage-severity"><option value="shortage">نقص</option><option value="unavailable">غير متوفر</option></select></div>
      <div class="admin-field"><label for="shortage-source">مصدر البلاغ (مطلوب)</label><input id="shortage-source" required maxlength="180" placeholder="جهة/نشرة/تاريخ التحقق"></div>
      <div class="admin-field"><label for="shortage-note">ملاحظة</label><input id="shortage-note" maxlength="500" placeholder="نطاق المنطقة أو مرجع إضافي"></div><button class="button button-primary" type="submit">حفظ البلاغ وتحديث الخريطة</button></form></section>
      <h3>البلاغات (${reports.length.toLocaleString("ar-EG")})</h3>${reports.length ? `<div class="admin-list">${reports.map((report) => `<article class="admin-card"><h3>${escapeHtml(report.medicineName)} · ${escapeHtml(report.governorate)}</h3>${statusBadge(report.severity)}<div class="admin-meta"><span>المصدر: ${escapeHtml(report.source)}</span><span>${dateText(report.createdAt)}</span></div>${report.note ? `<p>${escapeHtml(report.note)}</p>` : ""}<button class="admin-delete" type="button" data-delete-report="${escapeHtml(report.id)}">حذف البلاغ</button></article>`).join("")}</div>` : `<div class="admin-empty">لا توجد بلاغات حتى الآن. لن نعرض المحافظات كأن مخزونها متوفر.</div>`}`;
  };

  const renderAudit = () => `<p>آخر ٢٠٠ عملية إدارية مسجلة. لا يمكن تعديل السجل من الواجهة.</p><div class="admin-audit">${state.overview.audit.map((item) => `<div class="audit-row"><strong>${escapeHtml(labels[item.action] || item.action)}</strong><small>${escapeHtml(item.actorContact)} · ${escapeHtml(item.targetType)} ${escapeHtml(item.targetId)} · ${dateText(item.createdAt)}</small><small>${escapeHtml(JSON.stringify(item.details))}</small></div>`).join("") || `<div class="admin-empty">لا توجد عمليات إدارية بعد.</div>`}</div>`;

  const adminWhatsAppUrl = (message) => {
    const phone = String(state.overview.adminWhatsApp || "").replace(/\D/g, "");
    if (!/^01[0125]\d{8}$/.test(phone)) return "";
    return `https://wa.me/20${phone.slice(1)}?text=${encodeURIComponent(message)}`;
  };
  const renderOrdersAndNotifications = () => {
    const notifications = state.overview.notifications || [];
    const unread = notifications.filter((item) => !item.readAt);
    const orders = state.overview.orders || [];
    const statusLabels = {
      pending: "بانتظار رد الصيدلية", accepted: "محجوز", rejected: "مرفوض",
      fulfilled: "تم الاستلام", cancelled: "ملغي"
    };
    const notificationCards = notifications.length ? notifications.map((item) => {
      const whatsappUrl = adminWhatsAppUrl(`دوائي — ${item.title}\n${item.message}`);
      return `<article class="admin-card ${item.readAt ? "" : "admin-notification-unread"}">
        <div>${statusBadge(item.readAt ? "active" : "pending")}</div><h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.message)}</p><small>${dateText(item.createdAt)}</small>
        <div class="admin-actions">${whatsappUrl ? `<a class="admin-whatsapp" href="${escapeHtml(whatsappUrl)}" target="_blank" rel="noopener noreferrer">إرسال رسالة واتساب لرقم الإدارة</a>` : `<span>رقم واتساب الإدارة غير مضبوط.</span>`}
        ${!item.readAt ? `<button type="button" data-read-notification="${escapeHtml(item.id)}">تحديد كمقروء</button>` : ""}</div>
      </article>`;
    }).join("") : `<div class="admin-empty">لا توجد إشعارات حتى الآن.</div>`;
    const orderCards = orders.length ? orders.map((order) => `<article class="admin-card">
      <div>${statusBadge(order.status)}</div><h3>${escapeHtml(order.medicineName)} · ${Number(order.quantity).toLocaleString("ar-EG")} ${escapeHtml(order.unit)}</h3>
      <div class="admin-meta"><span>الصيدلية: ${escapeHtml(order.pharmacyName)}</span><span>المريض: ${escapeHtml(order.patientName || "—")}</span><span>تواصل المريض: ${escapeHtml(order.patientContact || order.patientPhone || "—")}</span><span>الصيدلية: ${escapeHtml(order.pharmacyAddress || "—")}</span><span>${dateText(order.createdAt)}</span></div>
      ${order.note ? `<p>ملاحظة المريض: ${escapeHtml(order.note)}</p>` : ""}
    </article>`).join("") : `<div class="admin-empty">لا توجد طلبات حجز بعد.</div>`;
    return `${countStat(unread.length, "إشعارات غير مقروءة")}${countStat(orders.filter((order) => order.status === "pending").length, "طلبات تنتظر رد الصيدلية")}<h3>الإشعارات · ${notifications.length}</h3><p>تُحفظ طلبات الصيدليات والحجوزات هنا. زر واتساب يفتح رسالة جاهزة لرقم الإدارة ${escapeHtml(state.overview.adminWhatsApp)}؛ يلزم الضغط عليه لإرسالها.</p><div class="admin-list">${notificationCards}</div><h3>كل طلبات المرضى (${orders.length})</h3><div class="admin-list">${orderCards}</div>`;
  };

  const renderTab = () => {
    if (!state.overview) return;
    $(".admin-tabs button.active")?.classList.remove("active");
    $(`[data-admin-tab="${state.tab}"]`)?.classList.add("active");
    if (state.tab === "pharmacies") content.innerHTML = renderPharmacies();
    else if (state.tab === "orders") content.innerHTML = renderOrdersAndNotifications();
    else if (state.tab === "users") content.innerHTML = renderUsers();
    else if (state.tab === "medicines") content.innerHTML = renderMedicines();
    else if (state.tab === "shortages") content.innerHTML = renderHeatmap();
    else content.innerHTML = renderAudit();
  };

  const refresh = async (message) => {
    await loadOverview();
    if (message) toast(message);
  };

  $("#admin-login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = $("#admin-login-error");
    error.hidden = true;
    try {
      const result = await request("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ contact: $("#admin-contact").value.trim(), password: $("#admin-password").value })
      });
      if (result.user.role !== "admin") throw new Error("الحساب ليس حساب إدارة.");
      $("#admin-login-error").hidden = true;
      $("#admin-login").hidden = true;
      $("#admin-dashboard").hidden = false;
      await refresh();
    } catch (reason) {
      error.textContent = reason.message;
      error.hidden = false;
    }
  });
  $("#admin-logout").addEventListener("click", async () => {
    try {
      await request("/api/admin/logout", { method: "POST", body: "{}" });
      showLogin();
    } catch (error) {
      toast(error.message);
    }
  });
  $("#admin-refresh").addEventListener("click", () => refresh("تم تحديث بيانات الإدارة."));
  $("#admin-notifications-open").addEventListener("click", () => {
    state.tab = "orders";
    renderTab();
    $("#admin-content").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $(".admin-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-admin-tab]");
    if (!button) return;
    state.tab = button.dataset.adminTab;
    renderTab();
  });
  content.addEventListener("click", async (event) => {
    const review = event.target.closest("[data-review]");
    const startReject = event.target.closest("[data-start-reject]");
    const userButton = event.target.closest("[data-user-status]");
    const medicineButton = event.target.closest("[data-save-medicine]");
    const reportButton = event.target.closest("[data-delete-report]");
    const notificationButton = event.target.closest("[data-read-notification]");
    try {
      if (notificationButton) {
        await request(`/api/admin/notifications/${encodeURIComponent(notificationButton.dataset.readNotification)}`, {
          method: "PATCH", body: JSON.stringify({ read: true })
        });
        await refresh("تم تحديد الإشعار كمقروء.");
      } else if (startReject) {
        state.rejectingId = startReject.dataset.startReject;
        renderTab();
      } else if (event.target.closest("[data-cancel-reject]")) {
        state.rejectingId = null;
        renderTab();
      } else if (review) {
        const decision = review.dataset.decision;
        await request(`/api/admin/pharmacies/${encodeURIComponent(review.dataset.review)}`, {
          method: "PATCH", body: JSON.stringify({ decision, reason: "" })
        });
        await refresh(decision === "approved" ? "تم اعتماد الصيدلية." : "تم رفض الطلب مع حفظ السبب.");
      } else if (userButton) {
        const status = userButton.dataset.status;
        if (!window.confirm(status === "suspended" ? "إيقاف هذا الحساب؟ سيتم إنهاء جلساته." : "إعادة تفعيل هذا الحساب؟")) return;
        await request(`/api/admin/users/${encodeURIComponent(userButton.dataset.userStatus)}`, {
          method: "PATCH", body: JSON.stringify({ status })
        });
        await refresh("تم تحديث حالة الحساب وتسجيل العملية.");
      } else if (medicineButton) {
        const row = medicineButton.closest("[data-medicine-row]");
        const values = Object.fromEntries([...row.querySelectorAll("[data-field]")].map((input) => [input.dataset.field, input.value.trim()]));
        await request(`/api/admin/medicines/${medicineButton.dataset.saveMedicine}`, {
          method: "PATCH", body: JSON.stringify(values)
        });
        await refresh("تم تحديث قاعدة الأدوية. أضيفي الاسم العربي مفصولًا بفواصل.");
      } else if (reportButton) {
        if (!window.confirm("حذف بلاغ النقص؟ سيبقى أثر الحذف في سجل العمليات.")) return;
        await request(`/api/admin/reports/${encodeURIComponent(reportButton.dataset.deleteReport)}`, { method: "DELETE", body: "{}" });
        await refresh("تم حذف البلاغ وتسجيل العملية.");
      }
    } catch (error) {
      toast(error.message);
    }
  });
  content.addEventListener("submit", async (event) => {
    if (event.target.matches("[data-reject-form]")) {
      event.preventDefault();
      const form = event.target;
      const reason = $("#rejection-reason", form).value.trim();
      if (!reason) return toast("اكتبي سبب الرفض.");
      try {
        await request(`/api/admin/pharmacies/${encodeURIComponent(form.dataset.rejectForm)}`, {
          method: "PATCH", body: JSON.stringify({ decision: "rejected", reason })
        });
        state.rejectingId = null;
        await refresh("تم رفض الطلب وحفظ السبب.");
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    if (event.target.id !== "shortage-form") return;
    event.preventDefault();
    try {
      await request("/api/admin/reports", {
        method: "POST",
        body: JSON.stringify({
          medicineId: Number($("#shortage-medicine").value),
          governorate: $("#shortage-governorate").value,
          severity: $("#shortage-severity").value,
          source: $("#shortage-source").value.trim(),
          note: $("#shortage-note").value.trim()
        })
      });
      await refresh("تم حفظ البلاغ وتحديث خريطة المحافظات.");
    } catch (error) {
      toast(error.message);
    }
  });

  request("/api/admin/session").then((result) => {
    if (result.user.role !== "admin") return showLogin("الحساب الحالي ليس حساب إدارة.");
    $("#admin-login").hidden = true;
    $("#admin-dashboard").hidden = false;
    return loadOverview();
  }).catch((error) => {
    if (!String(error.message).includes("سجّلي الدخول")) console.warn("تعذر استعادة جلسة الإدارة:", error);
    showLogin();
  });
  window.setInterval(() => {
    const dashboard = $("#admin-dashboard");
    const editing = content.contains(document.activeElement)
      && document.activeElement.matches("input,textarea,select");
    if (!document.hidden && dashboard && !dashboard.hidden && !editing) {
      refresh().catch((error) => console.error("تعذر تحديث إشعارات الإدارة تلقائيًا:", error));
    }
  }, 30000);
})();
