import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Ticket, Percent, DollarSign, Sparkles, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Coupon } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';
import { toast } from 'sonner';

const empty = {
  code: '',
  description: '',
  discount_type: 'percentage',
  discount_value: '',
  min_purchase: '',
  max_discount: '',
  valid_from: '',
  valid_until: '',
  usage_limit_total: '',
  usage_limit_per_customer: 1,
  active: true,
};

function normalizeCode(v) {
  return (v || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 30);
}

export default function CouponForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const isEdit = Boolean(id);

  useEffect(() => {
    if (isEdit) {
      Coupon.get(id).then(c => setForm({
        ...c,
        discount_value: c.discount_value ?? '',
        min_purchase: c.min_purchase ?? '',
        max_discount: c.max_discount ?? '',
        valid_from: c.valid_from ?? '',
        valid_until: c.valid_until ?? '',
        usage_limit_total: c.usage_limit_total ?? '',
        usage_limit_per_customer: c.usage_limit_per_customer ?? 1,
      })).catch(() => toast.error('Cupom não encontrado'));
    }
  }, [id]);

  const set = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const isPct = form.discount_type === 'percentage';
  const previewExample = 200;
  const previewDiscount = isPct
    ? Math.min(
        previewExample * (Number(form.discount_value) || 0) / 100,
        Number(form.max_discount) || Infinity
      )
    : Math.min(Number(form.discount_value) || 0, previewExample);

  const validate = () => {
    const errs = [];
    if (!form.code || form.code.length < 3) errs.push('Código precisa ter pelo menos 3 caracteres');
    if (!form.discount_value || Number(form.discount_value) <= 0) errs.push('Valor do desconto precisa ser maior que zero');
    if (isPct && Number(form.discount_value) > 100) errs.push('Desconto percentual não pode passar de 100%');
    if (form.valid_from && form.valid_until && form.valid_until < form.valid_from) errs.push('Validade final precisa ser após a inicial');
    if (form.min_purchase && Number(form.min_purchase) < 0) errs.push('Valor mínimo não pode ser negativo');
    if (form.max_discount && Number(form.max_discount) < 0) errs.push('Desconto máximo não pode ser negativo');
    return errs;
  };

  const handleSave = async () => {
    const errs = validate();
    if (errs.length) return errs.forEach(e => toast.error(e));

    setSaving(true);
    try {
      const payload = {
        code: form.code.trim().toUpperCase(),
        description: form.description?.trim() || null,
        discount_type: form.discount_type,
        discount_value: Number(form.discount_value),
        min_purchase: form.min_purchase ? Number(form.min_purchase) : 0,
        max_discount: isPct && form.max_discount ? Number(form.max_discount) : null,
        valid_from: form.valid_from || null,
        valid_until: form.valid_until || null,
        usage_limit_total: form.usage_limit_total ? Number(form.usage_limit_total) : null,
        usage_limit_per_customer: form.usage_limit_per_customer ? Number(form.usage_limit_per_customer) : 1,
        active: !!form.active,
      };
      if (isEdit) {
        await Coupon.update(id, payload);
        toast.success('Cupom atualizado!');
      } else {
        await Coupon.create(payload);
        toast.success('Cupom criado!');
      }
      navigate('/cupons');
    } catch (e) {
      if (e.message?.includes('duplicate') || e.code === '23505') {
        toast.error('Já existe um cupom com esse código');
      } else {
        toast.error(e.message || 'Erro ao salvar');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/cupons')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h2 className="text-xl font-bold">{isEdit ? 'Editar cupom' : 'Novo cupom'}</h2>
          <p className="text-sm text-muted-foreground">Configure as regras do desconto</p>
        </div>
      </div>

      {/* Identificação */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><Ticket className="w-4 h-4 text-blue-600" /> Identificação</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Código <span className="text-red-500">*</span></Label>
            <Input
              value={form.code}
              onChange={e => set('code', normalizeCode(e.target.value))}
              placeholder="EX: PRIMEIRA10"
              className="mt-1 font-mono uppercase"
              maxLength={30}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Letras maiúsculas, números e hífen. Sem espaços ou acentos.
            </p>
          </div>
          <div>
            <Label>Descrição interna <span className="text-muted-foreground text-xs font-normal">(opcional, só você vê)</span></Label>
            <Textarea
              value={form.description || ''}
              onChange={e => set('description', e.target.value)}
              placeholder="Ex: Cupom de primeira compra divulgado no Instagram"
              rows={2}
              className="mt-1"
            />
          </div>
        </CardContent>
      </Card>

      {/* Desconto */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><Sparkles className="w-4 h-4 text-amber-600" /> Tipo de desconto</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => set('discount_type', 'percentage')}
              className={`flex flex-col items-center gap-1 py-4 rounded-xl border-2 transition-all ${isPct ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}
            >
              <Percent className="w-5 h-5" />
              <span className="text-sm font-semibold">Porcentagem</span>
              <span className="text-xs text-muted-foreground">Ex: 10% off</span>
            </button>
            <button
              type="button"
              onClick={() => set('discount_type', 'fixed')}
              className={`flex flex-col items-center gap-1 py-4 rounded-xl border-2 transition-all ${!isPct ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}
            >
              <DollarSign className="w-5 h-5" />
              <span className="text-sm font-semibold">Valor fixo</span>
              <span className="text-xs text-muted-foreground">Ex: R$ 50 off</span>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>{isPct ? 'Porcentagem (%) *' : 'Valor (R$) *'}</Label>
              <Input
                type="number"
                step={isPct ? '1' : '0.01'}
                min="0"
                max={isPct ? '100' : undefined}
                value={form.discount_value}
                onChange={e => set('discount_value', e.target.value)}
                placeholder={isPct ? '10' : '50.00'}
                className="mt-1"
              />
            </div>
            {isPct && (
              <div>
                <Label>Desconto máximo (R$) <span className="text-muted-foreground text-xs font-normal">(opcional)</span></Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.max_discount}
                  onChange={e => set('max_discount', e.target.value)}
                  placeholder="Sem limite"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">Limita o desconto em pedidos grandes</p>
              </div>
            )}
          </div>

          {/* Preview */}
          {form.discount_value && Number(form.discount_value) > 0 && (
            <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm">
              <p className="text-green-700">
                <span className="font-semibold">Exemplo:</span> num pedido de {formatCurrency(previewExample)} →
                desconto de <span className="font-bold">{formatCurrency(previewDiscount)}</span> →
                cliente paga <span className="font-bold">{formatCurrency(previewExample - previewDiscount)}</span>
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Restrições */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Regras (opcionais)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Válido a partir de</Label>
              <Input type="date" value={form.valid_from || ''} onChange={e => set('valid_from', e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label>Válido até</Label>
              <Input type="date" value={form.valid_until || ''} onChange={e => set('valid_until', e.target.value)} className="mt-1" />
            </div>
          </div>

          <div>
            <Label>Valor mínimo do pedido (R$)</Label>
            <Input
              type="number" step="0.01" min="0"
              value={form.min_purchase}
              onChange={e => set('min_purchase', e.target.value)}
              placeholder="Sem mínimo"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">Cupom só vale se o pedido for igual ou maior que esse valor</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Limite total de usos</Label>
              <Input
                type="number" min="1"
                value={form.usage_limit_total}
                onChange={e => set('usage_limit_total', e.target.value)}
                placeholder="Ilimitado"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Usos por cliente</Label>
              <Input
                type="number" min="1"
                value={form.usage_limit_per_customer}
                onChange={e => set('usage_limit_per_customer', e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Ativo */}
      <Card>
        <CardContent className="pt-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.active}
              onChange={e => set('active', e.target.checked)}
              className="w-4 h-4 accent-blue-600"
            />
            <div>
              <p className="font-medium text-sm">Cupom ativo</p>
              <p className="text-xs text-muted-foreground">Quando desativado, ninguém consegue usar — sem precisar excluir</p>
            </div>
          </label>
        </CardContent>
      </Card>

      {isEdit && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
          <p className="text-blue-700">
            Alterações afetam apenas pedidos futuros. Pedidos que já usaram esse cupom continuam com o desconto original.
          </p>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate('/cupons')}>Cancelar</Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Salvando...' : isEdit ? 'Salvar alterações' : 'Criar cupom'}
        </Button>
      </div>
    </div>
  );
}
