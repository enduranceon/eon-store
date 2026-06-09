import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadPageCache,
  readPageCache,
  writePageCache,
} from '@/lib/page-cache';

export function usePageData({
  key,
  loader,
  initialData,
  maxAge = 30_000,
  tags = [],
  onError,
}) {
  const [initialEntry] = useState(() => readPageCache(key));
  const loaderRef = useRef(loader);
  const onErrorRef = useRef(onError);
  const tagsRef = useRef(tags);
  const initialDataRef = useRef(initialData);
  const hasCachedData = initialEntry && Object.prototype.hasOwnProperty.call(initialEntry, 'data');
  const [data, setDataState] = useState(() => hasCachedData ? initialEntry.data : initialData);
  const [loading, setLoading] = useState(!hasCachedData);
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(false);

  const refresh = useCallback(async ({ force = false } = {}) => {
    const existing = readPageCache(key);
    const hasExistingData = existing && Object.prototype.hasOwnProperty.call(existing, 'data');
    if (hasExistingData) setRefreshing(true);
    else setLoading(true);

    try {
      const next = await loadPageCache(key, () => loaderRef.current(), {
        force,
        maxAge,
        tags: tagsRef.current,
      });
      if (mountedRef.current) {
        setDataState(next);
      }
      return next;
    } catch (error) {
      onErrorRef.current?.(error);
      throw error;
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [key, maxAge]);

  const setData = useCallback((updater) => {
    const cached = readPageCache(key);
    const current = cached && Object.prototype.hasOwnProperty.call(cached, 'data')
      ? cached.data
      : initialDataRef.current;
    const next = typeof updater === 'function' ? updater(current) : updater;
    writePageCache(key, next, tagsRef.current);
    setDataState(next);
  }, [key]);

  useEffect(() => {
    mountedRef.current = true;
    const timer = setTimeout(() => {
      refresh().catch(() => {});
    }, 0);
    return () => {
      clearTimeout(timer);
      mountedRef.current = false;
    };
  }, [refresh]);

  return { data, setData, loading, refreshing, refresh };
}
