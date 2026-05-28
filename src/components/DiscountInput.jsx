import { useEffect, useState } from 'react';
import { Tag, Lock, Pencil, X, Check, Info } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDate } from '@/lib/utils';
import { DiscountLog } from '@/api/entities';
import { toast } from 'sonner';

/**
 * Componente reutilizável para desconto manual em pedidos/contratos.
 *
 * Props:
 *  - subtotal: número (valor base antes do desconto)
 *  - currentDiscount: número atual do desconto (R$)
 *  - currentReason: motivo atual
 *  - lockedReason: se truthy, bloqueia edição (ex: "Cobrança já gerada no Asaas")
 *  - entityType: 'stock_order' | 'presale_order' | 'assessment_contract'
 *  - entityId: uuid (necessário pra registrar no log; se vazio, pula log)
 *  - onSave: async (newValue, reason) => void  — chamado quando salva
 *  - compact: boolean — modo compacto pra usar em formulários de criação
 */
export default function DiscountInput({
  subtotal,
  currentDiscount = 0,
  currentReason   = '',
  lockedReason    = null,
  entityType,
  entityId,
  onSave,
  compact = false,
}) {
  const [editing, setEditing]   = useState(compact);
  const [mode, setMode]         = useState('value'); // 'value' | 'percent'
  const [value, setValue]       = useState(currentDiscount || 0);
  const [reason, setReason]     = useState(currentReason || '');
  const [saving, setSaving]     = useState(false);
  const [history, setHistory]   = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  // Sincroniza com props quando muda
  useEffect(() => { setValue(currentDiscount || 0); setReason(currentReason || ''); }, [currentDiscount, currentReason]);

  // Carrega histórico
  useEffect(() => {
    if (!entityId || !entityType || compact) return;
    DiscountLog.filter({ entity_type: entityType, entity_id: entityId }, '-created_at')
      .then(setHistory).catch(() => {});
  }, [entityId, entityType, compact]);

  const safeSubtotal = Number(subtotal) || 0;
  const numValue = Number(value) || 0;
  const percentEquivalent = safeSubtotal > 0 ? (numValue / safeSubtotal) * 100 : 0;
  const totalAfter = Math.max(0, safeSubtotal - numValue);

  // Conversão entre R$ e %
  const setFromPercent = (pct) => {
    const p = Number(pct) || 0;
    setValue((safeSubtotal * p / 100).toFixed(2));
  };

  const save = async () => {
    if (numValue < 0) return toast.error('Desconto não pode ser negativo');
    if (numValue > safeSubtotal) return toast.error('Desconto maior que o subtotal');
    setSaving(true);
    try {
      await onSave?.(numValue, reason);
      // Log auditoria (não bloqueia salvar se falhar)
      if (entityId && entityType && numValue !== currentDiscount) {
        try {
          await DiscountLog.create({
            entity_type:    entityType,
            entity_id:      entityId,
            previous_value: Number(currentDiscount) || 0,
            new_value:      numValue,
            reason:         reason || null,
          });
          // Atualiza histórico local
          const fresh = await DiscountLog.filter({ entity_type: entityType, entity_id: entityId }, '-created_at');
          setHistory(fresh);
        } catch (e) { console.error('Log error:', e); }
      }
      if (!compact) setEditing(false);
      toast.success('Desconto salvo');
    } catch (e) {
      toast.error(e.message || 'Erro ao salvar');
    } finally { setSaving(false); }
  };

  // ── Modo compacto (formulário de criação) ────────────────────────────────
  // No compact, propaga mudanças em tempo real via onSave (parent controla state)
  if (compact) {
    const setValueProp = (v) => {
      setValue(v);
      onSave?.(Number(v) || 0, reason);
    };
    const setFromPercentProp = (pct) => {
      const novo = (safeSubtotal * (Number(pct) || 0) / 100).toFixed(2);
      setValue(novo);
      onSave?.(Number(novo) || 0, reason);
    };
    const setReasonProp = (r) => {
      setReason(r);
      onSave?.(numValue, r);
    };
    return (
      <div className="space-y-2">
        <div className="flex items-end gap-2">
          {mode === 'value' ? (
            <div className="flex-1">
              <Label>Desconto (R$)</Label>
              <Input type="number" step="0.01" min="0" max={safeSubtotal} className="mt-1"
                value={value || ''} onChange={e => setValueProp(e.target.value)} placeholder="0,00" />
            </div>
          ) : (
            <div className="flex-1">
              <Label>Desconto (%)</Label>
              <Input type="number" step="0.1" min="0" max="100" className="mt-1"
                value={percentEquivalent.toFixed(1)}
                onChange={e => setFromPercentProp(e.target.value)} placeholder="0" />
            </div>
          )}
          <button type="button" onClick={() => setMode(m => m === 'value' ? 'percent' : 'value')}
            className="px-2.5 py-2 mb-[1px] rounded-lg border text-xs hover:bg-gray-50">
            {mode === 'value' ? '→ %' : '→ R$'}
          </button>
        </div>
        {numValue > 0 && safeSubtotal > 0 && (
          <p className="text-xs text-muted-foreground">
            = {formatCurrency(numValue)} ({percentEquivalent.toFixed(1)}%) · novo total: <strong>{formatCurrency(totalAfter)}</strong>
          </p>
        )}
        <div>
          <Label>Motivo (opcional)</Label>
          <Input className="mt-1" value={reason} onChange={e => setReasonProp(e.target.value)}
            placeholder="ex: cliente fidelidade, promoção interna..." />
        </div>
      </div>
    );
  }

  // ── Modo bloqueado (já tem cobrança Asaas) ──────────────────────────────
  if (lockedReason) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-start gap-2.5">
          <Lock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-900 flex items-center gap-1.5">
              <Tag className="w-3.5 h-3.5" /> Desconto manual bloqueado
            </p>
            <p className="text-xs text-amber-800 mt-1">{lockedReason}</p>
            {currentDiscount > 0 && (
              <p className="text-xs text-amber-700 mt-2">
                Desconto atual: <strong>{formatCurrency(currentDiscount)}</strong>
                {currentReason && <> · {currentReason}</>}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Modo display + editor ──────────────────────────────────────────────
  return (
    <div className="rounded-xl border bg-white">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Tag className="w-4 h-4 text-blue-600" />
            <p className="text-sm font-semibold">Desconto manual</p>
          </div>
          {!editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="w-3 h-3 mr-1" /> {currentDiscount > 0 ? 'Editar' : 'Adicionar'}
            </Button>
          )}
        </div>

        {!editing ? (
          // Display
          currentDiscount > 0 ? (
            <div className="mt-3 space-y-1">
              <p className="text-2xl font-bold text-green-700">
                − {formatCurrency(currentDiscount)}
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  ({((currentDiscount / safeSubtotal) * 100).toFixed(1)}%)
                </span>
              </p>
              {currentReason && (
                <p className="text-xs text-muted-foreground italic">{currentReason}</p>
              )}
              <div className="pt-1 mt-2 border-t flex justify-between text-sm">
                <span className="text-muted-foreground">Subtotal:</span>
                <span>{formatCurrency(safeSubtotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Desconto:</span>
                <span className="text-green-700">− {formatCurrency(currentDiscount)}</span>
              </div>
              <div className="flex justify-between text-sm font-bold pt-1 border-t">
                <span>Total:</span>
                <span>{formatCurrency(totalAfter)}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground mt-3">Sem desconto aplicado</p>
          )
        ) : (
          // Editor
          <div className="space-y-3 mt-3">
            <div className="flex items-end gap-2">
              {mode === 'value' ? (
                <div className="flex-1">
                  <Label>Valor (R$)</Label>
                  <Input type="number" step="0.01" min="0" max={safeSubtotal} className="mt-1"
                    value={value || ''} onChange={e => setValue(e.target.value)} placeholder="0,00" autoFocus />
                </div>
              ) : (
                <div className="flex-1">
                  <Label>Percentual (%)</Label>
                  <Input type="number" step="0.1" min="0" max="100" className="mt-1"
                    value={percentEquivalent.toFixed(1)}
                    onChange={e => setFromPercent(e.target.value)} placeholder="0" autoFocus />
                </div>
              )}
              <button type="button" onClick={() => setMode(m => m === 'value' ? 'percent' : 'value')}
                className="px-3 py-2 mb-[1px] rounded-lg border text-xs font-medium hover:bg-gray-50"
                title={`Trocar para ${mode === 'value' ? 'percentual' : 'valor'}`}>
                {mode === 'value' ? '→ %' : '→ R$'}
              </button>
            </div>

            <div>
              <Label>Motivo (opcional)</Label>
              <Input className="mt-1" value={reason} onChange={e => setReason(e.target.value)}
                placeholder="ex: cliente fidelidade, promoção interna..." />
            </div>

            {/* Preview do cálculo */}
            <div className="rounded-lg bg-blue-50/50 border border-blue-100 p-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal:</span>
                <span>{formatCurrency(safeSubtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Desconto:</span>
                <span className="text-green-700">
                  − {formatCurrency(numValue)} ({percentEquivalent.toFixed(1)}%)
                </span>
              </div>
              <div className="flex justify-between font-bold pt-1 border-t border-blue-200">
                <span>Total:</span>
                <span>{formatCurrency(totalAfter)}</span>
              </div>
            </div>

            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => {
                setEditing(false);
                setValue(currentDiscount || 0);
                setReason(currentReason || '');
              }} disabled={saving}>
                <X className="w-3 h-3 mr-1" /> Cancelar
              </Button>
              <Button className="flex-1" onClick={save} disabled={saving}>
                <Check className="w-3 h-3 mr-1" /> {saving ? 'Salvando...' : 'Salvar'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Histórico */}
      {history.length > 0 && !editing && (
        <div className="border-t bg-gray-50 px-4 py-2">
          <button onClick={() => setShowHistory(s => !s)}
            className="text-xs text-blue-600 hover:underline flex items-center gap-1">
            <Info className="w-3 h-3" />
            {showHistory ? 'Ocultar' : `Ver histórico (${history.length})`}
          </button>
          {showHistory && (
            <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
              {history.map(h => (
                <div key={h.id} className="text-xs flex items-start gap-2 py-1 border-b last:border-0">
                  <span className="text-muted-foreground shrink-0">
                    {formatDate(h.created_at?.slice(0, 10))} {h.created_at?.slice(11, 16)}
                  </span>
                  <span>
                    {formatCurrency(h.previous_value || 0)} → <strong>{formatCurrency(h.new_value)}</strong>
                    {h.reason && <span className="text-muted-foreground"> · {h.reason}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
