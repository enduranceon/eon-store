import { AlertTriangle, TrendingUp, Users, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn, formatCurrency } from '@/lib/utils';
import { CASH_MONTH_STATE } from '@/lib/overview-cash';

function monthName(ym) {
  const name = new Date(`${ym}-01T12:00:00`).toLocaleString('pt-BR', { month: 'long' });
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function dayMonth(iso) {
  const [, month, day] = String(iso).split('-');
  return `${day}/${month}`;
}

function CardShell({ label, icon: Icon, tone, block, onOpen, onRetry, children }) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700 border-blue-100',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    red: 'bg-rose-50 text-rose-700 border-rose-100',
    violet: 'bg-violet-50 text-violet-700 border-violet-100',
  };
  const icon = (
    <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border', tones[tone])}>
      <Icon className="h-4 w-4" aria-hidden="true" />
    </div>
  );
  if (!block) {
    return (
      <Card><CardContent className="p-4" role="status" aria-label={`${label}: carregando`}>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <div className="mt-2 h-8 w-24 animate-pulse rounded bg-slate-200" />
        <div className="mt-2 h-3 w-32 animate-pulse rounded bg-slate-100" />
      </CardContent></Card>
    );
  }
  if (block.status === 'error') {
    return (
      <Card className="border-amber-200"><CardContent className="space-y-2 p-4" role="alert">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="text-sm font-semibold text-amber-900">Não foi possível carregar</p>
        <p className="text-[11px] text-muted-foreground">O valor fica oculto até a consulta funcionar. Nenhum zero é exibido no lugar.</p>
        <Button variant="outline" size="sm" onClick={onRetry}>Tentar novamente</Button>
      </CardContent></Card>
    );
  }
  return (
    <Card className="h-full transition-shadow hover:shadow-sm">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${label}: ver a composição`}
        className="block h-full w-full rounded-xl p-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">{children}</div>
          {icon}
        </div>
      </button>
    </Card>
  );
}

function Value({ label, value, sub, hint }) {
  return (
    <>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-2xl font-bold text-gray-900">{value}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{sub}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
    </>
  );
}

// Quatro posições do dia/mês. O ano e o mês escolhidos no painel não mudam estes números.
export default function OverviewCards({ blocks, onOpen, onRetry }) {
  const students = blocks?.students;
  const openSales = blocks?.openSales;
  const cash = blocks?.cash;

  const currentMonth = cash?.status === 'ok'
    ? cash.data.cash.months.find(month => month.state === CASH_MONTH_STATE.PARTIAL)
      || cash.data.cash.months[new Date(`${blocks.today}T12:00:00`).getMonth()]
    : null;

  return (
    <section aria-label="Indicadores principais" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <CardShell label="Alunos ativos" icon={Users} tone="blue" block={students} onOpen={() => onOpen('students')} onRetry={onRetry}>
        {students?.status === 'ok' && (
          <Value
            label="Alunos ativos"
            value={students.data.activePeople.toLocaleString('pt-BR')}
            sub="Assessoria · pessoas únicas hoje"
          />
        )}
      </CardShell>
      <CardShell label="MRR contratado" icon={TrendingUp} tone="violet" block={students} onOpen={() => onOpen('mrr')} onRetry={onRetry}>
        {students?.status === 'ok' && (
          <Value
            label="MRR contratado"
            value={formatCurrency(students.data.mrr)}
            sub="Assessoria · equivalente mensal"
            hint="Valor contratado, não dinheiro recebido"
          />
        )}
      </CardShell>
      <CardShell label="Recebido líquido no mês" icon={Wallet} tone="green" block={cash} onOpen={() => onOpen('received')} onRetry={onRetry}>
        {currentMonth && (
          <Value
            label="Recebido líquido no mês"
            value={formatCurrency(currentMonth.received ?? 0)}
            sub={`${monthName(currentMonth.ym)} · todas as áreas`}
            hint={currentMonth.state === CASH_MONTH_STATE.PARTIAL ? `Parcial até ${dayMonth(blocks.today)}` : undefined}
          />
        )}
      </CardShell>
      <CardShell label="Vencido em aberto" icon={AlertTriangle} tone="red" block={openSales} onOpen={() => onOpen('overdue')} onRetry={onRetry}>
        {openSales?.status === 'ok' && (
          <Value
            label="Vencido em aberto"
            value={formatCurrency(openSales.data.overdue.total)}
            sub={`${openSales.data.overdue.count} ${openSales.data.overdue.count === 1 ? 'cobrança' : 'cobranças'} · ${openSales.data.overdue.people} ${openSales.data.overdue.people === 1 ? 'pessoa' : 'pessoas'}`}
            hint="Vencimento antes de hoje"
          />
        )}
      </CardShell>
    </section>
  );
}
