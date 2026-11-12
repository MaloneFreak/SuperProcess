/** Pan-and-zoom view of the process diagram. Clicking a step selects it. */
import { Maximize, Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './ui';

interface View {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.08;
const MAX_SCALE = 3;

export function DiagramViewer({
  svg,
  width,
  height,
  background,
  onSelect,
}: {
  /** Trusted markup produced by the SVG renderer. */
  svg: string;
  width: number;
  height: number;
  background: string;
  onSelect?: (nodeId: string | null) => void;
}): ReactNode {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean; pointer: number } | null>(null);
  const fitted = useRef('');

  const fit = useCallback((): void => {
    const box = container.current;
    if (!box) return;
    const pad = 16;
    const scale = Math.min((box.clientWidth - pad * 2) / width, (box.clientHeight - pad * 2) / height, 1.25);
    setView({ scale, x: (box.clientWidth - width * scale) / 2, y: (box.clientHeight - height * scale) / 2 });
  }, [width, height]);

  // Opening view: the whole diagram if it stays readable, otherwise its start
  // at a readable size (wide processes are read left to right).
  const open = useCallback((): void => {
    const box = container.current;
    if (!box) return;
    const pad = 16;
    const byWidth = (box.clientWidth - pad * 2) / width;
    const byHeight = (box.clientHeight - pad * 2) / height;
    const whole = Math.min(byWidth, byHeight, 1.25);
    if (whole >= 0.55) {
      fit();
      return;
    }
    const scale = Math.min(byHeight, 0.8);
    setView({ scale, x: pad, y: (box.clientHeight - height * scale) / 2 });
  }, [fit, width, height]);

  // Position the view when a different diagram is shown (not on every re-render of the same one).
  useLayoutEffect(() => {
    const key = `${width}x${height}`;
    if (fitted.current !== key) {
      fitted.current = key;
      open();
    }
  }, [open, width, height]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number): void => {
    setView((current) => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, current.scale * factor));
      const ratio = scale / current.scale;
      return { scale, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
    });
  }, []);

  // Wheel scrolls the diagram; with Ctrl or a pinch gesture it zooms.
  useEffect(() => {
    const box = container.current;
    if (!box) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = box.getBoundingClientRect();
        zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
      } else {
        setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
      }
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const center = (): [number, number] => {
    const box = container.current;
    return box ? [box.clientWidth / 2, box.clientHeight / 2] : [0, 0];
  };

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl border border-line" style={{ background }}>
      <div
        ref={container}
        className="h-full w-full touch-none select-none"
        style={{ cursor: drag.current?.moved ? 'grabbing' : 'grab' }}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, moved: false, pointer: event.pointerId };
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (!state || state.pointer !== event.pointerId) return;
          const dx = event.clientX - state.x;
          const dy = event.clientY - state.y;
          if (!state.moved && Math.hypot(dx, dy) < 4) return;
          if (!state.moved) event.currentTarget.setPointerCapture(event.pointerId);
          state.moved = true;
          state.x = event.clientX;
          state.y = event.clientY;
          setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
        }}
        onPointerUp={(event) => {
          const state = drag.current;
          drag.current = null;
          if (!state || state.moved || !onSelect) return;
          const node = (event.target as Element).closest?.('.sp-node');
          onSelect(node?.getAttribute('data-id') ?? null);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          zoomAt(1.6, event.clientX - rect.left, event.clientY - rect.top);
        }}
      >
        <div
          data-testid="diagram"
          style={{ width, height, transformOrigin: '0 0', transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-xl border border-line bg-panel p-1 shadow-card">
        <IconButton label={t('result.zoomOut')} onClick={() => zoomAt(1 / 1.3, ...center())}>
          <Minus size={16} />
        </IconButton>
        <span className="w-11 text-center text-xs text-muted tabular-nums">{Math.round(view.scale * 100)}%</span>
        <IconButton label={t('result.zoomIn')} onClick={() => zoomAt(1.3, ...center())}>
          <Plus size={16} />
        </IconButton>
        <IconButton label={t('result.fit')} onClick={fit}>
          <Maximize size={16} />
        </IconButton>
      </div>
    </div>
  );
}
