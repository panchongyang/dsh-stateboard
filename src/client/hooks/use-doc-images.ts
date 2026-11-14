// The preview owns one document-scoped asset set; no token appears in DOM URLs.
import React from 'react';
import { getDocAsset } from '../api/transport.ts';
import { markdownBlocks } from '../utils/markdown.ts';

export function useDocImages(projectId: string, docId: string, body: string): (src: string) => string | null {
  const [images, setImages] = React.useState<{ key: string; urls: Record<string, string> }>({ key: '', urls: {} });
  const key = JSON.stringify([projectId, docId, body]);
  React.useEffect(() => {
    const controller = new AbortController();
    const urls: Record<string, string> = {};
    const sources = new Set(markdownBlocks(body).filter((block) => block.type === 'image').map((block) => block.src));
    for (const src of sources) {
      // 只接受相对引用；协议、盘符、绝对路径与反斜杠绝不触发请求。
      if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || /^[\/\\]/.test(src) || /[\\\x00-\x1f\x7f]/.test(src)) continue;
      getDocAsset(projectId, docId, src, controller.signal).then((blob) => {
        if (controller.signal.aborted) return;
        urls[src] = URL.createObjectURL(blob);
        setImages({ key, urls: { ...urls } });
      }).catch(() => { /* 图片失败保留原 Markdown，不打断正文，也不弹全局错误。 */ });
    }
    return () => {
      controller.abort();
      for (const url of Object.values(urls)) URL.revokeObjectURL(url);
    };
  }, [key]);
  return (src) => images.key === key ? images.urls[src] || null : null;
}
