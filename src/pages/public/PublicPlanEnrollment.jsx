import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, Loader2, AlertCircle, CreditCard, QrCode } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { supabase } from '@/api/db';
import { formatCurrency, maskCpf, validateCpf } from '@/lib/utils';
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

function addPlanMonths(startStr, months) {
  const d = new Date(startStr + 'T12:00:00');
  d.setMonth(d.getMonth() + months);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function PaymentSelector({ planMonths, paymentType, installments, onChange }) {
  const maxInstallments = planMonths;

  return (
    <div className="space-y-3">
      <Label>Forma de pagamento *</Label>
      <div className="grid grid-cols-2 gap-3 mt-1">
        <button
          type="button"
          onClick={() => onChange('card', 1)}
          className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all ${
            paymentType === 'card'
              ? 'border-blue-500 bg-blue-50 text-blue-700'
              : 'border-gray-200 text-gray-500 hover:border-gray-300'
          }`}
        >
          <CreditCard className="w-5 h-5" />
          <span className="text-xs font-medium">Cartão de crédito</span>
        </button>
        <button
          type="button"
          onClick={() => onChange('pix_boleto', 1)}
          className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all ${
            paymentType === 'pix_boleto'
              ? 'border-blue-500 bg-blue-50 text-blue-700'
              : 'border-gray-200 text-gray-500 hover:border-gray-300'
          }`}
        >
          <QrCode className="w-5 h-5" />
          <span className="text-xs font-medium">PIX / Boleto</span>
        </button>
      </div>

      {paymentType === 'card' && maxInstallments > 1 && (
        <div>
          <p className="text-xs text-gray-500 mb-2">Parcelas</p>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: maxInstallments }, (_, i) => i + 1).map(n => (
              <button
                key={n}
                type="button"
                onClick={() => onChange('card', n)}
                className={`px-3 py-1.5 rounded-lg border-2 text-sm font-medium transition-all ${
                  installments === n
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                {n}x
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PublicPlanEnrollment() {
  const { planId } = useParams();

  const [plan,       setPlan]       = useState(null);
  const [modality,   setModality]   = useState(null);
  const [coaches,    setCoaches]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [notFound,   setNotFound]   = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done,       setDone]       = useState(false);

  const [form, setForm] = useState({
    full_name: '', gender: '', birth_date: '',
    whatsapp: '', cpf: '', coach_id: '',
    payment_type: '', installments: 1,
  });
  const [cpfTouched, setCpfTouched] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data: planData, error } = await supabase
          .from('assessment_plans').select('*').eq('id', planId).eq('active', true).maybeSingle();
        if (error || !planData) { setNotFound(true); setLoading(false); return; }
        setPlan(planData);

        const [{ data: mod }, { data: coachList }] = await Promise.all([
          supabase.from('assessment_modalities').select('id,name').eq('id', planData.modality_id).maybeSingle(),
          supabase.from('assessment_coaches').select('id,name').eq('active', true).order('name'),
        ]);
        setModality(mod);
        setCoaches(coachList || []);
      } catch (e) {
        console.error(e);
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [planId]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.full_name.trim())  return toast.error('Nome obrigatório');
    if (!form.whatsapp.trim())   return toast.error('WhatsApp obrigatório');
    if (!form.cpf.trim())        return toast.error('CPF obrigatório');
    if (!validateCpf(form.cpf)) return toast.error('CPF inválido');
    if (!form.coach_id)          return toast.error('Selecione um coach');
    if (!form.payment_type)      return toast.error('Selecione a forma de pagamento');

    setSubmitting(true);
    try {
      const cpfClean = form.cpf.replace(/\D/g, '');

      let customer;
      const { data: existingId } = await supabase
        .rpc('find_customer_id_by_cpf', { p_cpf: cpfClean });

      if (existingId) {
        customer = { id: existingId };
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

      const startDate = new Date().toISOString().split('T')[0];
      const endDate   = addPlanMonths(startDate, getPlanMonths(plan));

      const { error: contractErr } = await supabase
        .from('assessment_contracts')
        .insert({
          customer_id:    customer.id,
          coach_id:       form.coach_id,
          plan_id:        plan.id,
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
          status:            'draft',
          payment_status:    'pending',
          start_date:        startDate,
          end_date:          endDate,
          original_end_date: endDate,
          payment_method: form.payment_type,
          installments:   form.payment_type === 'card' ? form.installments : 1,
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
        <h2 className="text-xl font-bold text-gray-800">Plano não encontrado</h2>
        <p className="text-gray-500 mt-2 text-sm">Este link pode ter expirado ou o plano foi desativado.</p>
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
          Em breve você receberá a cobrança para confirmar sua matrícula.
          Aguarde o contato da nossa equipe.
        </p>
      </div>
    </div>
  );

  const planMonths = getPlanMonths(plan);
  const planName   = plan.name?.trim() || `${modality?.name || 'Plano'} · ${periodLabel(planMonths)}`;

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-md mx-auto space-y-5">

        {/* Resumo do plano */}
        <div className="bg-white rounded-2xl border border-blue-100 shadow-sm p-5">
          <p className="text-xs font-bold uppercase tracking-wide text-blue-600 mb-0.5">
            {modality?.name || 'Assessoria'}
          </p>
          <h1 className="text-xl font-bold text-gray-900">{planName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{periodLabel(planMonths)}</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="bg-blue-50 rounded-xl p-3 text-center">
              <p className="text-xs text-blue-600 font-medium mb-0.5">Mensalidade</p>
              <p className="text-lg font-bold text-blue-700">{formatCurrency(plan.price_monthly)}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <p className="text-xs text-gray-500 font-medium mb-0.5">Total</p>
              <p className="text-lg font-bold text-gray-800">
                {formatCurrency(Number(plan.price_total) + Number(plan.enrollment_fee || 0))}
              </p>
            </div>
          </div>
          {Number(plan.enrollment_fee) > 0 && (
            <div className="mt-2 bg-amber-50 rounded-xl p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-amber-700 font-medium">Matrícula</p>
                <p className="text-sm font-bold text-amber-700">{formatCurrency(plan.enrollment_fee)}</p>
              </div>
              <p className="text-[11px] text-amber-600 mt-0.5">Cobrada apenas na primeira mensalidade</p>
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
              <Input id="cpf" value={form.cpf}
                onChange={e => set('cpf', maskCpf(e.target.value))}
                onBlur={() => setCpfTouched(true)}
                placeholder="000.000.000-00" className="mt-1"
                inputMode="numeric" />
              {cpfTouched && form.cpf && !validateCpf(form.cpf) && (
                <p className="text-xs text-red-500 mt-1">CPF inválido</p>
              )}
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

            <PaymentSelector
              planMonths={planMonths}
              paymentType={form.payment_type}
              installments={form.installments}
              onChange={(type, inst) => setForm(f => ({ ...f, payment_type: type, installments: inst }))}
            />

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
