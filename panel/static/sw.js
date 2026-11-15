/* Service worker mínimo: lo que hace "instalable" el panel en el móvil.
   No guarda nada en caché a propósito: el panel muestra datos en vivo y
   una versión antigua sería engañosa. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* todo va directo a la red */ });
