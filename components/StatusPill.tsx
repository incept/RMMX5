'use client';

import { useEffect, useRef, useState } from 'react';

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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const editable = !!options && !!onChange;
  const color = status?.color ?? '#9CA3AF';

  return (
    <div className="relative inline-block" ref={ref}>
      <span
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

      {open && editable && (
        <div className="absolute z-30 mt-1 max-h-64 w-48 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {options!.map((option) => (
            <button
              key={option.id}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onChange!(option.id);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50"
            >
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: option.color }} />
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
