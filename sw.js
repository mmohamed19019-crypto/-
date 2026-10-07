"use strict";

const CACHE_NAME = "dawaey-shell-v26";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./features.css",
  "./app.js",
  "./features.js",
  "./data.js",
  "./logo-mark.png",
  "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name.startsWith("dawaey-shell-") && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith("/api/") || pathname.startsWith("/admin")) return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-store" }).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match(request).then((cached) => cached || caches.match("./index.html")
        .then((cachedIndex) => cachedIndex || Promise.reject(new Error("الصفحة غير متاحة دون اتصال.")))))
    );
    return;
  }
  if (pathname === "/data.js") {
    event.respondWith(
      fetch(request, { cache: "no-store" }).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./data.js", copy));
        }
        return response;
      }).catch(() => caches.match("./data.js").then((cached) => cached || Promise.reject(new Error("بيانات الدليل غير متاحة دون اتصال."))))
    );
    return;
  }
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => Promise.reject(new Error("المحتوى غير متاح دون اتصال.")))
    })
  );
});

self.addEventListener("push", (event) => {
  let payload = { title: "دوائي", body: "لديك تنبيه جديد." };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (error) {
    console.warn("تعذر قراءة بيانات إشعار الدفع:", error);
  }
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: "./logo-mark.png",
    badge: "./logo-mark.png",
    data: { url: payload.url || "./" }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => client.url === target);
    return existing ? existing.focus() : self.clients.openWindow(target);
  }));
});
