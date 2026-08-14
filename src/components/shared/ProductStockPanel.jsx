import { useMemo, useState } from 'react';
import { PackageMinus, PackagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { StockProduct } from '@/api/entities';
import { normalizeStockVariations, stockProductQuantity, stockVariationLabel } from '@/lib/stock-variations';
import { toast } from 'sonner';

const ENTRY_REASONS = {
  supplier: 'Recebimento de fornecedor',
  count: 'Ajuste após contagem',
  return: 'Devolução sem pedido',
  other: 'Outra entrada',
};

const WITHDRAWAL_REASONS = {
  loss: 'Avaria ou perda',
  internal_use: 'Uso interno ou brinde',
  supplier_return: 'Devolução ao fornecedor',
  count: 'Ajuste após contagem',
  other: 'Outra retirada',
};

const MOVEMENT_LABELS = {
  opening_balance: 'Saldo inicial',
  stock_entry: 'Entrada',
  stock_withdrawal: 'Retirada',
  inventory_adjustment: 'Ajuste',
  order_reserved: 'Reservado para pedido',
  order_cancelled: 'Pedido cancelado',
  order_refunded: 'Pedido estornado',
  order_item_cancelled: 'Item cancelado',
  order_returned: 'Devolução recebida',
};

function formatDateTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

export function StockSetupForm({ catalogProduct, onConfigured }) {
  const [variations, setVariations] = useState(() => normalizeStockVariations(catalogProduct.variations));
  const [quantity, setQuantity] = useState('');
  const [showInStore, setShowInStore] = useState(false);
  const [saving, setSaving] = useState(false);
  const hasVariations = variations.length > 0;
  const totalQuantity = useMemo(
    () => hasVariations ? stockProductQuantity({ variations }) : (Number(quantity) || 0),
    [hasVariations, quantity, variations]
  );

  const updateVariation = (index, value) => {
    setVariations(current => current.map((item, itemIndex) => itemIndex === index
      ? { ...item, quantity: value }
      : item));
  };

  const handleSubmit = async event => {
    event.preventDefault();
    setSaving(true);
    try {
      const stockProduct = await StockProduct.create({
        name: catalogProduct.name,
        description: catalogProduct.description || null,
        category: catalogProduct.category || null,
        subcategory: catalogProduct.subcategory || null,
        supplier: catalogProduct.supplier || null,
        supplier_id: catalogProduct.supplier_id || null,
        images: catalogProduct.images || [],
        sale_price: Number(catalogProduct.sale_price || 0),
        regular_price: null,
        cost_price: Number(catalogProduct.cost_price || 0),
        quantity: totalQuantity,
        status: catalogProduct.status || 'active',
        show_in_store: showInStore && totalQuantity > 0,
        notes: catalogProduct.notes || null,
        product_id: catalogProduct.id,
        product_number: catalogProduct.product_number || null,
        revenue_center_id: catalogProduct.revenue_center_id || null,
        variations: hasVariations ? variations : [],
        extras: Array.isArray(catalogProduct.extras) ? catalogProduct.extras : [],
      });
      toast.success('Estoque configurado');
      await onConfigured?.(stockProduct);
    } catch (error) {
      toast.error(error.message || 'Não foi possível configurar o estoque');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Estoque inicial</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {hasVariations ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {variations.map((item, index) => (
                <div key={item.sku || stockVariationLabel(item)}>
                  <Label>{stockVariationLabel(item)}</Label>
                  <Input className="mt-1" type="number" min="0" step="1" inputMode="numeric" value={item.quantity ?? 0} onChange={event => updateVariation(index, event.target.value)} />
                </div>
              ))}
            </div>
          ) : (
            <div>
              <Label>Quantidade</Label>
              <Input className="mt-1" type="number" min="0" step="1" inputMode="numeric" value={quantity} onChange={event => setQuantity(event.target.value)} placeholder="Ex: 20" />
            </div>
          )}

          <label className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
            <span>
              <span className="block text-sm font-semibold text-gray-900">Publicar na loja</span>
              <span className="block text-xs text-muted-foreground">{totalQuantity > 0 ? 'Produto disponível no link público' : 'Informe uma quantidade para publicar'}</span>
            </span>
            <input
              type="checkbox"
              checked={showInStore}
              disabled={totalQuantity <= 0}
              onChange={event => setShowInStore(event.target.checked)}
              className="h-5 w-5 shrink-0 accent-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>

          <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">Total inicial: <span className="font-semibold text-gray-900">{totalQuantity} un.</span></p>
            <Button type="submit" disabled={saving}>
              <PackagePlus className="w-4 h-4" />
              {saving ? 'Salvando...' : showInStore && totalQuantity > 0 ? 'Salvar e publicar' : 'Salvar estoque'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

export function StockOperations({ stockProduct, movements = [], onRefresh }) {
  const [operation, setOperation] = useState('entry');
  const [variation, setVariation] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reasonType, setReasonType] = useState('supplier');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const variations = useMemo(() => normalizeStockVariations(stockProduct.variations), [stockProduct.variations]);
  const requiresVariation = variations.length > 0;
  const selectedVariation = variations.find(item => stockVariationLabel(item) === variation);
  const quantityValue = Number(quantity || 0);
  const stockQuantity = Number(stockProduct.quantity || 0);
  const currentlyPublished = stockProduct.show_in_store === true;
  const canPublish = stockQuantity > 0 && stockProduct.status === 'active';
  const isWithdrawal = operation === 'withdrawal';
  const reasons = isWithdrawal ? WITHDRAWAL_REASONS : ENTRY_REASONS;
  const availableQuantity = selectedVariation
    ? Number(selectedVariation.quantity || 0)
    : stockQuantity;
  const storeLabel = currentlyPublished
    ? (canPublish ? 'No ar na loja' : 'Sem saldo')
    : 'Oculto da loja';

  const handleSubmit = async event => {
    event.preventDefault();
    if (requiresVariation && !variation) return toast.error('Selecione o tamanho');
    if (!Number.isInteger(quantityValue) || quantityValue < 1) {
      return toast.error('Informe uma quantidade inteira maior que zero');
    }
    if (isWithdrawal && quantityValue > availableQuantity) {
      return toast.error(`Saldo disponível: ${availableQuantity} un.`);
    }

    const baseReason = reasons[reasonType];
    const reason = note.trim() ? `${baseReason}: ${note.trim()}` : baseReason;
    setSaving(true);
    try {
      const action = isWithdrawal ? StockProduct.withdraw : StockProduct.entry;
      await action(stockProduct.id, {
        quantity: quantityValue,
        variation: requiresVariation ? variation : null,
        reason,
      });
      setQuantity('');
      setNote('');
      toast.success(isWithdrawal ? 'Retirada registrada no estoque' : 'Quantidade adicionada ao estoque');
      await onRefresh?.();
    } catch (error) {
      toast.error(error.message || `Não foi possível registrar a ${isWithdrawal ? 'retirada' : 'entrada'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleStoreVisibility = async checked => {
    setVisibilitySaving(true);
    try {
      await StockProduct.update(stockProduct.id, { show_in_store: checked });
      toast.success(checked ? 'Produto exibido na loja' : 'Produto ocultado da loja');
      await onRefresh?.();
    } catch (error) {
      toast.error(error.message || 'Não foi possível alterar a visibilidade');
    } finally {
      setVisibilitySaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="border-b pb-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Saldo atual</p>
              <p className="mt-1 text-3xl font-semibold text-gray-900">{stockQuantity} <span className="text-base font-normal text-muted-foreground">unidades</span></p>
            </div>
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
              <input
                type="checkbox"
                checked={currentlyPublished}
                disabled={visibilitySaving || (!canPublish && !currentlyPublished)}
                onChange={event => handleStoreVisibility(event.target.checked)}
                className="h-4 w-4 accent-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
              />
              {storeLabel}
            </label>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 pt-5">
          {requiresVariation && (
            <div>
              <p className="mb-2 text-sm font-semibold text-gray-900">Saldo por tamanho</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {variations.map(item => (
                  <div key={item.sku || stockVariationLabel(item)} className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <span className="text-sm text-muted-foreground">{stockVariationLabel(item)}</span>
                    <span className="font-semibold text-gray-900">{item.quantity || 0}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="border-t pt-5">
            <div className="mb-4 flex items-center gap-2">
              {isWithdrawal ? <PackageMinus className="w-5 h-5 text-red-700" /> : <PackagePlus className="w-5 h-5 text-blue-700" />}
              <h3 className="font-semibold text-gray-900">Movimentar estoque</h3>
            </div>
            <div className="mb-4 inline-flex overflow-hidden rounded-md border">
              <Button
                type="button"
                size="sm"
                variant={isWithdrawal ? 'ghost' : 'default'}
                className="rounded-none"
                onClick={() => {
                  setOperation('entry');
                  setReasonType('supplier');
                }}
              >
                <PackagePlus className="w-3.5 h-3.5" /> Entrada
              </Button>
              <Button
                type="button"
                size="sm"
                variant={isWithdrawal ? 'destructive' : 'ghost'}
                className="rounded-none"
                onClick={() => {
                  setOperation('withdrawal');
                  setReasonType('loss');
                }}
              >
                <PackageMinus className="w-3.5 h-3.5" /> Retirada
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {requiresVariation && (
                <div>
                  <Label>Tamanho</Label>
                  <Select value={variation} onValueChange={setVariation}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Escolha o tamanho" /></SelectTrigger>
                    <SelectContent>
                      {variations.map(item => {
                        const label = stockVariationLabel(item);
                        return <SelectItem key={item.sku || label} value={label}>{label}</SelectItem>;
                      })}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div>
                <Label>Quantidade</Label>
                <Input className="mt-1" type="number" min="1" step="1" inputMode="numeric" value={quantity} onChange={event => setQuantity(event.target.value)} placeholder="Ex: 12" />
                {(selectedVariation || isWithdrawal) && <p className="mt-1 text-xs text-muted-foreground">Saldo disponível: {availableQuantity} un.</p>}
              </div>
              <div>
                <Label>Motivo</Label>
                <Select value={reasonType} onValueChange={setReasonType}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(reasons).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="mt-4">
              <Label>Observação</Label>
              <Textarea className="mt-1" rows={2} value={note} onChange={event => setNote(event.target.value)} placeholder="Nota, lote ou detalhe da conferência" />
            </div>
            <div className="mt-4 flex justify-end">
              <Button type="submit" disabled={saving}>
                {isWithdrawal ? <PackageMinus className="w-4 h-4" /> : <PackagePlus className="w-4 h-4" />}
                {saving ? 'Registrando...' : isWithdrawal ? 'Retirar do estoque' : 'Adicionar ao estoque'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="overflow-x-auto rounded-lg border bg-white">
        <div className="border-b px-4 py-3">
          <h3 className="font-semibold text-gray-900">Últimas movimentações</h3>
        </div>
        {movements.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nenhuma movimentação registrada.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Data</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Tamanho</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Motivo</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Alteração</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Saldo</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {movements.map(movement => (
                <tr key={movement.id}>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{formatDateTime(movement.created_at)}</td>
                  <td className="px-4 py-3">{movement.variation || 'Sem tamanho'}</td>
                  <td className="px-4 py-3"><p className="font-medium">{MOVEMENT_LABELS[movement.movement_type] || 'Movimentação'}</p>{movement.reason && <p className="text-xs text-muted-foreground">{movement.reason}</p>}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${movement.quantity_delta > 0 ? 'text-green-700' : 'text-red-700'}`}>{movement.quantity_delta > 0 ? '+' : ''}{movement.quantity_delta}</td>
                  <td className="px-4 py-3 text-right">{movement.quantity_after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
