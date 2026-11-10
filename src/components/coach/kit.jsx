// Peças visuais da área do coach: avatar, selos, barras, cabeçalho de página, estados vazios
// e de erro. Só apresentação: nenhuma regra de negócio mora aqui (ver src/lib/coach-ui.js).
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { avatarTone, initialsOf, modalityTone } from '@/lib/coach-ui';
import { cn } from '@/lib/utils';

const PILL_TONES = {
  danger: 'bg-red-50 text-red-700 ring-red-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  info: 'bg-blue-50 text-blue-700 ring-blue-200',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export function Pill({ tone = 'neutral', className, children, ...props }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset', PILL_TONES[tone] || PILL_TONES.neutral, className)}
      {...props}
    >
      {children}
    </span>
  );
}

export function Avatar({ name, size = 'md', className }) {
  const sizes = { sm: 'h-8 w-8 text-[11px]', md: 'h-10 w-10 text-xs', lg: 'h-12 w-12 text-sm' };
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold', sizes[size] || sizes.md, avatarTone(name), className)}
    >
      {initialsOf(name)}
    </span>
  );
}

export function ModalityChip({ modality, className }) {
  if (!modality) return null;
  const tone = modalityTone(modality);
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ring-1 ring-inset', tone.chip, className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} aria-hidden="true" />
      {modality}
    </span>
  );
}

// Barra de progresso simples. `segments` = [{ value (0-100), className ou color }] em ordem.
export function ProgressBar({ segments, className, label }) {
  return (
    <div
      className={cn('flex h-2 w-full overflow-hidden rounded-full bg-slate-100', className)}
      role="img"
      aria-label={label}
    >
      {segments.map((segment, index) => (
        segment.value > 0 && <div key={index} className={cn('h-full transition-[width] duration-500', segment.className)} style={{ width: `${segment.value}%`, background: segment.color }} />
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, className }) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Panel({ title, description, action, children, className, bodyClassName }) {
  return (
    <section className={cn('rounded-2xl border border-slate-200/80 bg-white shadow-sm', className)} aria-label={typeof title === 'string' ? title : undefined}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={cn('p-4 sm:p-5', (title || action) && 'pt-3 sm:pt-3', bodyClassName)}>{children}</div>
    </section>
  );
}

// Escolha entre poucas opções (visão, período...). Parece um controle de abas pequeno.
export function Segmented({ value, onChange, options, label, className }) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex rounded-xl bg-slate-100 p-1', className)}>
      {options.map(option => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'min-h-9 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
              selected ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900',
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className={cn('ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums', selected ? 'bg-blue-50 text-blue-700' : 'bg-slate-200/70 text-slate-600')}>{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Filtro em forma de pílula (ligado/desligado), com a contagem ao lado.
export function FilterChip({ active, count, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
        active ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
      )}
    >
      {children}
      {count !== undefined && (
        <span className={cn('rounded-full px-1.5 text-[11px] font-semibold tabular-nums', active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600')}>{count}</span>
      )}
    </button>
  );
}

export function EmptyState({ icon: Icon, title, children, className }) {
  return (
    <div className={cn('flex flex-col items-center rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center', className)}>
      {Icon && (
        <span className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <Icon className="h-6 w-6" aria-hidden="true" />
        </span>
      )}
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {children && <p className="mt-1 max-w-sm text-sm text-slate-500">{children}</p>}
    </div>
  );
}

// Erro com "Tentar novamente". Nunca mostra número no lugar do que não carregou.
export function ErrorCard({ title, message, onRetry, className }) {
  return (
    <div role="alert" className={cn('flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4', className)}>
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
      <div className="min-w-0 space-y-2">
        <p className="text-sm font-semibold text-amber-900">{title}</p>
        {message && <p className="text-sm text-amber-800">{message}</p>}
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="bg-white">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Tentar novamente
          </Button>
        )}
      </div>
    </div>
  );
}

export function Skeleton({ className }) {
  return <div className={cn('animate-pulse rounded-2xl bg-slate-200/70', className)} />;
}

// Número de destaque com uma faixa colorida do lado e, se quiser, um ícone.
export function StatTile({ icon: Icon, label, value, sub, accent, className }) {
  return (
    <div className={cn('relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm', className)}>
      <span className={cn('absolute inset-y-0 left-0 w-1', accent.bar)} aria-hidden="true" />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        {Icon && <Icon className={cn('h-4 w-4', accent.icon)} aria-hidden="true" />}
      </div>
      <p className="mt-1 text-3xl font-bold tabular-nums tracking-tight text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}
