import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ContextTabs from '@/components/layout/ContextTabs';
import { getCoachMatch, issueCoachMatchInvite, revokeCoachMatchInvite, reviewCoachMatch } from '@/api/coach-match';
import { getCoachMatchView } from '@/lib/coach-match-view';

const GOALS = { start: 'Começar com orientação', evolve: 'Evoluir', race: 'Preparar uma prova', routine: 'Criar ou retomar uma rotina' };
const LEVELS = { beginner: 'Iniciante', regular: 'Já treina regularmente', experienced: 'Experiente' };
const STYLES = { close: 'Mais conversa e orientação', balanced: 'Equilíbrio', autonomy: 'Mais autonomia' };
const FORMATS = { florianopolis: 'Florianópolis', online: 'Online' };

function AnswerSummary({ submission, heading }) {
  if (!submission) return <p className="text-sm text-gray-500">Nenhuma resposta {heading.toLowerCase()}.</p>;
  const answers = submission.answers || {};
  return (
    <div className="space-y-3 text-sm">
      <div><strong>Atendimento:</strong> {(answers.service_formats || []).map(key => FORMATS[key] || key).join(' · ')}</div>
      <div><strong>Objetivos:</strong> {(answers.focus_goals || []).map(key => GOALS[key] || key).join(' · ')}</div>
      <div><strong>Momento do aluno:</strong> {(answers.focus_levels || []).map(key => LEVELS[key] || key).join(' · ')}</div>
      <div><strong>Troca:</strong> {STYLES[answers.communication_style] || '—'}</div>
      <div><strong>Jeito de trabalhar:</strong> <span className="whitespace-pre-wrap text-gray-700">{answers.approach || '—'}</span></div>
      {answers.experience && <div><strong>Experiência destacada:</strong> <span className="whitespace-pre-wrap text-gray-700">{answers.experience}</span></div>}
      <p className="text-xs text-gray-500">Enviado em {new Date(submission.submitted_at).toLocaleString('pt-BR')}</p>
    </div>
  );
}

export default function CoachMatch() {
  const { coachId } = useParams();
  return <CoachMatchDetails key={coachId} coachId={coachId} />;
}

function CoachMatchDetails({ coachId }) {
  const [data, setData] = useState(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [clock, setClock] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const next = await getCoachMatch(coachId);
    getCoachMatchView(next);
    setData(next);
    setLoadedAt(Date.now());
    setClock(Date.now());
  }, [coachId]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getCoachMatch(coachId, { signal: controller.signal })
      .then(next => {
        getCoachMatchView(next);
        if (active) { setData(next); setLoadedAt(Date.now()); setClock(Date.now()); }
      })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [coachId]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const run = async operation => {
    setBusy(true); setError(''); setMessage('');
    try {
      await operation();
      try { await load(); }
      catch {
        setData(null);
        setError('A alteração foi concluída, mas não foi possível atualizar a tela. Atualize o formulário para conferir o estado atual.');
      }
    }
    catch (err) {
      setError(err.message);
      // A concurrent submission or an interrupted response can invalidate the view.
      try { await load(); } catch { setData(null); }
    }
    finally { setBusy(false); }
  };

  const refresh = async () => {
    setBusy(true); setError('');
    try { await load(); }
    catch (err) { setData(null); setError(err.message); }
    finally { setBusy(false); }
  };

  const createLink = () => run(async () => {
    const invite = await issueCoachMatchInvite(coachId);
    setLink({ inviteId: invite.id, url: `${window.location.origin}/match-coach#token=${invite.token}` });
    setMessage('Link gerado. Copie e envie ao coach; o anterior foi revogado.');
  });

  const review = (submissionId, decision) => run(async () => {
    await reviewCoachMatch(coachId, submissionId, decision);
    setMessage(decision === 'approved' ? 'Respostas aprovadas para o match público.' : 'Esta versão não será publicada. A versão aprovada anteriormente continua disponível.');
  });

  const revoke = inviteId => run(async () => {
    await revokeCoachMatchInvite(coachId, inviteId);
    setLink(null);
    setMessage('Link revogado.');
  });

  const { pending, published, currentInvite } = data
    ? getCoachMatchView(data, clock - loadedAt)
    : { pending: null, published: null, currentInvite: null };
  const currentLink = currentInvite?.id === link?.inviteId ? link?.url : null;

  return (
    <div className="space-y-5">
      <ContextTabs group="team" current="/assessoria/coaches" />
      <Link to="/assessoria/coaches" className="text-sm font-medium text-gray-600 underline underline-offset-4">← Voltar aos coaches</Link>
      {loading ? <p role="status">Carregando formulário...</p> : !data ? <div><p role="alert" className="text-red-700">{error || 'Não foi possível carregar o formulário'}</p><button type="button" onClick={refresh} disabled={busy} className="mt-3 rounded-lg border bg-white px-4 py-2 text-sm font-medium disabled:opacity-50">{busy ? 'Atualizando...' : 'Atualizar formulário'}</button></div> : (
        <>
          <header><p className="text-xs font-bold uppercase tracking-widest text-orange-600">Match com treinador</p><h1 className="mt-1 text-2xl font-bold">{data.coach.name}</h1><p className="mt-2 max-w-2xl text-sm text-gray-600">Gere um link individual, envie ao coach e aprove as respostas que farão parte do site. A modalidade, os planos e a visibilidade continuam controlados no cadastro principal.</p><button type="button" onClick={refresh} disabled={busy} className="mt-3 text-sm font-medium underline underline-offset-4 disabled:opacity-50">{busy ? 'Atualizando...' : 'Atualizar respostas'}</button></header>
          {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          {message && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</p>}

          <section className="rounded-xl border bg-white p-5">
            <h2 className="text-lg font-bold">Link para o coach</h2>
            <p className="mt-1 text-sm text-gray-600">Válido por 30 dias. Gerar outro link revoga o anterior. Nenhum e-mail é enviado automaticamente.</p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" onClick={createLink} disabled={busy || !data.coach.active} className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Gerar novo link</button>
              {currentInvite && <><span className="text-xs text-gray-500">Link ativo até {new Date(currentInvite.expires_at).toLocaleDateString('pt-BR')}</span><button type="button" onClick={() => revoke(currentInvite.id)} disabled={busy} className="text-sm font-medium text-red-700 underline">Revogar</button></>}
            </div>
            {!data.coach.active && <p className="mt-2 text-sm text-amber-700">Ative o coach no cadastro antes de enviar o formulário.</p>}
            {currentLink && <div className="mt-4 flex flex-col gap-2 sm:flex-row"><input aria-label="Link individual do formulário" value={currentLink} readOnly className="min-w-0 flex-1 rounded-lg border bg-gray-50 px-3 py-2 text-xs" /><button type="button" disabled={busy} onClick={async () => { try { await navigator.clipboard.writeText(currentLink); setMessage('Link copiado.'); } catch { setMessage('Selecione e copie o link acima.'); } }} className="rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-50">Copiar link</button></div>}
            {currentInvite && !currentLink && <p className="mt-3 text-xs text-gray-500">Por segurança, um link antigo não pode ser exibido de novo. Gere outro se precisar reenviá-lo.</p>}
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <section className="rounded-xl border bg-white p-5">
              <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-lg font-bold">Aguardando sua revisão</h2>{pending && <span className="shrink-0 whitespace-nowrap rounded-full bg-orange-100 px-2 py-1 text-xs font-semibold text-orange-700">Nova resposta</span>}</div>
              <AnswerSummary submission={pending} heading="Pendente" />
              {pending && <div className="mt-5 flex flex-wrap gap-2 border-t pt-4"><button type="button" disabled={busy} onClick={() => review(pending.id, 'approved')} className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-bold text-gray-950 disabled:opacity-50">Aprovar para o site</button><button type="button" disabled={busy} onClick={() => review(pending.id, 'rejected')} className="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50">Não publicar esta versão</button></div>}
            </section>
            <section className="rounded-xl border bg-white p-5"><h2 className="mb-4 text-lg font-bold">Versão aprovada para o site</h2><AnswerSummary submission={published} heading="Aprovada" /><p className="mt-4 text-xs text-gray-500">Novos envios não substituem esta versão até sua aprovação. O site deve considerar também a modalidade, as ofertas disponíveis e a visibilidade do coach.</p></section>
          </div>
        </>
      )}
    </div>
  );
}
