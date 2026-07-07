import {
  Document, Page, Text, View, StyleSheet,
} from '@react-pdf/renderer';

const ROLE_LABEL = { junior: 'Junior', pleno: 'Pleno', senior: 'Senior' };
const money = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);

const MOD_COLOR = { corrida: '#2563eb', triathlon: '#ea580c', 'natação': '#0891b2', natacao: '#0891b2', ciclismo: '#16a34a' };
const modColor = (m) => MOD_COLOR[(m || '').toLowerCase()] || '#64748b';

const s = StyleSheet.create({
  page: { paddingTop: 32, paddingBottom: 46, paddingHorizontal: 34, fontSize: 9.5, color: '#1e293b', fontFamily: 'Helvetica' },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  brand: { fontSize: 8, letterSpacing: 1.2, color: '#2563eb', fontFamily: 'Helvetica-Bold' },
  title: { fontSize: 19, fontFamily: 'Helvetica-Bold', color: '#0f172a', marginTop: 3 },
  period: { fontSize: 10, color: '#64748b', marginTop: 1 },
  headTotalLabel: { fontSize: 7.5, color: '#94a3b8', textAlign: 'right', textTransform: 'uppercase', letterSpacing: 0.5 },
  headTotalValue: { fontSize: 19, fontFamily: 'Helvetica-Bold', color: '#16a34a', textAlign: 'right' },

  coachBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#f8fafc', border: '1 solid #e2e8f0', borderRadius: 6, padding: 11, marginBottom: 14 },
  coachName: { fontSize: 13, fontFamily: 'Helvetica-Bold', color: '#0f172a' },
  coachRole: { fontSize: 8.5, color: '#64748b', marginTop: 1 },
  meta: { fontSize: 8, color: '#94a3b8', textAlign: 'right', lineHeight: 1.4 },

  modRow: { flexDirection: 'row', marginBottom: 18 },
  modCard: { flex: 1, backgroundColor: '#fbfcfe', border: '1 solid #e6ebf2', borderRadius: 7, padding: 10 },
  modAccent: { width: 22, height: 3, borderRadius: 2, marginBottom: 6 },
  modName: { fontSize: 7.5, color: '#64748b', textTransform: 'capitalize', letterSpacing: 0.3, fontFamily: 'Helvetica-Bold' },
  modValue: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: '#0f172a', marginTop: 3 },
  modSub: { fontSize: 7.5, color: '#94a3b8', marginTop: 2 },

  sectionTitle: { fontSize: 9.5, fontFamily: 'Helvetica-Bold', color: '#0f172a', marginBottom: 6, marginTop: 6 },
  sectionAccent: { width: 3, height: 11, borderRadius: 2, marginRight: 6 },
  sectionHead: { flexDirection: 'row', alignItems: 'center' },

  th: { flexDirection: 'row', borderBottom: '1 solid #cbd5e1', paddingBottom: 3, marginBottom: 1 },
  thText: { fontSize: 7, color: '#94a3b8', fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', letterSpacing: 0.5 },
  tr: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4.5, borderBottom: '0.5 solid #eef2f7' },
  cellPrimary: { fontSize: 9.5, color: '#0f172a' },
  cellSub: { fontSize: 7.5, color: '#94a3b8', marginTop: 1 },
  cellMuted: { fontSize: 9, color: '#475569' },
  cellValue: { fontSize: 9.5, fontFamily: 'Helvetica-Bold', color: '#0f172a', textAlign: 'right' },

  subtotalRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingTop: 4 },
  subtotalLabel: { fontSize: 8, color: '#64748b', marginRight: 10 },
  subtotalValue: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#334155', width: 66, textAlign: 'right' },

  grandTotal: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#f0fdf4', border: '1 solid #bbf7d0', borderRadius: 7, padding: 12, marginTop: 14, marginBottom: 2 },
  grandLabel: { fontSize: 10.5, fontFamily: 'Helvetica-Bold', color: '#166534' },
  grandValue: { fontSize: 17, fontFamily: 'Helvetica-Bold', color: '#16a34a' },

  pendBox: { backgroundColor: '#fffbeb', border: '1 solid #fde68a', borderRadius: 7, padding: 12, marginTop: 16 },
  pendHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  pendTitle: { fontSize: 9.5, fontFamily: 'Helvetica-Bold', color: '#92400e' },
  pendTotal: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#b45309' },
  pendNote: { fontSize: 8, color: '#a16207', marginBottom: 4, lineHeight: 1.4 },
  pendSubhead: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: '#b45309', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 8, marginBottom: 1 },
  pendRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3.5, borderBottom: '0.5 solid #fef3c7' },
  chip: { fontSize: 6.5, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', letterSpacing: 0.4, paddingVertical: 2, paddingHorizontal: 5, borderRadius: 8, overflow: 'hidden', textAlign: 'center' },

  refTag: { fontSize: 6.5, fontFamily: 'Helvetica-Bold', color: '#c2410c', backgroundColor: '#ffedd5', paddingVertical: 1.5, paddingHorizontal: 4, borderRadius: 6, marginTop: 2, alignSelf: 'flex-start' },

  footer: { position: 'absolute', bottom: 22, left: 34, right: 34, textAlign: 'center', fontSize: 7.5, color: '#cbd5e1', borderTop: '0.5 solid #e2e8f0', paddingTop: 6 },
});

function AthleteRow({ it }) {
  return (
    <View style={s.tr} wrap={false}>
      <View style={{ flex: 1, paddingRight: 6 }}>
        <Text style={s.cellPrimary}>{it.aluno}</Text>
        {it.refLabel && <Text style={s.refTag}>ref. {it.refLabel}</Text>}
      </View>
      <Text style={[s.cellMuted, { width: 88, textTransform: 'capitalize' }]}>{it.modalidade || '—'}</Text>
      <Text style={[s.cellSub, { width: 74, textAlign: 'right', marginTop: 0 }]}>
        {it.valid_days != null ? `${it.valid_days}/${it.month_days}d · ${(Number(it.prorata_factor) * 100).toFixed(0)}%` : ''}
      </Text>
      <Text style={[s.cellValue, { width: 66 }]}>{money(it.amount)}</Text>
    </View>
  );
}

function LeadershipRow({ it }) {
  return (
    <View style={s.tr} wrap={false}>
      <View style={{ flex: 1, paddingRight: 6 }}>
        <Text style={s.cellPrimary}>{it.aluno}</Text>
        <Text style={s.cellSub}>{it.tipoLabel}{it.sobre ? ` · sobre ${it.sobre}` : ''}</Text>
        {it.refLabel && <Text style={s.refTag}>ref. {it.refLabel}</Text>}
      </View>
      <Text style={[s.cellValue, { width: 66 }]}>{money(it.amount)}</Text>
    </View>
  );
}

function PendRow({ p }) {
  return (
    <View style={s.pendRow} wrap={false}>
      <Text style={[s.chip, { width: 46, backgroundColor: p.overdue ? '#fee2e2' : '#f1f5f9', color: p.overdue ? '#b91c1c' : '#64748b' }]}>
        {p.overdue ? 'vencido' : 'a vencer'}
      </Text>
      <View style={{ flex: 1, paddingLeft: 8 }}>
        <Text style={s.cellPrimary}>{p.aluno}</Text>
        <Text style={s.cellSub}>{p.tipoLabel}{p.sobre ? ` · sobre ${p.sobre}` : ''}{p.modalidade ? ` · ${p.modalidade}` : ''}</Text>
      </View>
      <Text style={[s.cellMuted, { width: 66, textAlign: 'right' }]}>{money(p.amount)}</Text>
    </View>
  );
}

function Section({ accent, title, children }) {
  return (
    <View style={{ marginBottom: 10 }} wrap={false}>
      <View style={s.sectionHead}>
        <View style={[s.sectionAccent, { backgroundColor: accent }]} />
        <Text style={s.sectionTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

export default function StatementDocument({ coach, mesLabel, generatedAt, statusLabel, porModalidade = [], alunos, liderancas, resgatados, pendings, total }) {
  const subAlunos = alunos.reduce((a, i) => a + Number(i.amount), 0);
  const subLideranca = liderancas.reduce((a, i) => a + Number(i.amount), 0);
  const subResgatado = resgatados.reduce((a, i) => a + Number(i.amount), 0);
  const pendTotal = pendings.reduce((a, p) => a + Number(p.amount), 0);
  const pendAlunos = pendings.filter((p) => p.source_type === 'athlete_repasse');
  const pendLideranca = pendings.filter((p) => p.source_type !== 'athlete_repasse');

  return (
    <Document title={`Extrato ${coach?.name || ''} ${mesLabel}`} author="Endurance ON">
      <Page size="A4" style={s.page}>
        <View style={s.headerRow}>
          <View>
            <Text style={s.brand}>ENDURANCE ON</Text>
            <Text style={s.title}>Extrato de Repasse</Text>
            <Text style={s.period}>{mesLabel}</Text>
          </View>
          <View>
            <Text style={s.headTotalLabel}>Total a receber</Text>
            <Text style={s.headTotalValue}>{money(total)}</Text>
          </View>
        </View>

        <View style={s.coachBar}>
          <View>
            <Text style={s.coachName}>{coach?.name || '—'}</Text>
            <Text style={s.coachRole}>{ROLE_LABEL[coach?.role] || coach?.role || ''}</Text>
          </View>
          <Text style={s.meta}>Gerado em {generatedAt}{'\n'}Situação: {statusLabel}</Text>
        </View>

        {/* Resumo por modalidade */}
        {porModalidade.length > 0 && (
          <View style={s.modRow}>
            {porModalidade.map((m, idx) => (
              <View key={m.modalidade} style={[s.modCard, { marginRight: idx < porModalidade.length - 1 ? 8 : 0 }]}>
                <View style={[s.modAccent, { backgroundColor: modColor(m.modalidade) }]} />
                <Text style={s.modName}>{m.modalidade}</Text>
                <Text style={s.modValue}>{money(m.total)}</Text>
                <Text style={s.modSub}>{m.alunos} {m.alunos === 1 ? 'aluno' : 'alunos'}</Text>
              </View>
            ))}
          </View>
        )}

        {alunos.length > 0 && (
          <Section accent="#2563eb" title={`Alunos (${alunos.length})`}>
            <View style={s.th}>
              <Text style={[s.thText, { flex: 1 }]}>Aluno</Text>
              <Text style={[s.thText, { width: 88 }]}>Modalidade</Text>
              <Text style={[s.thText, { width: 74, textAlign: 'right' }]}>Período</Text>
              <Text style={[s.thText, { width: 66, textAlign: 'right' }]}>Valor</Text>
            </View>
            {alunos.map((it) => <AthleteRow key={it.id} it={it} />)}
            <View style={s.subtotalRow}>
              <Text style={s.subtotalLabel}>Subtotal alunos</Text>
              <Text style={s.subtotalValue}>{money(subAlunos)}</Text>
            </View>
          </Section>
        )}

        {liderancas.length > 0 && (
          <Section accent="#7c3aed" title={`Liderança e co-liderança (${liderancas.length})`}>
            <View style={s.th}>
              <Text style={[s.thText, { flex: 1 }]}>Aluno / relação</Text>
              <Text style={[s.thText, { width: 66, textAlign: 'right' }]}>Valor</Text>
            </View>
            {liderancas.map((it) => <LeadershipRow key={it.id} it={it} />)}
            <View style={s.subtotalRow}>
              <Text style={s.subtotalLabel}>Subtotal liderança</Text>
              <Text style={s.subtotalValue}>{money(subLideranca)}</Text>
            </View>
          </Section>
        )}

        {resgatados.length > 0 && (
          <Section accent="#ea580c" title={`Resgatado de meses anteriores (${resgatados.length})`}>
            {resgatados.map((it) => (
              it.source_type === 'athlete_repasse'
                ? <AthleteRow key={it.id} it={it} />
                : <LeadershipRow key={it.id} it={it} />
            ))}
            <View style={s.subtotalRow}>
              <Text style={s.subtotalLabel}>Subtotal resgatado</Text>
              <Text style={s.subtotalValue}>{money(subResgatado)}</Text>
            </View>
          </Section>
        )}

        <View style={s.grandTotal}>
          <Text style={s.grandLabel}>Total a receber neste fechamento</Text>
          <Text style={s.grandValue}>{money(total)}</Text>
        </View>

        {pendings.length > 0 && (
          <View style={s.pendBox}>
            <View style={s.pendHead}>
              <Text style={s.pendTitle}>Aguardando pagamento ({pendings.length})</Text>
              <Text style={s.pendTotal}>{money(pendTotal)}</Text>
            </View>
            <Text style={s.pendNote}>
              Alunos que ainda não pagaram — não entram neste total. Quando pagarem, o repasse entra
              no fechamento do mês do pagamento, com a referência de {mesLabel}.
            </Text>
            {pendAlunos.length > 0 && (
              <View>
                <Text style={s.pendSubhead}>Alunos ({pendAlunos.length})</Text>
                {pendAlunos.map((p) => <PendRow key={p.id} p={p} />)}
              </View>
            )}
            {pendLideranca.length > 0 && (
              <View>
                <Text style={s.pendSubhead}>Liderança ({pendLideranca.length})</Text>
                {pendLideranca.map((p) => <PendRow key={p.id} p={p} />)}
              </View>
            )}
          </View>
        )}

        <Text style={s.footer} fixed>
          Endurance ON · Assessoria Esportiva — extrato gerado automaticamente. Valores sujeitos a conferência no fechamento oficial.
        </Text>
      </Page>
    </Document>
  );
}
