import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Store, ChevronRight, Calendar, Clock } from 'lucide-react';
import { PreSaleCampaign } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';

export default function PublicHome() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    PreSaleCampaign.list().then(all => {
      const active = all.filter(c => {
        if (c.status !== 'active') return false;
        if (c.end_date && new Date() > new Date(c.end_date + 'T23:59:59-03:00')) return false;
        return true;
      });
      setCampaigns(active);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const goToStore = (c) => navigate(`/checkout/${c.slug || c.id}`);

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <header className="bg-[#1a1a2e] text-white py-5 px-4 shadow-md">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="w-9 h-9 bg-blue-500 rounded-xl flex items-center justify-center shrink-0">
            <Store className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="text-xs text-blue-300 font-semibold tracking-widest uppercase">EON Store</p>
            <p className="text-sm font-bold leading-none">Pré-vendas</p>
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-10">
        {loading ? (
          <div className="flex justify-center py-24">
            <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : campaigns.length === 0 ? (
          <div className="text-center py-24">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Store className="w-8 h-8 text-gray-400" />
            </div>
            <h2 className="text-xl font-bold text-gray-700">Nenhuma pré-venda ativa</h2>
            <p className="text-gray-400 mt-2 text-sm">Fique atento às próximas campanhas!</p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
              {campaigns.length === 1 ? '1 pré-venda aberta' : `${campaigns.length} pré-vendas abertas`}
            </p>
            {campaigns.map(c => {
              const end = c.end_date ? new Date(c.end_date) : null;
              const daysLeft = end ? Math.max(0, Math.ceil((end - new Date()) / 86400000)) : null;
              const deliveryEnd = end && c.delivery_days
                ? new Date(end.getTime() + c.delivery_days * 86400000) : null;

              return (
                <button
                  key={c.id}
                  onClick={() => goToStore(c)}
                  className="w-full bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md active:scale-[0.99] transition-all text-left p-5 flex items-center gap-4"
                >
                  <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center shrink-0">
                    <Store className="w-6 h-6 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-gray-900 text-base">{c.name}</h3>
                    {c.supplier && <p className="text-sm text-gray-500 mt-0.5">{c.supplier}</p>}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                      {end && (
                        <span className="flex items-center gap-1 text-xs text-amber-700 font-medium">
                          <Clock className="w-3 h-3" />
                          {daysLeft === 0 ? 'Encerra hoje!' : `${daysLeft} dia${daysLeft === 1 ? '' : 's'} restante${daysLeft === 1 ? '' : 's'}`}
                        </span>
                      )}
                      {deliveryEnd && (
                        <span className="flex items-center gap-1 text-xs text-gray-500">
                          <Calendar className="w-3 h-3" />
                          Entrega a partir de {deliveryEnd.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-gray-400 shrink-0" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
