import type { LucideIcon } from 'lucide-react';

interface IconButtonProps {
  icon: LucideIcon;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}

/** Tinted square icon button (optimed CP style). */
export default function IconButton({
  icon: Icon,
  title,
  onClick,
  disabled,
  busy,
  className = 'bg-slate-100 text-slate-600 hover:bg-slate-200',
}: IconButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled || busy}
      className={`min-h-10 min-w-10 rounded-lg p-2 disabled:opacity-50 ${className}`}
    >
      <Icon className={`h-5 w-5 sm:h-4 sm:w-4 ${busy ? 'animate-spin' : ''}`} />
    </button>
  );
}
