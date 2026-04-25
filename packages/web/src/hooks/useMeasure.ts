import { useState, useEffect, useRef, type Ref } from 'react';

/**
 * Track the pixel size of a DOM element via ResizeObserver.
 *
 * Returns a ref to attach to the element and the current `{ width, height }`
 * in CSS pixels. Initial size is `{ 0, 0 }` until the first observation
 * fires (one tick after mount).
 *
 * Used by panel viz components that need to branch their layout on actual
 * container size — e.g. `StatViz` switching between wide (text + sparkline
 * side-by-side) and stacked (text on top, sparkline below) based on aspect
 * ratio. Pure CSS container queries can size elements but can't decide
 * which structural layout to render; this hook bridges that gap.
 */
export function useMeasure<T extends HTMLElement = HTMLDivElement>(): [
  Ref<T>,
  { width: number; height: number },
] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size];
}
