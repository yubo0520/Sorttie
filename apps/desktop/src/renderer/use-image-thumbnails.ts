import { useEffect, useMemo, useRef, useState } from "react";
import type { FileRecord } from "../shared/contracts";

type Thumbnail = { version: string; url: string | null; attempts: number };
const versionOf = (file: FileRecord) => `${file.modifiedAt}:${file.sizeBytes}`;

// One bounded queue/cache for visible thumbnails, hover and the detail drawer.
export function useImageThumbnails(records: readonly FileRecord[], visibleIds: readonly string[], priorityId: string | null) {
  const [cache, setCache] = useState<Record<string, Thumbnail>>({});
  const running = useRef(new Set<string>());
  const latest = useRef(records);
  latest.current = records;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    setCache((current) => {
      const next = Object.fromEntries(records.flatMap((file) => {
        const item = current[file.id];
        return item?.version === versionOf(file) ? [[file.id, item]] : [];
      }));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [records]);

  useEffect(() => {
    const api = window.sorttie;
    if (!api) return;
    const byId = new Map(records.map((file) => [file.id, file]));
    const candidates = new Set(priorityId ? [priorityId, ...visibleIds] : visibleIds);
    for (const id of candidates) {
      if (running.current.size >= 3) break;
      const file = byId.get(id);
      if (!file || file.previewCapability !== "image" || file.status === "downloading") continue;
      const version = versionOf(file);
      const previous = cache[id]?.version === version ? cache[id] : undefined;
      // A failed visible request may retry once on explicit hover/inspection.
      if (previous && (previous.url || id !== priorityId || previous.attempts >= 2)) continue;
      const key = `${id}:${version}`;
      if (running.current.has(key)) continue;
      running.current.add(key);
      void (async () => {
        let url: string | null = null;
        try { url = await api.getImageThumbnail(id); } catch { /* Keep the type icon; other files continue. */ }
        running.current.delete(key);
        if (!mounted.current) return;
        const currentFile = latest.current.find((item) => item.id === id);
        setCache((current) => {
          if (!currentFile || versionOf(currentFile) !== version) return { ...current };
          return { ...current, [id]: { version, url, attempts: (previous?.attempts ?? 0) + 1 } };
        });
      })();
    }
  }, [records, visibleIds, priorityId, cache]);

  return useMemo(() => Object.fromEntries(records.map((file) => [file.id,
    cache[file.id]?.version === versionOf(file) ? cache[file.id]?.url : undefined,
  ])), [records, cache]);
}
