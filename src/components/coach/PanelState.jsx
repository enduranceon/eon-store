import { ErrorCard, Skeleton } from '@/components/coach/kit';

// Carregando, erro com "Tentar novamente" ou o conteúdo. Erro nunca vira zero na tela.
export default function PanelState({ panel, children }) {
  const { data, loading, error, refresh } = panel;
  if (loading && !data) {
    return (
      <div className="space-y-4" role="status" aria-label="Carregando">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-44" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map(item => <Skeleton key={item} className="h-24" />)}
        </div>
        <Skeleton className="h-56" />
      </div>
    );
  }
  if (!data) {
    return (
      <ErrorCard
        title="Não foi possível carregar seus dados."
        message={`${error?.message || 'Tente novamente em instantes.'} Nenhum número é mostrado até a consulta funcionar.`}
        onRetry={() => refresh({ force: true }).catch(() => {})}
      />
    );
  }
  return children(data);
}
