import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, DollarSign, User, Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  PayoutMonthlyClosing, PayoutMonthlyStatementItem, AssessmentCoach,
} from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from 'sonner';

const SOURCE = {
  athlete_repasse:    { label: 'Repasse atleta',    cls: 'bg-blue-100 text-blue-700' },
  direct_leadership:  { label: 'Liderança',         cls: 'bg-purple-100 text-purple-700' },
  co_leadership:      { label: 'Co-liderança',      cls: 'bg-indigo-100 text-indigo-700' },
  manual_adjustment:  { label: 'Ajuste manual',     cls: 'bg-amber-100 text-amber-700' },
};

const STATUS = {
  pending_approval: { label: 'Pendente aprovação', cls: 'bg-amber-100 text-amber-700' },
  approved:         { label: 'Aprovado',           cls: 'bg-blue-100 text-blue-700' },
  paid:             { label: 'Pago',               cls: 'bg-green-100 text-green-700' },
};

export default function ClosingDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [closing, setClosing]   = useState(null);
  const [items, setItems]       = useState([]);
  const [coaches, setCoaches]   = useState([]);
  const [expanded, setExpanded] = useState({}); // coach_id → bool
  const [adjustModal, setAdjustModal] = useState(false);
  const [adjustForm, setAdjustForm] = useState({ coach_id: '', amount: '', description: '' });
  const [approving, setApproving] = useState(false);

  const load = async () => {
    try {
      const [c, i, co] = await Promise.all([
        PayoutMonthlyClosing.get(id),
        PayoutMonthlyStatementItem.filter({ closing_id: id }).catch(() => []),
        AssessmentCoach.list('name').catch(() => []),
      ]);
      setClosing(c); setItems(i); setCoaches(co);
    } catch (e) {
      console.error('Erro ao carregar fechamento:', e);
    }
  };
  useEffect(() => { load(); }, [id]);

  // Agrupa por coach
  const grouped = coaches.map(coach => {
    const list = items.filter(i => i.coach_id === coach.id);
    const subtotal = list.reduce((s, i) => s + Number(i.amount), 0);
    return { coach, items: list, subtotal };
  }).filter(g => g.items.length > 0).sort((a, b) => b.subtotal - a.subtotal);

  const total = items.reduce((s, i) => s + Number(i.amount), 0);

  const approve = async () => {
    if (!confirm('Aprovar fechamento? Coaches passarão a visualizar o extrato.')) return;
    setApproving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      await PayoutMonthlyClosing.update(id, {
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: user?.id || null,
      });
      toast.success('Fechamento aprovado!'); load();
    } catch (e) { toast.error(e.message); }
    finally { setApproving(false); }
  };

  const addAdjust = async () => {
    if (!adjustForm.coach_id || !adjustForm.amount) return toast.error('Coach e valor obrigatórios');
    try {
      await PayoutMonthlyStatementItem.create({
        closing_id: id,
        coach_id: adjustForm.coach_id,
        source_type: 'manual_adjustment',
        description: adjustForm.description || 'Ajuste manual',
        amount: Number(adjustForm.amount),
      });
      toast.success('Ajuste adicionado!');
      setAdjustModal(false);
      setAdjustForm({ coach_id: '', amount: '', description: '' });
      load();
    } catch (e) { toast.error(e.message); }
  };

  if (!closing) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  const st = STATUS[closing.status] || {};
  const competenceLabel = closing.competence ? `${closing.competence.split('-')[1]}/${closing.competence.split('-')[0]}` : '';
  const canEdit = closing.status === 'pending_approval';

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/assessoria/fechamento')}><ArrowLeft className="w-4 h-4" /></Button>
        <div>
          <h2 className="text-xl font-bold">Fechamento {competenceLabel}</h2>
          <p className="text-sm text-muted-foreground">Gerado em {formatDate(closing.generated_at?.split('T')[0])}</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${st.cls}`}>{st.label}</span>
          {canEdit && <Button onClick={approve} disabled={approving} className="bg-green-600 hover:bg-green-700"><CheckCircle2 className="w-4 h-4 mr-1.5" /> {approving ? 'Aprovando...' : 'Aprovar fechamento'}</Button>}
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-4">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Total a pagar</p>
          <p className="text-2xl font-bold text-green-600">{formatCurrency(total)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Coaches</p>
          <p className="text-2xl font-bold">{grouped.length}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Itens no extrato</p>
          <p className="text-2xl font-bold">{items.length}</p>
        </CardContent></Card>
      </div>

      {canEdit && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setAdjustModal(true)}><Plus className="w-3.5 h-3.5 mr-1" /> Ajuste manual</Button>
        </div>
      )}

      {/* Tabela por coach */}
      {grouped.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Nenhum item no fechamento</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {grouped.map(({ coach, items: list, subtotal }) => {
            const isOpen = expanded[coach.id];
            return (
              <Card key={coach.id}>
                <button onClick={() => setExpanded(e => ({ ...e, [coach.id]: !e[coach.id] }))} className="w-full text-left">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        <User className="w-4 h-4 text-blue-600" />
                        <span className="font-bold">{coach.name}</span>
                        <span className="text-xs text-muted-foreground capitalize">({coach.role})</span>
                        <span className="text-xs text-muted-foreground">· {list.length} {list.length === 1 ? 'item' : 'itens'}</span>
                      </div>
                      <span className="text-lg font-bold text-green-600">{formatCurrency(subtotal)}</span>
                    </div>
                  </CardHeader>
                </button>
                {isOpen && (
                  <CardContent className="pt-0">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground border-b">
                          <th className="text-left py-2">Origem</th>
                          <th className="text-left py-2">Descrição</th>
                          <th className="text-right py-2">Dias</th>
                          <th className="text-right py-2">Pró-rata</th>
                          <th className="text-right py-2">Valor</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {list.map(it => {
                          const so = SOURCE[it.source_type] || { label: it.source_type, cls: '' };
                          return (
                            <tr key={it.id}>
                              <td className="py-2"><span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${so.cls}`}>{so.label}</span></td>
                              <td className="py-2">{it.description}</td>
                              <td className="py-2 text-right text-xs text-muted-foreground">{it.valid_days ? `${it.valid_days}/${it.month_days}` : '—'}</td>
                              <td className="py-2 text-right text-xs text-muted-foreground">{it.prorata_factor ? (it.prorata_factor * 100).toFixed(0) + '%' : '—'}</td>
                              <td className="py-2 text-right font-semibold">{formatCurrency(it.amount)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Modal ajuste */}
      <Dialog open={adjustModal} onOpenChange={setAdjustModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Ajuste manual</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Coach</Label>
              <Select value={adjustForm.coach_id} onValueChange={v => setAdjustForm(f => ({ ...f, coach_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  {coaches.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Valor (use negativo pra descontar)</Label><Input type="number" step="0.01" value={adjustForm.amount} onChange={e => setAdjustForm(f => ({ ...f, amount: e.target.value }))} /></div>
            <div><Label>Descrição</Label><Textarea rows={2} value={adjustForm.description} onChange={e => setAdjustForm(f => ({ ...f, description: e.target.value }))} placeholder="Motivo do ajuste..." /></div>
            <div className="flex gap-2"><Button variant="outline" className="flex-1" onClick={() => setAdjustModal(false)}>Cancelar</Button><Button className="flex-1" onClick={addAdjust}>Adicionar</Button></div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
