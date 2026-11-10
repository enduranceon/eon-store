import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

// Carregando, erro com "Tentar novamente" ou o conteúdo. Erro nunca vira zero na tela.
export default function PanelState({ panel, children }) {
  const { data, loading, error, refresh } = panel;
  if (loading && !data) {
    return (
      <div className="space-y-3" role="status" aria-label="Carregando">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map(item => <div key={item} className="h-24 animate-pulse rounded-xl bg-slate-200" />)}
        </div>
        <div className="h-56 animate-pulse rounded-xl bg-slate-200" />
      </div>
    );
  }
  if (!data) {
    return (
      <Card className="border-amber-200"><CardContent className="space-y-2 p-4" role="alert">
        <p className="text-sm font-semibold text-amber-900">Não foi possível carregar seus dados.</p>
        <p className="text-xs text-amber-800">{error?.message || 'Tente novamente em instantes.'} Nenhum número é mostrado até a consulta funcionar.</p>
        <Button variant="outline" size="sm" onClick={() => refresh({ force: true }).catch(() => {})}>Tentar novamente</Button>
      </CardContent></Card>
    );
  }
  return children(data);
}
