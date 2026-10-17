import { useEffect, useMemo, useState } from 'react';
import { HandCoins, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AssessmentCoach, PreSaleProduct, Product, StockProduct } from '@/api/entities';
import { supabase } from '@/api/db';
import { updateOrderCoach } from '@/api/client';
import { formatCurrency } from '@/lib/utils';
import {
  commissionAmountText,
  estimateOrderCommission,
  summarizeOrderCommissions,
} from '@/lib/product-commission';

const NO_COACH = 'none';

// Coach do pedido e comissão de produto. O coach vem do contrato ativo de quem
// comprou e pode ser trocado aqui. Pedido pago mostra os lançamentos; antes do
// pagamento, a prévia pelas regras atuais dos produtos.
export default function OrderCoachCommission({ orderType, order, onChanged }) {
  const [coaches, setCoaches] = useState([]);
  const [entries, setEntries] = useState(null);
  const [rules, setRules] = useState({});
  const [choice, setChoice] = useState(order.coach_id || NO_COACH);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const paid = order.payment_status === 'paid';

  useEffect(() => {
    setChoice(order.coach_id || NO_COACH);
  }, [order.coach_id]);

  useEffect(() => {
    let alive = true;
    AssessmentCoach.list('name')
      .then(rows => { if (alive) setCoaches(rows || []); })
      .catch(() => { if (alive) setCoaches([]); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    supabase.from('product_commissions')
      .select('*')
      .eq('order_type', orderType)
      .eq('order_id', order.id)
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (!alive) return;
        setEntries(error ? [] : data || []);
      });
    return () => { alive = false; };
  }, [orderType, order.id, order.updated_date, order.payment_status, order.coach_id]);

  // Regras atuais por produto do item, só para a prévia de pedido não pago.
  useEffect(() => {
    if (paid || order.commission_snapshot) return undefined;
    let alive = true;
    Promise.all([
      Product.list(),
      orderType === 'stock' ? StockProduct.list() : PreSaleProduct.list(),
    ]).then(([products, offers]) => {
      if (!alive) return;
      const byId = Object.fromEntries((products || []).map(product => [product.id, product]));
      const map = { ...byId };
      for (const offer of offers || []) if (offer.product_id && byId[offer.product_id]) map[offer.id] = byId[offer.product_id];
      setRules(map);
    }).catch(() => { if (alive) setRules({}); });
    return () => { alive = false; };
  }, [orderType, paid, order.commission_snapshot]);

  const coachesById = useMemo(() => Object.fromEntries(coaches.map(coach => [coach.id, coach])), [coaches]);
  const summary = useMemo(() => summarizeOrderCommissions(entries || [], coachesById), [entries, coachesById]);
  const estimate = useMemo(() => estimateOrderCommission(order, rules), [order, rules]);
  const coachOptions = coaches.filter(coach => coach.active !== false || coach.id === order.coach_id);
  const currentCoach = order.coach_id ? coachesById[order.coach_id] : null;
  const changed = (choice === NO_COACH ? null : choice) !== (order.coach_id || null);
  const hasEntries = (entries || []).length > 0;

  const save = async () => {
    setSaving(true);
    try {
      await updateOrderCoach(orderType, order.id, choice === NO_COACH ? null : choice);
      toast.success(choice === NO_COACH ? 'Coach removido do pedido' : 'Coach do pedido atualizado');
      setConfirming(false);
      await onChanged?.();
    } catch (error) {
      toast.error(error.message || 'Não consegui trocar o coach');
    } finally {
      setSaving(false);
    }
  };

  const requestSave = () => {
    if (paid || hasEntries) setConfirming(true);
    else void save();
  };

  const nextCoachName = choice === NO_COACH ? 'sem coach' : (coachesById[choice]?.name || 'o novo coach');

  return (
    <Card data-testid="order-coach-commission">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><HandCoins className="w-4 h-4" /> Coach e comissão</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div>
          <Label htmlFor={`order-coach-${order.id}`}>Coach de quem comprou</Label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Select value={choice} onValueChange={setChoice}>
              <SelectTrigger id={`order-coach-${order.id}`} className="w-full sm:w-64">
                <SelectValue placeholder="Sem coach" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_COACH}>Sem coach (fica com a assessoria)</SelectItem>
                {coachOptions.map(coach => (
                  <SelectItem key={coach.id} value={coach.id}>{coach.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {changed && (
              <Button size="sm" onClick={requestSave} disabled={saving}>
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Salvar coach
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Vem do contrato ativo quando o pedido é criado. Troque aqui se o pedido for de outro coach.
          </p>
        </div>

        {hasEntries ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {summary.balances.map(balance => (
                <span key={balance.coachId} className="rounded-lg border bg-gray-50 px-2.5 py-1 text-xs">
                  {balance.coachName}: <strong className={balance.amount < 0 ? 'text-red-600' : ''}>{commissionAmountText(balance.amount)}</strong>
                </span>
              ))}
            </div>
            <ul className="divide-y rounded-lg border">
              {summary.list.map(entry => (
                <li key={entry.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{entry.product_name} · {entry.quantity} un. · {entry.ruleLabel}</p>
                    <p className="text-xs text-muted-foreground">
                      {entry.coachName} · {entry.kind === 'commission' ? 'Comissão' : `Ajuste: ${entry.reason}`} · ref. {entry.competenceLabel} · {entry.statusLabel}
                    </p>
                  </div>
                  <span className={`font-semibold whitespace-nowrap ${entry.amount < 0 ? 'text-red-600' : 'text-green-700'}`}>
                    {commissionAmountText(entry.amount)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : paid ? (
          <p className="text-muted-foreground">
            {order.commission_snapshot
              ? (order.coach_id ? 'Nenhum item deste pedido paga comissão.' : 'Sem coach: a venda fica com a assessoria.')
              : 'Pedido pago antes da comissão de produtos existir: sem comissão.'}
          </p>
        ) : estimate.rows.length > 0 ? (
          <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2">
            <p>
              Quando o pedido for pago, {currentCoach ? <strong>{currentCoach.name}</strong> : 'o coach'} recebe
              {' '}<strong>{formatCurrency(estimate.total)}</strong>
              {!currentCoach && ' (pedido sem coach: hoje fica com a assessoria)'}.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {estimate.rows.map(row => `${row.product_name}: ${formatCurrency(row.amount)}`).join(' · ')}
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground">Nenhum item deste pedido paga comissão.</p>
        )}
      </CardContent>

      <Dialog open={confirming} onOpenChange={open => { if (!saving) setConfirming(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Trocar o coach do pedido?</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-700">
            O pedido já foi pago. A comissão lançada para {currentCoach?.name || 'o coach atual'} sai como ajuste
            {choice === NO_COACH ? ' e a venda fica com a assessoria.' : <> e entra para <strong>{nextCoachName}</strong>.</>}
            {' '}As mudanças entram no próximo fechamento do repasse.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={saving}>Voltar</Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Trocar coach
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
