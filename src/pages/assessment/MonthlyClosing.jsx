import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Calendar, CheckCircle2, Clock, DollarSign, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PayoutMonthlyClosing, PayoutMonthlyStatementItem } from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { toast } from 'sonner';

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
  const [competence, setCompetence] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  });
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

  const generate = async () => {
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-monthly-closing', {
        body: { competence },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success(`Fechamento gerado! ${data.items_count} itens, total ${formatCurrency(data.total_amount)}`);
      setModal(false);
      load();
      navigate(`/assessoria/fechamento/${data.closing_id}`);
    } catch (e) { toast.error(e.message || 'Erro ao gerar'); }
    finally { setGenerating(false); }
  };

  const formatCompetence = (d) => {
    if (!d) return '';
    const [y, m] = d.split('-');
    return `${m}/${y}`;
  };

  const totalByClosing = (id) => items.filter(i => i.closing_id === id).reduce((s, i) => s + Number(i.amount), 0);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Fechamento Mensal</h2>
          <p className="text-sm text-muted-foreground">Gere e aprove os repasses por competência</p>
        </div>
        <Button onClick={() => setModal(true)}><Plus className="w-4 h-4 mr-2" /> Gerar fechamento</Button>
      </div>

      {closings.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center py-16 text-center">
          <Calendar className="w-10 h-10 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">Nenhum fechamento gerado ainda</p>
          <Button className="mt-4" onClick={() => setModal(true)}>Gerar primeiro fechamento</Button>
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
            <Label>Competência (1º dia do mês)</Label>
            <Input type="date" value={competence} onChange={e => setCompetence(e.target.value)} />
            <p className="text-xs text-muted-foreground">O sistema busca contratos pagos e ativos no mês, calcula pró-rata por dias e gera os itens de cada coach.</p>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" onClick={() => setModal(false)}>Cancelar</Button>
              <Button className="flex-1" onClick={generate} disabled={generating}>{generating ? 'Gerando...' : 'Gerar'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
