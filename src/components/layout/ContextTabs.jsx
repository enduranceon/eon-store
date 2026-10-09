import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

const GROUPS = {
  assessment: [
    { label: 'Panorama atual', to: '/assessoria' },
    { label: 'Evolução', to: '/assessoria/indicadores' },
    { label: 'Entradas e saídas', to: '/assessoria/movimento' },
    { label: 'Previsões', to: '/assessoria/central-financeira' },
  ],
  payouts: [
    { label: 'Previsão', to: '/assessoria/repasse' },
    { label: 'Fechamentos', to: '/assessoria/fechamento' },
  ],
  team: [
    { label: 'Coaches da assessoria', to: '/assessoria/coaches' },
    { label: 'Treinadores da loja', to: '/treinadores' },
  ],
};

export default function ContextTabs({ group, current }) {
  const tabs = GROUPS[group] || [];
  if (!tabs.length) return null;
  return (
    <nav aria-label={group === 'assessment' ? 'Visões da assessoria' : group === 'payouts' ? 'Visões de repasses' : 'Cadastros da equipe'}
      className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1">
      {tabs.map(tab => {
        const selected = tab.to === current;
        return (
          <Link key={tab.to} to={tab.to} aria-current={selected ? 'page' : undefined}
            className={cn('inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 text-sm font-medium transition-colors',
              selected ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')}>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
