import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';

const percent = value => `${Math.round((value || 0) * 100)}%`;

// Composição de HOJE por modalidade (a do plano de cada contrato ativo). Não é
// histórica: contratos encerrados saem daqui.
export default function ModalitiesPanel({ block, onRetry }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Modalidades hoje</CardTitle>
        <p className="text-xs text-muted-foreground">Assessoria · alunos ativos e MRR contratado por modalidade, na data de hoje.</p>
      </CardHeader>
      <CardContent>
        {!block && <div className="h-24 animate-pulse rounded bg-slate-100" role="status" aria-label="Modalidades: carregando" />}
        {block?.status === 'error' && (
          <div role="alert" className="space-y-2">
            <p className="text-sm font-semibold text-amber-900">Não foi possível carregar as modalidades.</p>
            <Button variant="outline" size="sm" onClick={onRetry}>Tentar novamente</Button>
          </div>
        )}
        {block?.status === 'ok' && (block.data.composition.length === 0 ? (
          <p className="text-sm text-slate-600">Nenhum aluno ativo hoje.</p>
        ) : (
          <div className="space-y-2">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Alunos ativos e MRR por modalidade</caption>
                <thead className="text-left text-xs text-slate-600">
                  <tr>
                    <th scope="col" className="py-1.5 pr-3 font-semibold">Modalidade</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">Alunos</th>
                    <th scope="col" className="hidden px-2 py-1.5 text-right font-semibold sm:table-cell">% alunos</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">MRR</th>
                    <th scope="col" className="hidden px-2 py-1.5 text-right font-semibold sm:table-cell">% MRR</th>
                    <th scope="col" className="hidden py-1.5 pl-2 text-right font-semibold sm:table-cell">Ticket</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {block.data.composition.map(item => (
                    <tr key={item.id}>
                      <th scope="row" className="py-2 pr-3 text-left font-medium text-gray-900">{item.name}</th>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {item.people}
                        <span className="block text-[11px] text-slate-500 sm:hidden">{percent(item.peopleShare)}</span>
                      </td>
                      <td className="hidden px-2 py-2 text-right tabular-nums text-slate-600 sm:table-cell">{percent(item.peopleShare)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatCurrency(item.mrr)}
                        <span className="block text-[11px] text-slate-500 sm:hidden">{percent(item.mrrShare)}</span>
                      </td>
                      <td className="hidden px-2 py-2 text-right tabular-nums text-slate-600 sm:table-cell">{percent(item.mrrShare)}</td>
                      <td className="hidden py-2 pl-2 text-right tabular-nums sm:table-cell">{item.ticket == null ? '—' : formatCurrency(item.ticket)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 text-xs font-semibold">
                  <tr>
                    <th scope="row" className="py-2 pr-3 text-left">Total da EON</th>
                    <td className="px-2 py-2 text-right tabular-nums">{block.data.activePeople}</td>
                    <td className="hidden sm:table-cell" />
                    <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(block.data.mrr)}</td>
                    <td colSpan={2} className="hidden sm:table-cell" />
                  </tr>
                </tfoot>
              </table>
            </div>
            {block.data.hasOverlap && (
              <p className="text-xs text-slate-600">
                {block.data.overlapPeople} {block.data.overlapPeople === 1 ? 'pessoa tem' : 'pessoas têm'} contratos ativos em mais de uma modalidade e
                {' '}aparece{block.data.overlapPeople === 1 ? '' : 'm'} em cada uma. Por isso a soma das linhas ({block.data.linkedPeople}) passa do total da EON
                {' '}({block.data.activePeople}), que conta cada pessoa uma vez. O MRR é por contrato e não duplica.
              </p>
            )}
            <p className="text-xs text-slate-500">Ticket (a partir de telas maiores) = MRR da modalidade ÷ pessoas com MRR nela. Composição de hoje, não histórica.</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
