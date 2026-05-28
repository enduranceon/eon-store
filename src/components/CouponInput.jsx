import { useState } from 'react';
import { Tag, X, Check, Loader2 } from 'lucide-react';
import { validateCoupon } from '@/lib/coupon';
import { formatCurrency } from '@/lib/utils';
import { toast } from 'sonner';

/**
 * Componente reusável de aplicar cupom no checkout.
 * Props:
 * - subtotal: valor do carrinho (sem desconto)
 * - customerIdentifier: whatsapp normalizado (opcional, pra checar limite por cliente)
 * - applied: { code, discount, ... } | null
 * - onApply(coupon, discount): callback quando aplicar
 * - onRemove(): callback quando remover
 */
export default function CouponInput({ subtotal, customerIdentifier, applied, onApply, onRemove }) {
  const [open, setOpen]             = useState(false);
  const [code, setCode]             = useState('');
  const [validating, setValidating] = useState(false);

  const handleApply = async () => {
    if (!code.trim()) return toast.error('Digite o código do cupom');
    setValidating(true);
    const result = await validateCoupon(code, subtotal, customerIdentifier);
    setValidating(false);
    if (!result.ok) return toast.error(result.error);
    onApply(result.coupon, result.discount);
    toast.success(`Cupom aplicado! Desconto de ${formatCurrency(result.discount)}`);
    setCode('');
    setOpen(false);
  };

  // Estado: cupom já aplicado
  if (applied) {
    return (
      <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-xl px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Tag className="w-4 h-4 text-green-600 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-green-800 font-mono truncate">{applied.code}</p>
            <p className="text-xs text-green-700">Desconto: -{formatCurrency(applied.discount)}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-green-700 hover:text-green-900 p-1 shrink-0"
          title="Remover cupom"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  // Estado: fechado (link)
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1.5"
      >
        <Tag className="w-3.5 h-3.5" /> Tem cupom de desconto?
      </button>
    );
  }

  // Estado: aberto (input)
  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={code}
        onChange={e => setCode(e.target.value.toUpperCase())}
        onKeyDown={e => e.key === 'Enter' && handleApply()}
        placeholder="DIGITE O CÓDIGO"
        className="flex-1 h-10 px-3 rounded-xl border border-gray-200 text-sm font-mono uppercase focus:outline-none focus:border-blue-500"
        autoFocus
      />
      <button
        type="button"
        onClick={handleApply}
        disabled={validating || !code.trim()}
        className="h-10 px-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl font-semibold text-sm flex items-center gap-1.5"
      >
        {validating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
        Aplicar
      </button>
      <button
        type="button"
        onClick={() => { setOpen(false); setCode(''); }}
        className="h-10 px-3 text-gray-500 hover:text-gray-800 text-sm"
      >
        Cancelar
      </button>
    </div>
  );
}
