import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import OrderDetail from '@/pages/OrderDetail';
import StockOrderDetail from '@/pages/StockOrderDetail';

export default function OrderDetailPanel({
  type = 'presale',
  orderId,
  orderNumber,
  positionLabel,
  onClose,
  onPrevious,
  onNext,
  onChanged,
}) {
  const open = Boolean(orderId);
  const isStock = type === 'stock';
  const Detail = isStock ? StockOrderDetail : OrderDetail;
  const fullPagePath = isStock ? `/estoque/pedidos/${orderId}` : `/pedidos/${orderId}`;

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose?.();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/35"
        onClick={onClose}
        aria-label="Fechar pedido"
      />
      <aside className="absolute right-0 top-0 flex h-[100dvh] w-full max-w-[840px] flex-col bg-gray-50 shadow-2xl">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-white px-3 py-3 sm:px-4">
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Fechar pedido">
            <X className="w-4 h-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground">
              {isStock ? 'Pedido de estoque' : 'Pedido de pré-venda'}{positionLabel ? ` · ${positionLabel}` : ''}
            </p>
            <p className="truncate font-mono text-sm font-semibold text-gray-900">{orderNumber || orderId}</p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            <Button type="button" variant="outline" size="icon" className="h-8 w-8" onClick={onPrevious} disabled={!onPrevious} aria-label="Pedido anterior">
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button type="button" variant="outline" size="icon" className="h-8 w-8" onClick={onNext} disabled={!onNext} aria-label="Próximo pedido">
              <ChevronRight className="w-4 h-4" />
            </Button>
            <Button variant="outline" size="sm" className="h-8 px-2 sm:px-3" asChild>
              <Link to={fullPagePath}>
                <ExternalLink className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Abrir página</span>
              </Link>
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-5">
          <Detail key={orderId} orderId={orderId} embedded onChanged={onChanged} />
        </div>
      </aside>
    </div>
  );
}
