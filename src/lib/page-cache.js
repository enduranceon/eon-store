const pageCache = new Map();

function hasData(entry) {
  return entry && Object.prototype.hasOwnProperty.call(entry, 'data');
}

export function readPageCache(key) {
  return pageCache.get(key) || null;
}

export function writePageCache(key, data, tags = []) {
  const previous = pageCache.get(key);
  const entry = {
    data,
    tags: new Set(tags.length ? tags : previous?.tags || []),
    updatedAt: Date.now(),
    promise: null,
  };
  pageCache.set(key, entry);
  return entry;
}

export function isPageCacheFresh(entry, maxAge) {
  return hasData(entry) && Date.now() - entry.updatedAt < maxAge;
}

export async function loadPageCache(key, loader, { maxAge = 30_000, force = false, tags = [] } = {}) {
  const current = pageCache.get(key);
  if (!force && isPageCacheFresh(current, maxAge)) return current.data;
  if (current?.promise) return current.promise;

  const promise = Promise.resolve()
    .then(loader)
    .then(data => {
      writePageCache(key, data, tags);
      return data;
    })
    .catch(error => {
      const latest = pageCache.get(key);
      if (latest) latest.promise = null;
      throw error;
    });

  pageCache.set(key, {
    ...(current || {}),
    tags: new Set(tags.length ? tags : current?.tags || []),
    promise,
  });

  return promise;
}

export function invalidatePageCacheByTag(tag) {
  for (const entry of pageCache.values()) {
    if (entry.tags?.has(tag)) entry.updatedAt = 0;
  }
}

export function clearPageCache() {
  pageCache.clear();
}
