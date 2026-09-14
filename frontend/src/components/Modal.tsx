import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/** md = single column forms · lg = two columns · xl = two columns with room ·
 *  2xl = wide tables and stepped wizards. */
export type ModalSize = 'md' | 'lg' | 'xl' | '2xl';

const SIZE_CLASS: Record<ModalSize, string> = {
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  '2xl': 'max-w-6xl',
};

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: ModalSize;
  /** Pinned below the scrolling body — keeps the actions reachable on a tall form. */
  footer?: ReactNode;
}

export default function Modal({ title, onClose, children, size = 'md', footer }: ModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`mt-8 flex max-h-[calc(100dvh-4rem)] w-full flex-col rounded-2xl bg-white shadow-lg ring-1 ring-slate-200 ${SIZE_CLASS[size]}`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="font-bold text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-slate-200 px-5 py-4">{footer}</div>
        )}
      </div>
    </div>
  );
}
