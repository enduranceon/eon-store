import { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Loader2, ExternalLink } from 'lucide-react';
import { PDFDownloadLink, BlobProvider } from '@react-pdf/renderer';
import StatementDocument from './StatementDocument';
import StatementPreview from './StatementPreview';
import {
  PayoutMonthlyClosing, PayoutMonthlyStatementItem, AssessmentCoach,
  AssessmentContract, PreSaleCustomer, AssessmentPlan, AssessmentModality,
} from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCompetence, formatDate } from '@/lib/utils';
import { expenseCategoryLabel } from '@/lib/payout-expenses';

const SOURCE_LABEL = { direct_leadership: 'Liderança', co_leadership: 'Co-liderança', manual_adjustment: 'Ajuste' };

export default function CoachStatement() {
  const { id, coachId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [closing, coaches, items, contracts, customers, plans, modalities] = await Promise.all([
          PayoutMonthlyClosing.get(id),
          AssessmentCoach.list('name').catch(() => []),
          PayoutMonthlyStatementItem.filter({ closing_id: id, coach_id: coachId }).catch(() => []),
          AssessmentContract.list().catch(() => []),
          PreSaleCustomer.list().catch(() => []),
          AssessmentPlan.list().catch(() => []),
          AssessmentModality.list().catch(() => []),
        ]);
        const { data: pend } = await supabase
          .from('payout_pending_repasse')
          .select('*').eq('detected_in_closing_id', id).eq('coach_id', coachId).eq('status', 'open');
        const cids = [...new Set((pend || []).map((p) => p.contract_id))];
        let dueByContract = {};
        if (cids.length) {
          const { data: cts } = await supabase.from('assessment_contracts').select('id, due_date').in('id', cids);
          dueByContract = Object.fromEntries((cts || []).map((c) => [c.id, c.due_date]));
        }
        // Licenças: explicam no extrato por que um aluno rendeu menos no mês.
        const { data: leaves } = await supabase.from('assessment_leaves').select('*');
        if (!alive) return;
        setData({
          closing, coach: (coaches || []).find((c) => c.id === coachId) || null,
          items: items || [], pendings: pend || [], dueByContract, leaves: leaves || [],
          contractsById: Object.fromEntries((contracts || []).map((c) => [c.id, c])),
          customersById: Object.fromEntries((customers || []).map((c) => [c.id, c])),
          plansById: Object.fromEntries((plans || []).map((p) => [p.id, p])),
          modalitiesById: Object.fromEntries((modalities || []).map((m) => [m.id, m])),
        });
      } catch (e) {
        console.error('Erro ao carregar extrato:', e);
        if (alive) setData({ error: true });
      }
    };
    load();
    return () => { alive = false; };
  }, [id, coachId]);

  // Dados prontos do extrato. Alimentam TANTO a prévia em HTML na tela quanto o
  // PDF (mesma fonte, então não há risco de divergirem).
  const view = useMemo(() => {
    if (!data || data.error || !data.closing) return null;
    const { closing, coach, items, pendings, dueByContract, leaves = [], contractsById, customersById, plansById, modalitiesById } = data;
    const competence = closing.competence;
    const todayStr = new Date().toISOString().slice(0, 10);

    // Licença que pega a competência. end_date nulo = licença em aberto (segue
    // valendo). Serve só para explicar no extrato por que o aluno rendeu menos —
    // o desconto de dias em si já vem calculado do fechamento (valid_days).
    const mesIni = String(competence).slice(0, 10);
    const mesFim = (() => {
      const [y, m] = mesIni.split('-').map(Number);
      return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    })();
    const licencaDoContrato = (contractId) => {
      const l = leaves.find((x) => x.contract_id === contractId
        && String(x.start_date).slice(0, 10) <= mesFim
        && (!x.end_date || String(x.end_date).slice(0, 10) >= mesIni));
      if (!l) return null;
      return {
        desde: formatDate(String(l.start_date).slice(0, 10)),
        ate: l.end_date ? formatDate(String(l.end_date).slice(0, 10)) : null,
      };
    };

    const enrich = (it) => {
      const contract = contractsById[it.contract_id];
      const customer = contract ? customersById[contract.customer_id] : null;
      const plan = contract ? plansById[contract.plan_id] : null;
      const modId = contract?.plan_snapshot?.modality_id || plan?.modality_id;
      const modality = modId ? modalitiesById[modId] : null;
      const over = /sobre\s+(.+?)\s+[—–-]/i.exec(it.description || '');
      return {
        ...it,
        aluno: customer?.full_name || (it.description || '').split('—')[0].trim() || 'Aluno',
        modalidade: modality?.name || '',
        licenca: licencaDoContrato(it.contract_id),
        sobre: over ? over[1] : null,
        tipoLabel: SOURCE_LABEL[it.source_type] || 'Repasse',
        refLabel: it.reference_competence && it.reference_competence !== competence ? formatCompetence(it.reference_competence, { short: true }) : null,
      };
    };

    const enriched = items.map(enrich);
    const isCarried = (it) => it.reference_competence && it.reference_competence !== competence && it.source_type !== 'manual_adjustment';
    const alunos = enriched.filter((i) => i.source_type === 'athlete_repasse' && !isCarried(i));
    const liderancas = enriched.filter((i) => ['direct_leadership', 'co_leadership'].includes(i.source_type) && !isCarried(i));
    const resgatados = enriched.filter(isCarried);
    const ajustes = items
      .filter((i) => i.source_type === 'manual_adjustment')
      .map((i) => ({
        id: i.id,
        categoria: expenseCategoryLabel(i.expense_category),
        descricao: (i.description || '').trim(),
        reason: (i.adjustment_reason || '').trim(),
        amount: Number(i.amount),
      }));
    const pends = pendings.map((p) => {
      const e = enrich(p);
      const due = dueByContract[p.contract_id];
      return { ...e, overdue: !!due && due < todayStr };
    });
    const total = items.reduce((a, i) => a + Number(i.amount), 0);

    // Resumo por modalidade (soma alunos + liderança + resgatados; conta alunos próprios)
    const byMod = {};
    for (const it of [...alunos, ...liderancas, ...resgatados]) {
      const mod = it.modalidade || 'Outros';
      if (!byMod[mod]) byMod[mod] = { modalidade: mod, total: 0, alunos: 0 };
      byMod[mod].total += Number(it.amount);
      if (it.source_type === 'athlete_repasse') byMod[mod].alunos += 1;
    }
    const porModalidade = Object.values(byMod).sort((a, b) => b.total - a.total);

    // Alunos afastados o mês INTEIRO. O fechamento não gera item pra eles (zero dias
    // válidos é descartado), então some do extrato sem explicação e o treinador acha
    // que perdeu o aluno. Detecta pelo avesso: contrato pago e vigente no mês, sem
    // nenhum item gerado, e com licença cobrindo o período.
    const mesIniDate = new Date(`${mesIni}T00:00:00Z`);
    const mesFimDate = new Date(`${mesFim}T00:00:00Z`);
    const comItem = new Set(items.map(i => i.contract_id).filter(Boolean));
    const emLicencaIntegral = Object.values(contractsById)
      .filter((ct) => {
        if (ct.coach_id !== coachId) return false;
        if (ct.payment_status !== 'paid') return false;
        if (['cancelled', 'draft', 'voided'].includes(ct.status)) return false;
        if (comItem.has(ct.id)) return false;
        const ini = new Date(`${String(ct.start_date).slice(0, 10)}T00:00:00Z`);
        const fim = ct.end_date ? new Date(`${String(ct.end_date).slice(0, 10)}T00:00:00Z`) : null;
        if (ini > mesFimDate) return false;
        if (fim && fim <= mesIniDate) return false;
        return !!licencaDoContrato(ct.id);
      })
      .map((ct) => ({
        id: ct.id,
        aluno: customersById[ct.customer_id]?.full_name || ct.contract_number || 'Aluno',
        contrato: ct.contract_number || '',
        modalidade: modalitiesById[ct.plan_snapshot?.modality_id || plansById[ct.plan_id]?.modality_id]?.name || '',
        licenca: licencaDoContrato(ct.id),
      }))
      .sort((a, b) => a.aluno.localeCompare(b.aluno));

    return {
      coach,
      emLicencaIntegral,
      mesLabel: formatCompetence(competence),
      generatedAt: formatDate(closing.generated_at?.split('T')[0]),
      statusLabel: closing.status === 'paid' ? 'Pago' : closing.status === 'approved' ? 'Aprovado' : 'Em revisão',
      porModalidade,
      alunos, liderancas, resgatados, ajustes, pendings: pends, total,
    };
  }, [data, coachId]);

  const doc = useMemo(() => (view ? <StatementDocument {...view} /> : null), [view]);

  if (!data) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#64748b' }}>
        <Loader2 className="w-5 h-5 animate-spin" /> Gerando extrato...
      </div>
    );
  }
  if (data.error || !data.closing || !data.coach) {
    return <div style={{ padding: 48, textAlign: 'center', color: '#94a3b8' }}>Extrato não encontrado.</div>;
  }

  const fileName = `Extrato ${data.coach.name} - ${formatCompetence(data.closing.competence)}.pdf`;

  const btn = {
    display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600,
    borderRadius: 8, padding: '9px 16px', textDecoration: 'none', border: 'none', cursor: 'pointer',
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#334155' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 16px', background: '#1e293b', flexWrap: 'wrap' }}>
        <button onClick={() => navigate(`/assessoria/fechamento/${id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#cbd5e1', background: 'none', border: 'none', cursor: 'pointer' }}>
          <ArrowLeft style={{ width: 16, height: 16 }} /> Voltar ao fechamento
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Abrir em aba própria: navegação de topo usa o leitor de PDF completo do
              navegador, que funciona em casos onde o preview embutido (iframe) não
              desenha nada. Ver o bloco de aviso abaixo. */}
          <BlobProvider document={doc}>
            {({ url, loading: blobLoading }) => (
              <a href={url || undefined} target="_blank" rel="noreferrer"
                 style={{ ...btn, color: '#e2e8f0', background: '#334155',
                          pointerEvents: blobLoading || !url ? 'none' : 'auto',
                          opacity: blobLoading || !url ? 0.6 : 1 }}>
                <ExternalLink style={{ width: 16, height: 16 }} />
                {blobLoading ? 'Preparando...' : 'Abrir em nova aba'}
              </a>
            )}
          </BlobProvider>
          <PDFDownloadLink document={doc} fileName={fileName}
            style={{ ...btn, color: '#fff', background: '#2563eb' }}>
            {({ loading }) => <><Download style={{ width: 16, height: 16 }} /> {loading ? 'Preparando...' : 'Baixar PDF'}</>}
          </PDFDownloadLink>
        </div>
      </div>

      <StatementPreview view={view} />

    </div>
  );
}
