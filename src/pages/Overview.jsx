import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { usePageData } from '@/hooks/usePageData';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { studentProfilePath } from '@/lib/customer-profile';
import { financialMovementDate } from '@/lib/financial-dashboard';
import { loadOverviewBlocks } from '@/components/overview/overview-loader';
import OverviewCards from '@/components/overview/OverviewCards';
import AttentionStrip from '@/components/overview/AttentionStrip';
import CashPanel from '@/components/overview/CashPanel';
import ModalitiesPanel from '@/components/overview/ModalitiesPanel';
import OverviewDetailDialog from '@/components/overview/OverviewDetailDialog';
import { selectMonthMovements } from '@/lib/overview-cash';

const ORDER_PATH = {
  contract: order => `/assessoria/contratos/${order.id}`,
  stock: order => `/estoque/pedidos/${order.id}`,
  event: order => `/eventos/${order.event_id}`,
  presale: order => `/pedidos/${order.id}`,
};

const ORIGIN_LABEL = { contract: 'Assessoria', stock: 'Loja', event: 'Eventos', presale: 'Pré-venda' };

function orderPath(order) {
  const build = ORDER_PATH[order.type];
  return build ? build(order) : '/financeiro';
}

function ContractLink({ id, number }) {
  return <Link className="font-mono text-blue-700 hover:underline" to={`/assessoria/contratos/${id}`}>{number || '—'}</Link>;
}

function StudentLink({ id, name }) {
  return id
    ? <Link className="text-blue-700 hover:underline" to={studentProfilePath(id)}>{name}</Link>
    : <span>{name}</span>;
}

function detailFor(key, blocks) {
  if (!blocks) return null;
  if (key === 'students' && blocks.students?.status === 'ok') {
    const data = blocks.students.data;
    return {
      title: 'Alunos ativos',
      description: 'Pessoas únicas com ao menos um contrato de assessoria ativo hoje (licença conta como ativo; rascunho, agendado e cancelado não).',
      summary: `${data.activePeople} pessoas · ${data.activeContracts} contratos ativos`,
      rows: data.peopleList,
      columns: [
        { key: 'name', label: 'Aluno', render: row => <StudentLink id={row.customerId} name={row.name} /> },
        { key: 'modalities', label: 'Modalidades', render: row => row.modalities.join(', ') },
        { key: 'contracts', label: 'Contratos', render: row => row.contracts.map(contract => (
          <span key={contract.id} className="mr-2 inline-block"><ContractLink id={contract.id} number={contract.number} /></span>
        )) },
      ],
      destination: { to: '/pessoas', label: 'Abrir Pessoas' },
    };
  }
  if (key === 'mrr' && blocks.students?.status === 'ok') {
    const data = blocks.students.data;
    return {
      title: 'MRR contratado',
      description: 'Soma do valor mensal equivalente dos contratos que contam no MRR. É valor contratado, não dinheiro recebido.',
      summary: `${formatCurrency(data.mrr)} · ${data.mrrContracts} contratos`,
      rows: data.mrrList,
      columns: [
        { key: 'name', label: 'Aluno', render: row => <StudentLink id={row.customerId} name={row.name} /> },
        { key: 'number', label: 'Contrato', render: row => <ContractLink id={row.id} number={row.number} /> },
        { key: 'modality', label: 'Modalidade' },
        { key: 'monthly', label: 'Mensal', align: 'right', render: row => formatCurrency(row.monthly) },
      ],
      destination: { to: '/assessoria/indicadores', label: 'Abrir Indicadores' },
    };
  }
  if (key === 'received' && blocks.cash?.status === 'ok') {
    const ym = blocks.today.slice(0, 7);
    const rows = selectMonthMovements(blocks.cash.data.movements, ym).filter(item => item.movement_kind === 'receipt');
    const total = blocks.cash.data.cash.months.find(month => month.ym === ym)?.received ?? 0;
    return {
      title: 'Recebido líquido no mês',
      description: `Recebimentos realizados de todas as áreas até ${formatDate(blocks.today)}, já com a taxa abatida. Não inclui o que ainda vai entrar.`,
      summary: `${formatCurrency(total)} · ${rows.length} recebimentos`,
      rows,
      columns: [
        { key: 'date', label: 'Data', render: row => formatDate(financialMovementDate(row)) },
        { key: 'description', label: 'Descrição', render: row => row.description || '—' },
        { key: 'amount', label: 'Líquido', align: 'right', render: row => formatCurrency(Number(row.net_amount) || 0) },
      ],
      destination: { to: '/financeiro/fluxo-caixa', label: 'Abrir fluxo de caixa' },
    };
  }
  if (key === 'overdue' && blocks.openSales?.status === 'ok') {
    const data = blocks.openSales.data;
    const rows = data.overdue.items.map(order => ({ ...order, key: order.list_key || `${order.type}:${order.id}` }));
    const extra = [];
    if (data.dueToday.count) extra.push(`${data.dueToday.count} vencem hoje (${formatCurrency(data.dueToday.total)}) e ainda não contam como vencidas`);
    if (data.noDueDate.count) extra.push(`${data.noDueDate.count} sem data de vencimento (${formatCurrency(data.noDueDate.total)}) ficam fora deste número`);
    return {
      title: 'Vencido em aberto',
      description: ['Saldo aberto com vencimento antes de hoje, na mesma lista de Cobranças.', ...extra].join(' · '),
      summary: `${formatCurrency(data.overdue.total)} · ${data.overdue.count} cobranças · ${data.overdue.people} pessoas`,
      rows,
      columns: [
        { key: 'order_number', label: 'Cobrança', render: row => <Link className="font-mono text-blue-700 hover:underline" to={orderPath(row)}>{row.order_number}</Link> },
        { key: 'customer', label: 'Pessoa', render: row => row.customer || '—' },
        { key: 'origin', label: 'Origem', render: row => ORIGIN_LABEL[row.type] || '—' },
        { key: 'due_date', label: 'Venceu em', render: row => formatDate(row.due_date) },
        { key: 'total_value', label: 'Em aberto', align: 'right', render: row => formatCurrency(row.total_value) },
      ],
      destination: { to: '/financeiro', label: 'Abrir Cobranças' },
    };
  }
  return null;
}

export default function Overview() {
  const { data: blocks, loading, refreshing, refresh, error } = usePageData({
    key: 'overview:blocks',
    loader: loadOverviewBlocks,
    maxAge: 60_000,
  });
  const [openKey, setOpenKey] = useState(null);

  const retry = () => refresh({ force: true }).catch(() => {});
  const detail = openKey ? detailFor(openKey, blocks) : null;

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Visão geral</h1>
          <p className="text-sm text-muted-foreground">
            Como está a EON hoje?{blocks?.today ? ` · ${formatDate(blocks.today)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {blocks?.generatedAt && (
            <span className="text-xs text-muted-foreground">
              Atualizado às {new Date(blocks.generatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={retry} disabled={loading || refreshing}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading || refreshing ? 'animate-spin' : ''}`} aria-hidden="true" /> Atualizar
          </Button>
        </div>
      </header>

      {!blocks && error && (
        <Card className="border-amber-200"><CardContent className="space-y-2 p-4" role="alert">
          <p className="text-sm font-semibold text-amber-900">Não foi possível carregar a Visão geral.</p>
          <p className="text-xs text-amber-800">Nenhum número é mostrado até a consulta funcionar.</p>
          <Button variant="outline" size="sm" onClick={retry}>Tentar novamente</Button>
        </CardContent></Card>
      )}

      {(blocks || !error) && (
        <>
          <AttentionStrip attention={blocks?.attention} />
          <OverviewCards blocks={blocks} onOpen={setOpenKey} onRetry={retry} />
          <CashPanel block={blocks?.cash} today={blocks?.today || todayLocalStr()} onRetry={retry} />
          <ModalitiesPanel block={blocks?.students} onRetry={retry} />
        </>
      )}

      {detail && (
        <OverviewDetailDialog
          open
          onClose={() => setOpenKey(null)}
          title={detail.title}
          description={detail.description}
          summary={detail.summary}
          rows={detail.rows}
          columns={detail.columns}
          destination={detail.destination}
        />
      )}
    </div>
  );
}
