import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';

// Até quatro grupos com ação concreta. Cada um leva à tela onde a ação é feita;
// esta faixa não envia mensagem, não registra pagamento nem estorna.
export default function AttentionStrip({ attention }) {
  if (!attention) {
    return (
      <Card><CardContent className="p-4" role="status" aria-label="Atenção: carregando">
        <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
      </CardContent></Card>
    );
  }
  const { groups, unavailable, contactsPreparing } = attention;
  const notes = [];
  if (unavailable.length) notes.push(`Não foi possível consultar: ${unavailable.join(', ')}. Esses itens não aparecem aqui e não significam zero.`);
  if (contactsPreparing) notes.push('A Central de Comunicação ainda está em preparação; os contatos a fazer não entram nesta faixa.');

  return (
    <Card aria-label="Atenção">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-gray-900">Atenção</h2>
        </div>
        {groups.length > 0 ? (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {groups.map(group => (
              <li key={group.id}>
                <Link
                  to={group.to}
                  className="flex h-full items-center justify-between gap-2 rounded-lg border bg-amber-50/60 px-3 py-2 text-sm hover:bg-amber-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                >
                  <span className="min-w-0">
                    <span className="block font-semibold text-gray-900">{group.label}</span>
                    {(group.detail || group.amount != null) && (
                      <span className="block text-xs text-slate-600">
                        {[group.amount != null ? formatCurrency(group.amount) : null, group.detail].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        ) : unavailable.length === 0 && !contactsPreparing ? (
          <p className="flex items-center gap-2 text-sm text-slate-600">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" /> Nada pedindo ação agora.
          </p>
        ) : null}
        {notes.map(note => <p key={note} role="status" className="text-xs text-amber-800">{note}</p>)}
      </CardContent>
    </Card>
  );
}
