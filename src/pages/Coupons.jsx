import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Pencil, Trash2, Ticket, Power, PowerOff, Copy } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Coupon } from '@/api/entities';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { toast } from 'sonner';

function isExpired(c) {
  if (!c.valid_until) return false;
  return c.valid_until < todayLocalStr();
}

function isNotYetValid(c) {
  if (!c.valid_from) return false;
  return c.valid_from > todayLocalStr();
}

function couponStatus(c) {
  if (!c.active)              return { label: 'Desativado', cls: 'bg-gray-100 text-gray-600' };
  if (isExpired(c))           return { label: 'Expirado',   cls: 'bg-red-100 text-red-700' };
  if (isNotYetValid(c))       return { label: 'Agendado',   cls: 'bg-blue-100 text-blue-700' };
  if (c.usage_limit_total && c.uses_count >= c.usage_limit_total)
                              return { label: 'Esgotado',   cls: 'bg-amber-100 text-amber-700' };
  return                              { label: 'Ativo',     cls: 'bg-green-100 text-green-700' };
}

export default function Coupons() {
  const [coupons, setCoupons] = useState([]);
  const [search, setSearch]   = useState('');
  const navigate              = useNavigate();

  const load = () => Coupon.list().then(setCoupons).catch(() => toast.error('Erro ao carregar cupons'));
  useEffect(() => { load(); }, []);

  const handleDelete = async (c) => {
    if (!confirm(`Excluir o cupom "${c.code}"? Esta ação não pode ser desfeita.`)) return;
    try {
      await Coupon.delete(c.id);
      toast.success('Cupom excluído');
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao excluir');
    }
  };

  const toggleActive = async (c) => {
    try {
      await Coupon.update(c.id, { active: !c.active });
      toast.success(c.active ? 'Cupom desativado' : 'Cupom ativado');
      load();
    } catch (e) {
      toast.error(e.message || 'Erro ao atualizar');
    }
  };

  const copyCode = (code) => {
    navigator.clipboard.writeText(code);
    toast.success(`"${code}" copiado!`);
  };

  const filtered = coupons.filter(c => {
    const q = search.toLowerCase();
    return !q || c.code?.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Cupons de desconto</h2>
          <p className="text-sm text-muted-foreground">{filtered.length} cupom{filtered.length !== 1 ? 's' : ''}</p>
        </div>
        <Button onClick={() => navigate('/cupons/novo')}>
          <Plus className="w-4 h-4 mr-2" /> Novo cupom
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Buscar por código ou descrição..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Ticket className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Nenhum cupom criado ainda</p>
            <Button className="mt-4" onClick={() => navigate('/cupons/novo')}>
              <Plus className="w-4 h-4 mr-2" /> Criar primeiro cupom
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left  px-4 py-3 font-medium text-muted-foreground">Código</th>
                <th className="text-left  px-4 py-3 font-medium text-muted-foreground">Descrição</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Desconto</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Validade</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Usos</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(c => {
                const st = couponStatus(c);
                const discount = c.discount_type === 'percentage'
                  ? `${c.discount_value}%${c.max_discount ? ` (máx ${formatCurrency(c.max_discount)})` : ''}`
                  : formatCurrency(c.discount_value);
                const validity = c.valid_until
                  ? `até ${formatDate(c.valid_until)}`
                  : c.valid_from
                    ? `a partir ${formatDate(c.valid_from)}`
                    : 'sem prazo';
                const uses = c.usage_limit_total
                  ? `${c.uses_count}/${c.usage_limit_total}`
                  : `${c.uses_count}`;
                return (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <button onClick={() => copyCode(c.code)} className="font-mono font-bold text-blue-700 hover:underline inline-flex items-center gap-1.5 group">
                        {c.code}
                        <Copy className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </button>
                      {c.min_purchase > 0 && (
                        <p className="text-[10px] text-muted-foreground">mín. {formatCurrency(c.min_purchase)}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{c.description || '—'}</td>
                    <td className="px-4 py-3 text-right font-semibold">{discount}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground text-xs">{validity}</td>
                    <td className="px-4 py-3 text-center text-xs font-medium">{uses}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => toggleActive(c)} title={c.active ? 'Desativar' : 'Ativar'} className="p-1.5 hover:bg-gray-100 rounded text-gray-500 hover:text-gray-800">
                          {c.active ? <Power className="w-3.5 h-3.5" /> : <PowerOff className="w-3.5 h-3.5" />}
                        </button>
                        <button onClick={() => navigate(`/cupons/${c.id}`)} title="Editar" className="p-1.5 hover:bg-gray-100 rounded text-gray-500 hover:text-blue-600">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => handleDelete(c)} title="Excluir" className="p-1.5 hover:bg-red-50 rounded text-gray-500 hover:text-red-600">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
