// Service Worker do SOFT+ — estratégia "network-first": sempre tenta
// buscar a versão mais nova primeiro; só usa o que está guardado (cache)
// se não tiver internet. Isso garante que qualquer atualização enviada
// pro GitHub apareça sozinha na próxima vez que o app abrir com conexão,
// sem precisar desinstalar nada.

const CACHE_NAME = 'softplus-cache-v5';
const ARQUIVOS_BASE = [
  './',
  './index.html',
  './app.js?v=2',
  './firebase-config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './logo-horizontal.png',
  './logo-simbolo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARQUIVOS_BASE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nomes) =>
      Promise.all(nomes.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Só cuida de requisições GET do mesmo site — o resto (Firebase, APIs
  // externas, etc.) segue direto pela rede, sem passar pelo cache.
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) {
    return;
  }
  event.respondWith(
    // "no-store" força ignorar o cache HTTP do próprio navegador (não só
    // o nosso cache do service worker) — sem isso, o navegador podia
    // devolver uma cópia antiga do arquivo mesmo quando a gente pede pra
    // buscar de novo na rede, escondendo atualizações por um tempo.
    fetch(event.request, { cache: 'no-store' })
      .then((resposta) => {
        const copia = resposta.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return resposta;
      })
      .catch(() => caches.match(event.request))
  );
});
