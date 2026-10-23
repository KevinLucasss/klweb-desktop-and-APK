const CACHE_NAME = 'kl-web-pwa-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/core.min.css',
  '/auth-guide.css',
  '/profile-page.css',
  '/master-page.css',
  '/welcome-plans.css',
  '/style.css',
  '/core.min.js',
  '/workspace.min.js',
  '/workspace.min.css',
  '/favicon-48x48.png',
  '/favicon-192x192.png',
  '/favicon.svg',
  '/og-image.png',
  '/apple-touch-icon.png'
];

// Instalação do Service Worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Cache aberto');
        return cache.addAll(urlsToCache);
      })
      .then(() => {
        console.log('[Service Worker] Recursos cacheados com sucesso');
        return self.skipWaiting();
      })
  );
});

// Ativação do Service Worker
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[Service Worker] Deletando cache antigo:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Interceptação de requisições (fetch)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Se estiver no cache, retorna
        if (response) {
          return response;
        }

        // Se não estiver no cache, busca na rede
        return fetch(event.request).then((response) => {
          // Se for um recurso estático (CSS, JS, imagens), cacheia
          if (response.status === 200 && shouldCache(event.request)) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }

          return response;
        });
      })
  );
});

// Função para determinar se deve cachear
function shouldCache(request) {
  // Cacheia apenas recursos estáticos
  return request.method === 'GET' && 
         (request.url.includes('/core.min.css') ||
          request.url.includes('/workspace.min') ||
          request.url.includes('.css') ||
          request.url.includes('.js') ||
          request.url.includes('.png') ||
          request.url.includes('.jpg') ||
          request.url.includes('.svg') ||
          request.url.includes('.ico') ||
          request.url.includes('.woff'));
}

// Background sync para sincronizar dados quando voltar online
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-demands') {
    event.waitUntil(syncDemands());
  }
});

async function syncDemands() {
  try {
    // Aqui você pode implementar lógica para sincronizar demandas
    // pendentes quando o usuário voltar online
    console.log('[Service Worker] Sincronizando demandas...');
  } catch (error) {
    console.error('[Service Worker] Erro ao sincronizar:', error);
  }
}
