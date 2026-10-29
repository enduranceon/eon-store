import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { loadPlanLink, submitPlanLink } from '@/api/plan-link';
import { PhoneInput } from '@/components/PhoneInput';
import { formatCep, lookupCepAddress, normalizeCep } from '@/lib/br-address';
import { durationLabel } from '@/lib/plan-families';
import { PLAN_LINK_GENDERS, PLAN_LINK_REGIONS, emptyPlanLinkForm, installmentText, maskBirthDate, preparePlanLinkSubmission, regionFromLink } from '@/lib/plan-link-form';
import { cn, formatCurrency, maskCpf } from '@/lib/utils';

const FIELD = 'mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-200';
const LABEL = 'block text-sm font-semibold text-slate-700';

function Field({ id, label, children, className }) {
  return (
    <div className={className}>
      <label htmlFor={id} className={LABEL}>{label}</label>
      {children}
    </div>
  );
}

// Página que a equipe manda no WhatsApp: a pessoa escolhe a duração, preenche
// os dados e vira prospect no quadro, com o plano e o coach do link.
export default function PlanLinkForm() {
  const { token } = useParams();
  const { search } = useLocation();
  const query = new URLSearchParams(search);
  const coachFromLink = query.get('coach') || '';
  const regionFromUrl = regionFromLink(query.get('regiao'));
  const [link, setLink] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState(emptyPlanLinkForm);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [cepLoading, setCepLoading] = useState(false);
  const requestId = useRef(null);
  const fingerprint = useRef('');

  useEffect(() => {
    let alive = true;
    loadPlanLink(token, coachFromLink)
      .then(data => {
        if (!alive) return;
        setLink(data);
        setForm(current => ({
          ...current,
          coach_id: data.coach?.id || '',
          region: regionFromUrl || current.region,
          plan_id: data.options?.length === 1 ? data.options[0].plan_id : '',
        }));
      })
      .catch(err => { if (alive) setLoadError(err.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token, coachFromLink, regionFromUrl]);

  const set = (field, value) => setForm(current => ({ ...current, [field]: value }));
  const firstName = useMemo(() => String(form.full_name || '').trim().split(' ')[0], [form.full_name]);

  const fillAddress = async value => {
    const cep = normalizeCep(value);
    set('address_zip', formatCep(cep));
    if (cep.length !== 8) return;
    setCepLoading(true);
    try {
      const address = await lookupCepAddress(cep);
      setForm(current => ({
        ...current,
        address_street: address.street || current.address_street,
        address_neighborhood: address.neighborhood || current.address_neighborhood,
        address_city: address.city || current.address_city,
        address_state: address.state || current.address_state,
      }));
    } catch {
      // Sem a busca do CEP a pessoa preenche o endereço à mão.
    } finally {
      setCepLoading(false);
    }
  };

  const submit = async event => {
    event.preventDefault();
    if (sending) return;
    const next = JSON.stringify({ ...form, website: '' });
    if (fingerprint.current !== next || !requestId.current) {
      fingerprint.current = next;
      requestId.current = crypto.randomUUID();
    }
    const { error: invalid, body } = preparePlanLinkSubmission(form, { token, requestId: requestId.current });
    if (invalid) return setError(invalid);
    setError('');
    setSending(true);
    try {
      await submitPlanLink(body);
      setSent(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#f6f5f2] px-4 py-8 text-slate-900 sm:py-12">
      <div className="mx-auto max-w-2xl">
        <header className="mb-6 flex items-center justify-between gap-4">
          <span className="text-lg font-black tracking-tight">ENDURANCE ON</span>
          <span className="text-xs font-bold uppercase tracking-[.17em] text-orange-600">Assessoria</span>
        </header>
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
          {loading ? (
            <p role="status" className="flex items-center gap-2 text-slate-600"><Loader2 className="h-4 w-4 animate-spin" /> Abrindo o plano...</p>
          ) : !link ? (
            <div role="alert">
              <h1 className="text-2xl font-bold">Não foi possível abrir este link.</h1>
              <p className="mt-3 text-slate-600">{loadError || 'Peça um novo link para a nossa equipe.'}</p>
            </div>
          ) : sent ? (
            <div role="status">
              <span className="text-sm font-bold uppercase tracking-widest text-orange-600">Dados recebidos</span>
              <h1 className="mt-3 text-3xl font-bold">Obrigado{firstName ? `, ${firstName}` : ''}!</h1>
              <p className="mt-4 text-slate-600">Nossa equipe vai falar com você pelo WhatsApp para finalizar sua entrada na assessoria.</p>
            </div>
          ) : (
            <form onSubmit={submit} noValidate className="space-y-6">
              <div>
                <span className="text-xs font-bold uppercase tracking-[.15em] text-orange-600 capitalize">{link.family?.modality}</span>
                <h1 className="mt-2 text-3xl font-black tracking-tight">{link.family?.name}</h1>
                {link.coach && <p className="mt-2 text-slate-600">Com o treinador <b>{link.coach.name}</b>.</p>}
                {regionFromUrl && <p className="mt-1 text-slate-600">Treino: <b>{PLAN_LINK_REGIONS[regionFromUrl]}</b>.</p>}
              </div>

              <fieldset>
                <legend className={LABEL}>Escolha a duração</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {(link.options || []).map(option => {
                    const { parts, value } = installmentText(option);
                    const selected = form.plan_id === option.plan_id;
                    return (
                      <label key={option.plan_id}
                        className={cn('cursor-pointer rounded-2xl border-2 p-3 transition-colors',
                          selected ? 'border-orange-500 bg-orange-50' : 'border-slate-200 hover:border-orange-300')}>
                        <input type="radio" name="plan" value={option.plan_id} checked={selected}
                          onChange={() => set('plan_id', option.plan_id)} className="sr-only" />
                        <span className="block text-sm font-bold">{durationLabel(option.period_months)}</span>
                        <span className="mt-1 block text-xl font-black">{formatCurrency(Number(option.price_total))}</span>
                        {parts > 1 && <span className="block text-xs text-slate-600">em até {parts}x de {formatCurrency(value)}</span>}
                        {Number(option.enrollment_fee) > 0 && (
                          <span className="mt-1 block text-xs text-slate-500">+ matrícula {formatCurrency(Number(option.enrollment_fee))}</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {!link.coach && (
                <Field id="plan-link-coach" label="Treinador">
                  <select id="plan-link-coach" className={FIELD} value={form.coach_id} onChange={event => set('coach_id', event.target.value)}>
                    <option value="">Escolha...</option>
                    {(link.coaches || []).map(coach => <option key={coach.id} value={coach.id}>{coach.name}</option>)}
                  </select>
                </Field>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="plan-link-name" label="Nome completo" className="sm:col-span-2">
                  <input id="plan-link-name" className={FIELD} autoComplete="name" maxLength={160}
                    value={form.full_name} onChange={event => set('full_name', event.target.value)} />
                </Field>
                <Field id="plan-link-phone" label="WhatsApp">
                  <PhoneInput id="plan-link-phone" className={FIELD} value={form.whatsapp} onChange={value => set('whatsapp', value)} />
                </Field>
                <Field id="plan-link-email" label="E-mail">
                  <input id="plan-link-email" type="email" className={FIELD} autoComplete="email" maxLength={180}
                    value={form.email} onChange={event => set('email', event.target.value)} />
                </Field>
                <Field id="plan-link-cpf" label="CPF">
                  <input id="plan-link-cpf" inputMode="numeric" className={FIELD}
                    value={form.cpf} onChange={event => set('cpf', maskCpf(event.target.value))} />
                </Field>
                <Field id="plan-link-birth" label="Data de nascimento">
                  <input id="plan-link-birth" inputMode="numeric" autoComplete="bday" placeholder="dd/mm/aaaa" maxLength={10} className={FIELD}
                    value={form.birth_date} onChange={event => set('birth_date', maskBirthDate(event.target.value))} />
                </Field>
                <Field id="plan-link-gender" label="Gênero (opcional)">
                  <select id="plan-link-gender" className={FIELD} value={form.gender} onChange={event => set('gender', event.target.value)}>
                    <option value="">Prefiro não informar</option>
                    {Object.entries(PLAN_LINK_GENDERS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </Field>
                {!regionFromUrl && (
                  <Field id="plan-link-region" label="Onde vai treinar">
                    <select id="plan-link-region" className={FIELD} value={form.region} onChange={event => set('region', event.target.value)}>
                      <option value="">Prefiro não dizer</option>
                      {Object.entries(PLAN_LINK_REGIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </Field>
                )}
              </div>

              <fieldset className="grid gap-4 sm:grid-cols-6">
                <legend className="mb-1 text-sm font-bold text-slate-900">Endereço</legend>
                <Field id="plan-link-zip" label={cepLoading ? 'CEP (buscando...)' : 'CEP'} className="sm:col-span-2">
                  <input id="plan-link-zip" inputMode="numeric" className={FIELD} autoComplete="postal-code"
                    value={form.address_zip} onChange={event => fillAddress(event.target.value)} />
                </Field>
                <Field id="plan-link-street" label="Rua" className="sm:col-span-4">
                  <input id="plan-link-street" className={FIELD} autoComplete="address-line1" maxLength={160}
                    value={form.address_street} onChange={event => set('address_street', event.target.value)} />
                </Field>
                <Field id="plan-link-number" label="Número" className="sm:col-span-2">
                  <input id="plan-link-number" className={FIELD} maxLength={40}
                    value={form.address_number} onChange={event => set('address_number', event.target.value)} />
                </Field>
                <Field id="plan-link-complement" label="Complemento" className="sm:col-span-4">
                  <input id="plan-link-complement" className={FIELD} autoComplete="address-line2" maxLength={120}
                    value={form.address_complement} onChange={event => set('address_complement', event.target.value)} />
                </Field>
                <Field id="plan-link-neighborhood" label="Bairro" className="sm:col-span-2">
                  <input id="plan-link-neighborhood" className={FIELD} maxLength={120}
                    value={form.address_neighborhood} onChange={event => set('address_neighborhood', event.target.value)} />
                </Field>
                <Field id="plan-link-city" label="Cidade" className="sm:col-span-3">
                  <input id="plan-link-city" className={FIELD} autoComplete="address-level2" maxLength={120}
                    value={form.address_city} onChange={event => set('address_city', event.target.value)} />
                </Field>
                <Field id="plan-link-state" label="UF" className="sm:col-span-1">
                  <input id="plan-link-state" className={FIELD} autoComplete="address-level1" maxLength={2}
                    value={form.address_state} onChange={event => set('address_state', event.target.value.toUpperCase())} />
                </Field>
              </fieldset>

              {/* Campo isca: invisível para pessoas, preenchido por robôs. */}
              <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true"
                className="hidden" value={form.website} onChange={event => set('website', event.target.value)} />

              <label className="flex items-start gap-3 text-sm text-slate-700">
                <input type="checkbox" className="mt-0.5 h-5 w-5 accent-orange-500" checked={form.confirmed}
                  onChange={event => set('confirmed', event.target.checked)} />
                <span>Confirmo que os dados estão corretos e quero que a equipe da Endurance On entre em contato para finalizar minha entrada.</span>
              </label>

              {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}

              <button type="submit" disabled={sending}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-orange-500 px-7 font-bold text-slate-950 transition-colors hover:bg-orange-400 disabled:opacity-60 sm:w-auto">
                {sending && <Loader2 className="h-4 w-4 animate-spin" />}
                {sending ? 'Enviando...' : 'Enviar meus dados'}
              </button>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
