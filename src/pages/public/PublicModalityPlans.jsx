import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, Loader2, AlertCircle, Clock, BadgeDollarSign, ChevronLeft } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { supabase } from '@/api/db';
import { formatCurrency } from '@/lib/utils';
import { toast } from 'sonner';

function getPlanMonths(plan) {
  return plan?.period_months
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan?.period]
    || 1;
}

function periodLabel(months) {
  const n = Number(months);
  if (n === 1)  return '1 mês';
  if (n === 12) return '12 meses (Anual)';
  return `${n} meses`;
}

export default function PublicModalityPlans() {
  const { modalityId } = useParams();

  const [modality,       setModality]       = useState(null);
  const [plans,          setPlans]          = useState([]);
  const [coaches,        setCoaches]        = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [notFound,       setNotFound]       = useState(false);
  const [selectedPlan,   setSelectedPlan]   = useState(null);
  const [submitting,     setSubmitting]     = useState(false);
  const [done,           setDone]           = useState(false);

  const [form, setForm] = useState({
    full_name: '', gender: '', birth_date: '',
    whatsapp: '', cpf: '', coach_id: '', payment_method: '',
  });

  useEffect(() => {
    (async () => {
      try {
        const [{ data: mod }, { data: planList }, { data: coachList }, { data: pmList }] = await Promise.all([
          supabase.from('assessment_modalities').select('id,name').eq('id', modalityId).eq('active', true).maybeSingle(),
          supabase.from('assessment_plans').select('*').eq('modality_id', modalityId).eq('active', true).order('period_months'),
          supabase.from('assessment_coaches').select('id,name').eq('active', true).order('name'),
          supabase.from('payment_methods').select('id,name,internal_code').eq('active', true).order('name'),
        ]);

        if (!mod) { setNotFound(true); setLoading(false); return; }
        setModality(mod);
        setPlans(planList || []);
        setCoaches(coachList || []);
        setPaymentMethods(pmList || []);
      } catch (e) {
        console.error(e);
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [modalityId]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.full_name.trim()) return toast.error('Nome obrigatório');
    if (!form.whatsapp.trim())  return toast.error('WhatsApp obrigatório');
    if (!form.cpf.trim())       return toast.error('CPF obrigatório');
    if (!form.coach_id)         return toast.error('Selecione um coach');
    if (!form.payment_method)   return toast.error('Selecione a forma de pagamento');

    setSubmitting(true);
    try {
      const cpfClean = form.cpf.replace(/\D/g, '');

      let customer;
      const { data: existing } = await supabase
        .from('presale_customers').select('id').eq('cpf', cpfClean).maybeSingle();

      if (existing) {
        customer = existing;
      } else {
        const { data: created, error: custErr } = await supabase
          .from('presale_customers')
          .insert({
            full_name:  form.full_name.trim(),
            whatsapp:   form.whatsapp.replace(/\D/g, '') || null,
            cpf:        cpfClean || null,
            gender:     form.gender    || null,
            birth_date: form.birth_date || null,
            active:     true,
          })
          .select().single();
        if (custErr) throw custErr;
        customer = created;
      }

      const plan = selectedPlan;
      const { error: contractErr } = await supabase
        .from('assessment_contracts')
        .insert({
          customer_id:   customer.id,
          coach_id:      form.coach_id,
          plan_id:       plan.id,
          plan_snapshot: {
            plan_id:          plan.id,
            name:             plan.name || null,
            modality_id:      plan.modality_id,
            price_total:      Number(plan.price_total)    || 0,
            price_monthly:    Number(plan.price_monthly)  || 0,
            enrollment_fee:   Number(plan.enrollment_fee) || 0,
            max_installments: plan.max_installments,
            period_months:    getPlanMonths(plan),
            snapshot_at:      new Date().toISOString(),
            snapshot_source:  'public_enrollment',
          },
          status:         'draft',
          payment_status: 'pending',
          payment_method: form.payment_method,
          installments:   plan.max_installments || 1,
          enrollment_fee: Number(plan.enrollment_fee) || 0,
          auto_renewal:   false,
          notes:          'Adesão via formulário público',
        });

      if (contractErr) throw contractErr;
      setDone(true);
    } catch (err) {
      toast.error(err.message || 'Erro ao enviar. Tente novamente.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
    </div>
  );

  if (notFound) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="text-center">
        <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-3" />
        <h2 className="text-xl font-bold text-gray-800">Página não encontrada</h2>
        <p className="text-gray-500 mt-2 text-sm">Este link pode ter expirado ou a modalidade foi desativada.</p>
      </div>
    </div>
  );

  if (done) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="text-center max-w-sm">
        <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
          <CheckCircle2 className="w-9 h-9 text-green-600" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900">Tudo certo!</h2>
        <p className="text-gray-600 mt-3">Sua intenção de adesão foi registrada com sucesso.</p>
        <p className="text-gray-500 mt-2 text-sm">
          Em breve você receberá a cobrança para confirmar sua matrícula. Aguarde o contato da nossa equipe.
        </p>
      </div>
    </div>
  );

  // ── Tela 1: escolha de plano ──────────────────────────────────────────────
  if (!selectedPlan) return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-8">
          <p className="text-xs font-bold uppercase tracking-widest text-blue-600 mb-1">Assessoria Esportiva</p>
          <h1 className="text-2xl font-bold text-gray-900 capitalize">{modality.name}</h1>
          <p className="text-gray-500 mt-1 text-sm">Escolha o plano ideal para você</p>
        </div>

        {plans.length === 0 ? (
          <div className="text-center py-16">
            <AlertCircle className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500">Nenhum plano disponível no momento.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {plans.map(plan => {
              const months  = getPlanMonths(plan);
              const name    = plan.name?.trim() || `${modality.name} · ${periodLabel(months)}`;
              return (
                <div key={plan.id}
                  className="bg-white rounded-2xl border-2 border-gray-100 shadow-sm hover:border-blue-300 hover:shadow-md transition-all p-5 flex flex-col"
                >
                  <div className="flex-1">
                    <p className="text-xs font-bold uppercase tracking-wide text-blue-600 mb-1 capitalize">
                      {modality.name}
                    </p>
                    <h2 className="text-base font-bold text-gray-900 leading-tight">{name}</h2>
                    <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> {periodLabel(months)}
                    </p>

                    <div className="mt-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-500">Mensalidade</span>
                        <span className="text-sm font-bold text-blue-700">
                          {formatCurrency(plan.price_monthly)}
                          <span className="font-normal text-gray-400">/mês</span>
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-500">Total</span>
                        <span className="text-sm font-semibold text-gray-800">{formatCurrency(plan.price_total)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-500">Parcelas</span>
                        <span className="text-sm text-gray-700">até {plan.max_installments}x</span>
                      </div>
                      {Number(plan.enrollment_fee) > 0 && (
                        <div className="flex items-center justify-between pt-2 border-t">
                          <span className="text-xs text-amber-700 flex items-center gap-1">
                            <BadgeDollarSign className="w-3.5 h-3.5" /> Matrícula
                          </span>
                          <span className="text-xs font-semibold text-amber-700">{formatCurrency(plan.enrollment_fee)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <Button className="w-full mt-5" onClick={() => setSelectedPlan(plan)}>
                    Escolher este plano
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  // ── Tela 2: formulário de adesão ─────────────────────────────────────────
  const months  = getPlanMonths(selectedPlan);
  const planName = selectedPlan.name?.trim() || `${modality.name} · ${periodLabel(months)}`;

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-md mx-auto space-y-5">

        {/* Resumo do plano escolhido */}
        <div className="bg-white rounded-2xl border border-blue-100 shadow-sm p-5">
          <button
            onClick={() => setSelectedPlan(null)}
            className="flex items-center gap-1 text-xs text-blue-600 hover:underline mb-3"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> Trocar plano
          </button>
          <p className="text-xs font-bold uppercase tracking-wide text-blue-600 mb-0.5 capitalize">
            {modality.name}
          </p>
          <h1 className="text-xl font-bold text-gray-900">{planName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{periodLabel(months)}</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="bg-blue-50 rounded-xl p-3 text-center">
              <p className="text-xs text-blue-600 font-medium mb-0.5">Mensalidade</p>
              <p className="text-lg font-bold text-blue-700">{formatCurrency(selectedPlan.price_monthly)}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <p className="text-xs text-gray-500 font-medium mb-0.5">Total</p>
              <p className="text-lg font-bold text-gray-800">{formatCurrency(selectedPlan.price_total)}</p>
            </div>
          </div>
          {Number(selectedPlan.enrollment_fee) > 0 && (
            <div className="mt-2 bg-amber-50 rounded-xl p-3 flex items-center justify-between">
              <p className="text-xs text-amber-700 font-medium">Matrícula</p>
              <p className="text-sm font-bold text-amber-700">{formatCurrency(selectedPlan.enrollment_fee)}</p>
            </div>
          )}
        </div>

        {/* Formulário */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h2 className="text-base font-semibold text-gray-900 mb-5">Seus dados</h2>
          <form onSubmit={handleSubmit} className="space-y-4">

            <div>
              <Label htmlFor="full_name">Nome completo *</Label>
              <Input id="full_name" value={form.full_name} onChange={e => set('full_name', e.target.value)}
                placeholder="Seu nome completo" className="mt-1" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="gender">Gênero</Label>
                <Select value={form.gender} onValueChange={v => set('gender', v)}>
                  <SelectTrigger id="gender" className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="masculino">Masculino</SelectItem>
                    <SelectItem value="feminino">Feminino</SelectItem>
                    <SelectItem value="outro">Outro</SelectItem>
                    <SelectItem value="nao_informar">Prefiro não informar</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="birth_date">Nascimento</Label>
                <Input id="birth_date" type="date" value={form.birth_date}
                  onChange={e => set('birth_date', e.target.value)} className="mt-1" />
              </div>
            </div>

            <div>
              <Label htmlFor="whatsapp">WhatsApp *</Label>
              <Input id="whatsapp" type="tel" value={form.whatsapp}
                onChange={e => set('whatsapp', e.target.value)} placeholder="(11) 99999-9999" className="mt-1" />
            </div>

            <div>
              <Label htmlFor="cpf">CPF *</Label>
              <Input id="cpf" value={form.cpf} onChange={e => set('cpf', e.target.value)}
                placeholder="000.000.000-00" className="mt-1" />
            </div>

            <div>
              <Label htmlFor="coach_id">Coach *</Label>
              <Select value={form.coach_id} onValueChange={v => set('coach_id', v)}>
                <SelectTrigger id="coach_id" className="mt-1"><SelectValue placeholder="Selecione seu coach" /></SelectTrigger>
                <SelectContent>
                  {coaches.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="payment_method">Forma de pagamento *</Label>
              <Select value={form.payment_method} onValueChange={v => set('payment_method', v)}>
                <SelectTrigger id="payment_method" className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  {paymentMethods.map(pm => <SelectItem key={pm.id} value={pm.internal_code}>{pm.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <Button type="submit" className="w-full mt-2" size="lg" disabled={submitting}>
              {submitting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              {submitting ? 'Enviando...' : 'Confirmar adesão'}
            </Button>
          </form>
        </div>

      </div>
    </div>
  );
}
