'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface StatusOption {
  id: string;
  name: string;
  color: string;
}

/** Colored status pill. Pass `options` + `onChange` to make it an inline editor. */
export default function StatusPill({
  status,
  options,
  onChange,
}: {
  status: StatusOption | null;
  options?: StatusOption[];
  onChange?: (statusId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // The menu renders in a portal at fixed coordinates rather than absolutely
  // inside the pill. In the contacts grid the pill sits inside an overflow-auto
  // scroll container, which CLIPPED an absolutely-positioned menu — the reason
  // changing a status from the grid was so awkward. A portal escapes every
  // overflow and stacking context.
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const editable = !!options && !!onChange;
  const color = status?.color ?? '#9CA3AF';
  const MENU_WIDTH = 192; // w-48

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 4;
    const estHeight = Math.min(256, (options?.length ?? 0) * 32 + 8);
    const spaceBelow = window.innerHeight - r.bottom;
    // Flip above only when there is not room below and there is more room above.
    const up = spaceBelow < estHeight + gap && r.top > spaceBelow;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8));
    setPos({ top: up ? r.top - gap : r.bottom + gap, left, up });
  };

  // Position before paint so the menu never flashes at the wrong spot.
  useLayoutEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => place();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    // Capture so a scroll in ANY ancestor container repositions the menu, and
    // outside clicks close it wherever they land.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="inline-block">
      <span
        ref={triggerRef}
        onClick={(e) => {
          if (!editable) return;
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${
          editable ? 'cursor-pointer hover:brightness-95' : ''
        }`}
        style={{ backgroundColor: `${color}22`, color }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
        {status?.name ?? 'No status'}
      </span>

      {open &&
        editable &&
        pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            className="anim-pop-in fixed z-50 max-h-64 w-48 overflow-y-auto rounded-lg border border-gray-200 bg-surface py-1 shadow-lg"
            style={{
              top: pos.top,
              left: pos.left,
              transform: pos.up ? 'translateY(-100%)' : undefined,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {options!.map((option) => (
              <button
                key={option.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  onChange!(option.id);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100"
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: option.color }} />
                {option.name}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
