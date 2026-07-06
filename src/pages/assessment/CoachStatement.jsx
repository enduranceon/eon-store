import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Printer, Zap } from 'lucide-react';
import {
  PayoutMonthlyClosing, PayoutMonthlyStatementItem, AssessmentCoach,
} from '@/api/entities';
import { supabase } from '@/api/db';
import { formatCurrency, formatCompetence, formatDate } from '@/lib/utils';

const SOURCE_LABEL = {
  athlete_repasse:   'Aluno',
  direct_leadership: 'Liderança',
  co_leadership:     'Co-liderança',
  manual_adjustment: 'Ajuste',
};

const ROLE_LABEL = { junior: 'Junior', pleno: 'Pleno', senior: 'Senior' };

function Row({ tipo, descricao, sub, valor, refLabel }) {
  return (
    <tr>
      <td style={{ padding: '7px 10px', borderBottom: '1px solid #eef1f5', verticalAlign: 'top', width: 96 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#334155' }}>{tipo}</span>
        {refLabel && (
          <div style={{ fontSize: 10, color: '#c2410c', fontWeight: 600, marginTop: 2 }}>ref. {refLabel}</div>
        )}
      </td>
      <td style={{ padding: '7px 10px', borderBottom: '1px solid #eef1f5' }}>
        <div style={{ fontSize: 13, color: '#0f172a' }}>{descricao}</div>
        {sub && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>{sub}</div>}
      </td>
      <td style={{ padding: '7px 10px', borderBottom: '1px solid #eef1f5', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600, fontSize: 13 }}>
        {formatCurrency(valor)}
      </td>
    </tr>
  );
}

export default function CoachStatement() {
  const { id, coachId } = useParams();
  const navigate = useNavigate();
  const [closing, setClosing] = useState(null);
  const [coach, setCoach] = useState(null);
  const [items, setItems] = useState([]);
  const [pendings, setPendings] = useState([]);
  const [pendingContracts, setPendingContracts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [c, allCoaches, its] = await Promise.all([
          PayoutMonthlyClosing.get(id),
          AssessmentCoach.list('name').catch(() => []),
          PayoutMonthlyStatementItem.filter({ closing_id: id, coach_id: coachId }).catch(() => []),
        ]);
        if (!alive) return;
        setClosing(c);
        setCoach((allCoaches || []).find(co => co.id === coachId) || null);
        setItems(its || []);
        const { data: pend } = await supabase
          .from('payout_pending_repasse')
          .select('*')
          .eq('detected_in_closing_id', id)
          .eq('coach_id', coachId)
          .eq('status', 'open');
        if (!alive) return;
        setPendings(pend || []);
        const cids = [...new Set((pend || []).map(p => p.contract_id))];
        if (cids.length) {
          const { data: cts } = await supabase
            .from('assessment_contracts').select('id, due_date').in('id', cids);
          if (alive) setPendingContracts(cts || []);
        }
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    return () => { alive = false; };
  }, [id, coachId]);

  if (loading) return <div style={{ padding: 48, textAlign: 'center', color: '#94a3b8' }}>Carregando extrato...</div>;
  if (!closing || !coach) return <div style={{ padding: 48, textAlign: 'center', color: '#94a3b8' }}>Extrato não encontrado.</div>;

  const competence = closing.competence;
  const mesLabel = formatCompetence(competence);
  const currentItems = items.filter(i => !i.reference_competence || i.reference_competence === competence);
  const carriedItems = items.filter(i => i.reference_competence && i.reference_competence !== competence);
  const total = items.reduce((s, i) => s + Number(i.amount), 0);

  const todayStr = new Date().toISOString().slice(0, 10);
  const dueByContract = Object.fromEntries(pendingContracts.map(c => [c.id, c.due_date]));
  const pendingTotal = pendings.reduce((s, p) => s + Number(p.amount), 0);

  return (
    <div style={{ background: '#f1f5f9', minHeight: '100vh', padding: '24px 12px' }}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .statement-page { box-shadow: none !important; margin: 0 !important; }
          @page { margin: 1.2cm; }
        }
      `}</style>

      {/* Barra de ações (some na impressão) */}
      <div className="no-print" style={{ maxWidth: 720, margin: '0 auto 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button
          onClick={() => navigate(`/assessoria/fechamento/${id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#475569', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          <ArrowLeft style={{ width: 16, height: 16 }} /> Voltar ao fechamento
        </button>
        <button
          onClick={() => window.print()}
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: '#fff', background: '#2563eb', border: 'none', borderRadius: 8, padding: '9px 16px', cursor: 'pointer' }}
        >
          <Printer style={{ width: 16, height: 16 }} /> Imprimir / Salvar PDF
        </button>
      </div>

      {/* Documento */}
      <div className="statement-page" style={{ maxWidth: 720, margin: '0 auto', background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,.08)', overflow: 'hidden' }}>
        {/* Cabeçalho */}
        <div style={{ background: 'linear-gradient(135deg,#1e3a8a,#2563eb)', color: '#fff', padding: '22px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ width: 26, height: 26, background: 'rgba(255,255,255,.2)', borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Zap style={{ width: 15, height: 15 }} />
              </div>
              <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-.01em' }}>Endurance ON</span>
            </div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>Extrato de Repasse</div>
            <div style={{ fontSize: 13, opacity: .85, marginTop: 2, textTransform: 'capitalize' }}>{mesLabel}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, opacity: .8 }}>Total a receber</div>
            <div style={{ fontSize: 26, fontWeight: 800 }}>{formatCurrency(total)}</div>
          </div>
        </div>

        {/* Coach */}
        <div style={{ padding: '16px 28px', borderBottom: '1px solid #eef1f5', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: '#0f172a' }}>{coach.name}</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>{ROLE_LABEL[coach.role] || coach.role}</div>
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', textAlign: 'right' }}>
            Gerado em {formatDate(closing.generated_at?.split('T')[0])}<br />
            Status: {closing.status === 'paid' ? 'Pago' : closing.status === 'approved' ? 'Aprovado' : 'Em revisão'}
          </div>
        </div>

        {/* Recebendo neste mês */}
        <div style={{ padding: '18px 28px 4px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#1e293b', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
            Recebendo neste mês
          </div>
          {currentItems.length === 0 ? (
            <p style={{ fontSize: 13, color: '#94a3b8', padding: '8px 0' }}>Nenhum repasse neste mês.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {currentItems.map(it => (
                  <Row key={it.id} tipo={SOURCE_LABEL[it.source_type] || it.source_type}
                    descricao={it.description}
                    sub={it.valid_days != null ? `${it.valid_days}/${it.month_days} dias · pró-rata ${(Number(it.prorata_factor) * 100).toFixed(0)}%` : null}
                    valor={it.amount} />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Resgatados de meses anteriores */}
        {carriedItems.length > 0 && (
          <div style={{ padding: '14px 28px 4px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#c2410c', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
              Resgatado de meses anteriores
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {carriedItems.map(it => (
                  <Row key={it.id} tipo={SOURCE_LABEL[it.source_type] || it.source_type}
                    descricao={it.description}
                    refLabel={formatCompetence(it.reference_competence, { short: true })}
                    sub={it.valid_days != null ? `${it.valid_days}/${it.month_days} dias · pró-rata ${(Number(it.prorata_factor) * 100).toFixed(0)}%` : null}
                    valor={it.amount} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Total */}
        <div style={{ margin: '10px 28px', padding: '12px 16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#166534' }}>Total a receber neste fechamento</span>
          <span style={{ fontSize: 20, fontWeight: 800, color: '#16a34a' }}>{formatCurrency(total)}</span>
        </div>

        {/* Aguardando pagamento */}
        {pendings.length > 0 && (
          <div style={{ padding: '10px 28px 22px' }}>
            <div style={{ padding: '14px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  Aguardando pagamento
                </span>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#b45309' }}>{formatCurrency(pendingTotal)}</span>
              </div>
              <p style={{ fontSize: 11.5, color: '#a16207', marginBottom: 8 }}>
                Alunos que ainda não pagaram. <b>Não entram neste total</b> — quando pagarem, o valor entra no
                fechamento do mês do pagamento, com a referência de {mesLabel}.
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {pendings.map(p => {
                    const due = dueByContract[p.contract_id];
                    const overdue = due && due < todayStr;
                    return (
                      <tr key={p.id}>
                        <td style={{ padding: '5px 0', width: 70 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: overdue ? '#fee2e2' : '#f1f5f9', color: overdue ? '#b91c1c' : '#64748b' }}>
                            {overdue ? 'vencido' : 'a vencer'}
                          </span>
                        </td>
                        <td style={{ padding: '5px 8px', fontSize: 12.5, color: '#0f172a' }}>
                          <span style={{ color: '#94a3b8' }}>{SOURCE_LABEL[p.source_type] || p.source_type} · </span>{p.description}
                        </td>
                        <td style={{ padding: '5px 0', textAlign: 'right', fontSize: 12.5, fontWeight: 600, color: '#64748b', whiteSpace: 'nowrap' }}>
                          {formatCurrency(p.amount)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Rodapé */}
        <div style={{ padding: '14px 28px', borderTop: '1px solid #eef1f5', fontSize: 10.5, color: '#94a3b8', textAlign: 'center' }}>
          Endurance ON · Assessoria Esportiva — extrato gerado automaticamente. Valores sujeitos a conferência no fechamento oficial.
        </div>
      </div>
    </div>
  );
}
