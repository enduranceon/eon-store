import { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Loader2 } from 'lucide-react';
import { PDFViewer, PDFDownloadLink } from '@react-pdf/renderer';
import StatementDocument from './StatementDocument';
import {
  PayoutMonthlyClosing, PayoutMonthlyStatementItem, AssessmentCoach,
  AssessmentContract, PreSaleCustomer, AssessmentPlan, AssessmentModality,
} from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCompetence, formatDate } from '@/lib/utils';

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
        if (!alive) return;
        setData({
          closing, coach: (coaches || []).find((c) => c.id === coachId) || null,
          items: items || [], pendings: pend || [], dueByContract,
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

  const doc = useMemo(() => {
    if (!data || data.error || !data.closing) return null;
    const { closing, coach, items, pendings, dueByContract, contractsById, customersById, plansById, modalitiesById } = data;
    const competence = closing.competence;
    const todayStr = new Date().toISOString().slice(0, 10);

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
        sobre: over ? over[1] : null,
        tipoLabel: SOURCE_LABEL[it.source_type] || 'Repasse',
        refLabel: it.reference_competence && it.reference_competence !== competence ? formatCompetence(it.reference_competence, { short: true }) : null,
      };
    };

    const enriched = items.map(enrich);
    const isCarried = (it) => it.reference_competence && it.reference_competence !== competence;
    const alunos = enriched.filter((i) => i.source_type === 'athlete_repasse' && !isCarried(i));
    const liderancas = enriched.filter((i) => ['direct_leadership', 'co_leadership'].includes(i.source_type) && !isCarried(i));
    const resgatados = enriched.filter(isCarried);
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

    return (
      <StatementDocument
        coach={coach}
        mesLabel={formatCompetence(competence)}
        generatedAt={formatDate(closing.generated_at?.split('T')[0])}
        statusLabel={closing.status === 'paid' ? 'Pago' : closing.status === 'approved' ? 'Aprovado' : 'Em revisão'}
        porModalidade={porModalidade}
        alunos={alunos} liderancas={liderancas} resgatados={resgatados} pendings={pends} total={total}
      />
    );
  }, [data]);

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

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#334155' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', background: '#1e293b' }}>
        <button onClick={() => navigate(`/assessoria/fechamento/${id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#cbd5e1', background: 'none', border: 'none', cursor: 'pointer' }}>
          <ArrowLeft style={{ width: 16, height: 16 }} /> Voltar ao fechamento
        </button>
        <PDFDownloadLink document={doc} fileName={fileName}
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: '#fff', background: '#2563eb', borderRadius: 8, padding: '9px 16px', textDecoration: 'none' }}>
          {({ loading }) => <><Download style={{ width: 16, height: 16 }} /> {loading ? 'Preparando...' : 'Baixar PDF'}</>}
        </PDFDownloadLink>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <PDFViewer style={{ width: '100%', height: '100%', border: 'none' }} showToolbar>
          {doc}
        </PDFViewer>
      </div>
    </div>
  );
}
