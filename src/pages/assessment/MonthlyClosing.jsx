import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Calendar, ChevronRight, Info } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { PayoutMonthlyClosing, PayoutMonthlyStatementItem } from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, formatCompetence, todayLocalStr } from '@/lib/utils';
import { endedMonths, lastEndedMonth, monthHasEnded, monthOpensOn } from '@/lib/closing-months';
import { functionErrorMessage } from '@/lib/function-error';
import { toast } from 'sonner';
import ContextTabs from '@/components/layout/ContextTabs';

const STATUS = {
  pending_approval: { label: 'Em revisão', cls: 'bg-amber-100 text-amber-700' },
  approved:         { label: 'Aprovado',   cls: 'bg-blue-100 text-blue-700' },
  paid:             { label: 'Pago',       cls: 'bg-green-100 text-green-700' },
};

export default function MonthlyClosing() {
  const navigate = useNavigate();
  const [closings, setClosings] = useState([]);
  const [items, setItems] = useState([]);
  const [modal, setModal] = useState(false);
  // Só mês encerrado: começa no último mês que já terminou.
  const [month, setMonth] = useState(() => lastEndedMonth(todayLocalStr()));
  const [generating, setGenerating] = useState(false);

  const load = async () => {
    try {
      const [c, i] = await Promise.all([
        PayoutMonthlyClosing.list('-competence').catch(() => []),
        PayoutMonthlyStatementItem.list().catch(() => []),
      ]);
      setClosings(c); setItems(i);
    } catch (e) {
      console.error('Erro ao carregar fechamentos:', e);
    }
  };
  useEffect(() => { load(); }, []);

  const openModal = (target = lastEndedMonth(todayLocalStr())) => {
    setMonth(target);
    setModal(true);
  };

  const generate = async () => {
    if (!monthHasEnded(month, todayLocalStr())) {
      return toast.error(`${formatCompetence(`${month}-01`)} ainda não terminou`);
    }
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-monthly-closing', {
        body: { competence: `${month}-01` },
      });
      if (error) throw new Error(await functionErrorMessage(error, 'Erro ao gerar'));
      if (data?.error) throw new Error(data.error);
      toast.success(`Fechamento gerado! ${data.items_count} itens, total ${formatCurrency(data.total_amount)}`);
      setModal(false);
      load();
      navigate(`/assessoria/fechamento/${data.closing_id}`);
    } catch (e) { toast.error(e.message || 'Erro ao gerar'); }
    finally { setGenerating(false); }
  };

  const totalByClosing = (id) => items.filter(i => i.closing_id === id).reduce((s, i) => s + Number(i.amount), 0);

  // O mês a fechar é o último que já terminou; o mês atual só fecha no dia 1º
  // do mês seguinte (a mesma trava existe na função e no banco).
  const today = todayLocalStr();
  const pendingMonth = lastEndedMonth(today);
  const pendingClosing = closings.find(c => c.competence?.startsWith(pendingMonth));
  const pendingLabel = formatCompetence(`${pendingMonth}-01`);
  const currentMonth = today.slice(0, 7);
  const monthOptions = endedMonths(today);
  const selectedClosing = closings.find(c => c.competence?.startsWith(month));

  return (
    <div className="space-y-5">
      <ContextTabs group="payouts" current="/assessoria/fechamento" />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Fechamento Mensal</h2>
          <p className="text-sm text-muted-foreground">Registro oficial de repasse por competência</p>
        </div>
        <Button onClick={() => openModal()}><Plus className="w-4 h-4 mr-2" /> Gerar fechamento</Button>
      </div>

      {/* Explicação do fluxo */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 flex items-start gap-3">
        <Info className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />
        <div className="text-xs text-gray-600 space-y-1">
          <p>
            <strong className="text-gray-800">Como funciona:</strong>{' '}
            A página{' '}
            <Link to="/assessoria/repasse" className="text-blue-600 hover:underline font-medium">Repasse</Link>
            {' '}mostra uma previsão em tempo real do que cada coach vai receber.
            O Fechamento Mensal é o processo oficial: você gera o cálculo para um mês específico, revisa, adiciona ajustes se necessário, aprova e registra o pagamento.
          </p>
          <p className="flex items-center gap-1 flex-wrap">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold text-[11px]">Em revisão</span>
            <span>→ adicione ajustes, confira os valores →</span>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-semibold text-[11px]">Aprovado</span>
            <span>→ valores congelados, efetue o pagamento →</span>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-semibold text-[11px]">Pago</span>
          </p>
        </div>
      </div>

      {/* Mês a fechar: o último que já terminou */}
      {pendingClosing ? (
        <div
          className={`rounded-xl border px-4 py-3 flex items-center justify-between gap-3 cursor-pointer hover:opacity-90 transition-opacity ${
            pendingClosing.status === 'paid'             ? 'bg-green-50 border-green-200' :
            pendingClosing.status === 'approved'         ? 'bg-blue-50 border-blue-200' :
                                                           'bg-amber-50 border-amber-200'
          }`}
          onClick={() => navigate(`/assessoria/fechamento/${pendingClosing.id}`)}
        >
          <div>
            <p className={`text-sm font-semibold ${
              pendingClosing.status === 'paid' ? 'text-green-900' :
              pendingClosing.status === 'approved' ? 'text-blue-900' : 'text-amber-900'
            }`}>
              {pendingLabel}: {STATUS[pendingClosing.status]?.label}
            </p>
            <p className={`text-xs mt-0.5 ${
              pendingClosing.status === 'paid' ? 'text-green-700' :
              pendingClosing.status === 'approved' ? 'text-blue-700' : 'text-amber-700'
            }`}>
              {pendingClosing.status === 'paid'
                ? 'Repasses deste mês já foram efetivados.'
                : pendingClosing.status === 'approved'
                ? 'Fechamento aprovado. Clique para marcar como pago quando efetuar os repasses.'
                : 'Fechamento gerado e aguardando revisão. Clique para conferir e aprovar.'}
            </p>
          </div>
          <ChevronRight className="w-5 h-5 shrink-0 text-gray-400" />
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-gray-700">{pendingLabel}: sem fechamento</p>
            <p className="text-xs text-muted-foreground mt-0.5">O mês já terminou. Gere o fechamento oficial para revisar e aprovar.</p>
          </div>
          <Button size="sm" onClick={() => openModal(pendingMonth)}>
            <Plus className="w-3.5 h-3.5 mr-1" /> Gerar {pendingLabel}
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground -mt-2 px-1">
        {formatCompetence(`${currentMonth}-01`)} está em andamento: acompanhe a previsão em{' '}
        <Link to="/assessoria/repasse" className="text-blue-600 hover:underline">Repasse</Link>.
        {' '}O fechamento dele fica disponível a partir de {formatDate(monthOpensOn(currentMonth))}.
      </p>

      {closings.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center py-16 text-center">
          <Calendar className="w-10 h-10 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">Nenhum fechamento gerado ainda</p>
          <Button className="mt-4" onClick={() => openModal()}>Gerar primeiro fechamento</Button>
        </CardContent></Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Competência</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Gerado em</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Total</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {closings.map(c => {
                const st = STATUS[c.status] || { label: c.status, cls: '' };
                return (
                  <tr key={c.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/assessoria/fechamento/${c.id}`)}>
                    <td className="px-4 py-3 font-bold">{formatCompetence(c.competence)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(c.generated_at?.split('T')[0])}</td>
                    <td className="px-4 py-3 text-right font-semibold">{formatCurrency(totalByClosing(c.id))}</td>
                    <td className="px-4 py-3 text-center"><span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span></td>
                    <td className="px-4 py-3"><ChevronRight className="w-4 h-4 text-muted-foreground" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={modal} onOpenChange={setModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Gerar fechamento</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Label>Mês do fechamento</Label>
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {monthOptions.map(option => (
                  <SelectItem key={option} value={option}>{formatCompetence(`${option}-01`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Só aparecem meses já encerrados: {formatCompetence(`${currentMonth}-01`)} fica disponível a partir de {formatDate(monthOpensOn(currentMonth))}.
              O sistema busca os contratos pagos do mês, calcula os dias de cada coach e gera os itens.
            </p>
            {selectedClosing && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {formatCompetence(`${month}-01`)} já tem fechamento ({STATUS[selectedClosing.status]?.label}).{' '}
                <Link to={`/assessoria/fechamento/${selectedClosing.id}`} className="font-semibold underline">Abrir</Link>
              </p>
            )}
            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" onClick={() => setModal(false)}>Cancelar</Button>
              <Button className="flex-1" onClick={generate} disabled={generating || Boolean(selectedClosing)}>
                {generating ? 'Gerando...' : `Gerar ${formatCompetence(`${month}-01`)}`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
