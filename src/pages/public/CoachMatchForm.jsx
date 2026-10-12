import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { coachMatchPublicRequest } from '@/api/coach-match';
import { MATCH_VERSION, validateCoachMatchV2Answers } from '../../../supabase/functions/_shared/coach-match-contract.js';
import { coachMatchStatusMessage } from '@/lib/coach-match-view';

const GOALS = [
  ['health', 'Saúde e qualidade de vida'],
  ['start', 'Começar no esporte'],
  ['performance', 'Evoluir o desempenho'],
  ['return', 'Retomar os treinos'],
  ['high_performance', 'Alta performance'],
];
const LEVELS = [
  ['beginner', 'Iniciante'],
  ['intermediate', 'Intermediário'],
  ['advanced', 'Avançado'],
];
const STYLES = [
  ['close', 'Acompanhamento mais próximo'],
  ['balanced', 'Equilíbrio entre orientação e autonomia'],
  ['autonomy', 'Mais autonomia, com revisões e ajustes'],
];
const AGES = [
  ['up_to_30', 'Até 30 anos'],
  ['age_31_50', 'De 31 a 50 anos'],
  ['age_51_plus', '51 anos ou mais'],
];
const GENDERS = [
  ['female', 'Mulheres'],
  ['male', 'Homens'],
];
const FORMATS = [
  ['florianopolis', 'Florianópolis'],
  ['online', 'Online'],
];

function emptyAnswers() {
  return {
    version: MATCH_VERSION,
    service_formats: [],
    focus_goals: { primary: '', secondary: null },
    focus_levels: { primary: '', secondary: null },
    communication_style: { primary: '', secondary: null },
    age_groups: { primary: '', secondary: null },
    gender_preference: { primary: '', secondary: null },
  };
}

function FormatChoices({ value, onChange }) {
  return (
    <fieldset>
      <legend className="text-base font-bold text-slate-900">Onde você atende?</legend>
      <p className="mt-1 text-sm text-slate-500">Marque os formatos que fazem parte do seu atendimento atual.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {FORMATS.map(([key, label]) => (
          <label key={key} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${value.includes(key) ? 'border-orange-500 bg-orange-50' : 'border-slate-200 bg-white hover:border-slate-400'}`}>
            <input type="checkbox" checked={value.includes(key)} onChange={() => onChange(key)} className="h-4 w-4 accent-orange-500" />
            <span className="text-sm font-semibold text-slate-800">{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function PriorityChoice({ field, question, options, value, onChange, allowNoPreference = false }) {
  const primaryOptions = allowNoPreference ? [...options, ['no_preference', 'Sem preferência']] : options;
  const secondaryDisabled = !value.primary || value.primary === 'no_preference';
  return (
    <fieldset className="rounded-2xl border border-slate-200 p-4 sm:p-5">
      <legend className="px-1 text-base font-bold leading-snug text-slate-900">{question}</legend>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <label htmlFor={`${field}-primary`} className="block">
          <span className="text-xs font-bold uppercase tracking-[.12em] text-orange-600">Principal</span>
          <select id={`${field}-primary`} required value={value.primary} onChange={event => onChange('primary', event.target.value)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-100">
            <option value="">Selecione uma opção</option>
            {primaryOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label htmlFor={`${field}-secondary`} className="block">
          <span className="text-xs font-bold uppercase tracking-[.12em] text-slate-500">Também me identifico</span>
          <select id={`${field}-secondary`} value={value.secondary || ''} disabled={secondaryDisabled} onChange={event => onChange('secondary', event.target.value)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400">
            <option value="">Opcional</option>
            {options.filter(([key]) => key !== value.primary).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
      </div>
    </fieldset>
  );
}

function Modalities({ items }) {
  const labels = Array.isArray(items)
    ? items.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean)
    : [];
  return (
    <div className="rounded-2xl bg-slate-50 p-4 sm:flex sm:items-center sm:justify-between sm:gap-4">
      <div>
        <p className="text-sm font-bold text-slate-900">Modalidades do seu cadastro</p>
        <p className="mt-1 text-xs text-slate-500">Essa informação vem do seu perfil na EON Store.</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 sm:mt-0 sm:justify-end">
        {labels.length ? labels.map(label => <span key={label} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">{label}</span>) : <span className="text-xs text-slate-500">Nenhuma modalidade ativa</span>}
      </div>
    </div>
  );
}

export default function CoachMatchForm() {
  const location = useLocation();
  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token') || '';
  return <CoachQuestionnaire key={token} token={token} />;
}

function CoachQuestionnaire({ token }) {
  const [coach, setCoach] = useState(null);
  const [answers, setAnswers] = useState(emptyAnswers);
  const [previousStatus, setPreviousStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setError('Este link está incompleto. Peça um novo link à equipe.');
      setLoading(false);
      return () => { active = false; };
    }
    coachMatchPublicRequest('load', token)
      .then(data => {
        if (!active) return;
        if (!data.coach?.name || !Object.hasOwn(data, 'latest')) throw new Error('Não foi possível confirmar seu formulário. Reabra o link para tentar novamente.');
        const latest = data.latest ? validateCoachMatchV2Answers(data.latest.answers) : null;
        if (latest && !latest.ok) throw new Error('Sua resposta anterior usa um formato não reconhecido. Peça ajuda à equipe antes de reenviar.');
        setCoach(data.coach);
        if (latest?.ok) setAnswers(latest.answers);
        setPreviousStatus(data.latest?.status || null);
      })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  const toggleFormat = key => {
    setError('');
    setAnswers(previous => ({
      ...previous,
      service_formats: previous.service_formats.includes(key)
        ? previous.service_formats.filter(item => item !== key)
        : [...previous.service_formats, key],
    }));
  };

  const changePriority = (field, slot, rawValue) => {
    setError('');
    setAnswers(previous => {
      const current = previous[field];
      if (slot === 'primary') {
        return {
          ...previous,
          [field]: {
            primary: rawValue,
            secondary: rawValue === 'no_preference' || current.secondary === rawValue ? null : current.secondary,
          },
        };
      }
      return { ...previous, [field]: { ...current, secondary: rawValue || null } };
    });
  };

  const submit = async event => {
    event.preventDefault();
    const parsed = validateCoachMatchV2Answers(answers);
    if (!parsed.ok) { setError(parsed.error); return; }
    setSaving(true);
    setError('');
    try {
      await coachMatchPublicRequest('submit', token, parsed.answers);
      setSent(true);
      setPreviousStatus('pending');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#f6f5f2] px-4 py-9 text-slate-900 sm:py-14">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 flex items-center justify-between gap-4">
          <span className="text-lg font-black tracking-tight">ENDURANCE ON</span>
          <span className="text-xs font-bold uppercase tracking-[.17em] text-orange-600">Match com treinador</span>
        </header>
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
          {loading ? <p role="status">Abrindo seu formulário...</p> : !coach ? (
            <div role="alert"><h1 className="text-2xl font-bold">Não foi possível abrir o formulário.</h1><p className="mt-3 text-slate-600">{error}</p></div>
          ) : sent ? (
            <div role="status"><span className="text-sm font-bold uppercase tracking-widest text-orange-600">Respostas recebidas</span><h1 className="mt-3 text-3xl font-bold">Obrigado, {coach.name.split(' ')[0]}.</h1><p className="mt-4 max-w-xl text-slate-600">A equipe vai revisar suas escolhas. Se quiser ajustar algo enquanto este link estiver válido, você pode abrir o formulário novamente.</p></div>
          ) : (
            <>
              <span className="text-xs font-bold uppercase tracking-[.15em] text-orange-600">Seu perfil de acompanhamento</span>
              <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Olá, {coach.name.split(' ')[0]}.</h1>
              <p className="mt-3 max-w-2xl leading-relaxed text-slate-600">Marque a opção que mais representa você e, quando fizer sentido, uma segunda afinidade.</p>
              {coachMatchStatusMessage(previousStatus) && <p className="mt-5 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">{coachMatchStatusMessage(previousStatus)}</p>}
              <form onSubmit={submit} className="mt-7 space-y-5">
                <Modalities items={coach.modalities} />
                <FormatChoices value={answers.service_formats} onChange={toggleFormat} />
                <PriorityChoice field="focus-goals" question="Com quais objetivos você mais gosta de trabalhar?" options={GOALS} value={answers.focus_goals} onChange={(slot, value) => changePriority('focus_goals', slot, value)} />
                <PriorityChoice field="focus-levels" question="Com qual momento do atleta você mais se identifica?" options={LEVELS} value={answers.focus_levels} onChange={(slot, value) => changePriority('focus_levels', slot, value)} />
                <PriorityChoice field="communication-style" question="Qual estilo de acompanhamento combina mais com você?" options={STYLES} value={answers.communication_style} onChange={(slot, value) => changePriority('communication_style', slot, value)} />
                <PriorityChoice field="age-groups" question="Com qual faixa etária você mais se identifica no acompanhamento?" options={AGES} value={answers.age_groups} onChange={(slot, value) => changePriority('age_groups', slot, value)} allowNoPreference />
                <PriorityChoice field="gender-preference" question="Você tem preferência pelo gênero do atleta?" options={GENDERS} value={answers.gender_preference} onChange={(slot, value) => changePriority('gender_preference', slot, value)} allowNoPreference />
                {error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
                <div className="border-t border-slate-200 pt-6"><button type="submit" disabled={saving} className="min-h-12 rounded-xl bg-orange-500 px-7 font-bold text-slate-950 transition-colors hover:bg-orange-400 disabled:opacity-60">{saving ? 'Enviando...' : 'Enviar para revisão ↗'}</button><p className="mt-3 text-xs text-slate-500">A equipe revisa as escolhas antes de ativá-las no match.</p></div>
              </form>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
