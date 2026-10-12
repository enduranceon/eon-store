import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { coachMatchPublicRequest } from '@/api/coach-match';
import { MATCH_VERSION, validateCoachMatchAnswers } from '../../../supabase/functions/_shared/coach-match-contract.js';
import { coachMatchStatusMessage } from '@/lib/coach-match-view';

const GOALS = [
  ['start', 'Começar com orientação'],
  ['evolve', 'Evoluir ritmo, distância ou técnica'],
  ['race', 'Preparar uma prova-alvo'],
  ['routine', 'Construir ou retomar uma rotina'],
];
const LEVELS = [
  ['beginner', 'Quem está começando'],
  ['regular', 'Quem já treina regularmente'],
  ['experienced', 'Quem tem experiência e busca algo específico'],
];
const STYLES = [
  ['close', 'Mais conversa e orientação ao longo do processo'],
  ['balanced', 'Um equilíbrio entre orientação e autonomia'],
  ['autonomy', 'Mais autonomia, com revisões e ajustes'],
];
const FORMATS = [
  ['florianopolis', 'Florianópolis, com a rotina presencial da EON'],
  ['online', 'Online, para alunos de outras cidades'],
];
const EMPTY = {
  version: MATCH_VERSION, focus_goals: [], focus_levels: [],
  service_formats: [], communication_style: '', approach: '', experience: '',
};

function ChoiceGroup({ title, hint, options, value, onChange, multi = false }) {
  const selected = multi ? value : [value];
  return (
    <fieldset className="space-y-3">
      <legend className="text-lg font-bold text-slate-900">{title}</legend>
      <p className="text-sm text-slate-500">{hint}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map(([key, label]) => (
          <label key={key} className={`flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border p-4 transition-colors ${selected.includes(key) ? 'border-orange-500 bg-orange-50' : 'border-slate-200 bg-white hover:border-slate-400'}`}>
            <input type={multi ? 'checkbox' : 'radio'} name={title} checked={selected.includes(key)} onChange={() => onChange(key)} className="h-4 w-4 accent-orange-500" />
            <span className="text-sm font-medium leading-snug text-slate-800">{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function CoachMatchForm() {
  const location = useLocation();
  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token') || '';
  return <CoachQuestionnaire key={token} token={token} />;
}

function CoachQuestionnaire({ token }) {
  const [coach, setCoach] = useState(null);
  const [answers, setAnswers] = useState(EMPTY);
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
        const latest = data.latest ? validateCoachMatchAnswers(data.latest.answers) : null;
        if (latest && !latest.ok) throw new Error('Sua resposta anterior usa um formato não reconhecido. Peça ajuda à equipe antes de reenviar.');
        setCoach(data.coach);
        if (latest?.ok) setAnswers(latest.answers);
        setPreviousStatus(data.latest?.status || null);
      })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  const toggleFocus = (field, key) => {
    setError('');
    const values = answers[field];
    if (values.includes(key)) setAnswers(previous => ({ ...previous, [field]: previous[field].filter(item => item !== key) }));
    else if (values.length >= 2) setError('Escolha no máximo duas opções em cada grupo.');
    else setAnswers(previous => ({ ...previous, [field]: [...previous[field], key] }));
  };

  const submit = async event => {
    event.preventDefault();
    const parsed = validateCoachMatchAnswers(answers);
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
            <div role="status"><span className="text-sm font-bold uppercase tracking-widest text-orange-600">Respostas recebidas</span><h1 className="mt-3 text-3xl font-bold">Obrigado, {coach.name.split(' ')[0]}.</h1><p className="mt-4 max-w-xl text-slate-600">A equipe vai revisar suas respostas. Elas ainda não aparecem no site. Se quiser ajustar algo enquanto este link estiver válido, você pode abrir o formulário novamente.</p></div>
          ) : (
            <>
              <span className="text-xs font-bold uppercase tracking-[.15em] text-orange-600">Seu jeito de treinar</span>
              <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Olá, {coach.name.split(' ')[0]}.</h1>
              <p className="mt-4 max-w-2xl leading-relaxed text-slate-600">Conte o que mais representa seu trabalho. Usaremos suas respostas para ajudar futuros alunos a conhecer os coaches da EON. A equipe revisa tudo antes de aparecer no site.</p>
              {coachMatchStatusMessage(previousStatus) && <p className="mt-5 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">{coachMatchStatusMessage(previousStatus)}</p>}
              <form onSubmit={submit} className="mt-9 space-y-9">
                <ChoiceGroup title="Em quais formatos você atende?" hint="Você pode marcar os dois. A equipe confirma essa informação antes de publicar." options={FORMATS} value={answers.service_formats || []} onChange={key => toggleFocus('service_formats', key)} multi />
                <ChoiceGroup title="Em quais objetivos você mais gosta de ajudar?" hint="Escolha até dois. Isso não limita os demais alunos que você pode acompanhar." options={GOALS} value={answers.focus_goals} onChange={key => toggleFocus('focus_goals', key)} multi />
                <ChoiceGroup title="Com quais momentos do atleta você mais se identifica?" hint="Escolha até dois." options={LEVELS} value={answers.focus_levels} onChange={key => toggleFocus('focus_levels', key)} multi />
                <ChoiceGroup title="Como costuma ser a troca com seus alunos?" hint="Escolha a opção mais próxima do seu jeito de trabalhar; não é uma promessa de frequência de contato." options={STYLES} value={answers.communication_style} onChange={key => { setError(''); setAnswers(previous => ({ ...previous, communication_style: key })); }} />
                <label className="block"><span className="text-lg font-bold">Como você conduz o acompanhamento?</span><span className="mt-1 block text-sm text-slate-500">Em suas palavras, sem texto publicitário. Entre 30 e 320 caracteres.</span><textarea required minLength={30} maxLength={320} rows={4} value={answers.approach} onChange={event => setAnswers(previous => ({ ...previous, approach: event.target.value }))} className="mt-3 w-full rounded-xl border border-slate-300 p-4 text-sm leading-relaxed outline-none focus:border-orange-500" placeholder="Por exemplo: como você conversa sobre rotina, ajusta treinos e acompanha a evolução..." /></label>
                <label className="block"><span className="text-lg font-bold">Tem alguma experiência específica que queira destacar?</span><span className="mt-1 block text-sm text-slate-500">Opcional. Até 320 caracteres.</span><textarea maxLength={320} rows={3} value={answers.experience} onChange={event => setAnswers(previous => ({ ...previous, experience: event.target.value }))} className="mt-3 w-full rounded-xl border border-slate-300 p-4 text-sm leading-relaxed outline-none focus:border-orange-500" placeholder="Provas, tipos de preparação ou situações que fazem parte do seu trabalho." /></label>
                {error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
                <div className="border-t border-slate-200 pt-6"><button type="submit" disabled={saving} className="min-h-12 rounded-xl bg-orange-500 px-7 font-bold text-slate-950 transition-colors hover:bg-orange-400 disabled:opacity-60">{saving ? 'Enviando...' : 'Enviar para revisão ↗'}</button><p className="mt-3 text-xs text-slate-500">Somente a versão aprovada pela equipe poderá ser usada no site.</p></div>
              </form>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
