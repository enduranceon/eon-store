import { formatCurrency } from '@/lib/utils';

// Previa do extrato em HTML.
//
// PORQUE HTML e nao <PDFViewer>: o PDFViewer monta um <iframe src="blob:"> e
// depende do leitor de PDF embutido do navegador. Em varias configuracoes ele
// nao desenha nada - o PDF sai integro, mas a tela vira um retangulo preto sem
// explicacao (reproduzido em 04/08/2026 num ambiente limpo, sem CSP, com um PDF
// de uma linha: blob valido %PDF-1.3, iframe dimensionado, zero erro no console
// e mesmo assim nada aparecia). O HTML sempre renderiza.
//
// Recebe o mesmo objeto `view` que alimenta o StatementDocument (o PDF), entao
// tela e arquivo nao podem divergir.

const shortDate = (value) => {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text.slice(8, 10)}/${text.slice(5, 7)}/${text.slice(0, 4)}` : '—';
};

const KPIS = [
  { key: 'baseStart', label: 'Alunos no início', sub: 'contratos vigentes', color: '#0f172a' },
  { key: 'entries', label: 'Entradas', sub: 'novos alunos', color: '#16a34a', sign: '+' },
  { key: 'returns', label: 'Retornos', sub: 'ex-alunos que voltaram', color: '#ea580c', sign: '+' },
  { key: 'exits', label: 'Saídas', sub: 'saídas reais', color: '#dc2626', sign: '−' },
  { key: 'renewals', label: 'Renovações', sub: 'renovaram no mês', color: '#7c3aed' },
  { key: 'baseEnd', label: 'Alunos no fim', sub: 'contratos vigentes', color: '#2563eb' },
];

const MOVE_COLORS = { Entrada: '#15803d', Retorno: '#c2410c', Saída: '#b91c1c' };

const cell = { padding: '6px 6px', borderBottom: '1px solid #eef2f7' };
const numCell = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

function SectionTitle({ color, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '18px 0 6px' }}>
      <span style={{ width: 3, height: 13, borderRadius: 2, background: color, display: 'inline-block' }} />
      <strong style={{ fontSize: 13, color: '#0f172a' }}>{children}</strong>
    </div>
  );
}

// Mesma primeira página do PDF: o mês do coach em números.
function Panorama({ v }) {
  const p = v.panorama;
  if (!p) return null;
  const movimento = [
    ...p.entradas.map((row) => ['Entrada', row]),
    ...p.retornos.map((row) => ['Retorno', row]),
    ...p.saidas.map((row) => ['Saída', row]),
  ];
  return (
    <div style={{ marginBottom: 22, paddingBottom: 18, borderBottom: '2px dashed #e2e8f0' }}>
      <SectionTitle color="#2563eb">Panorama de {v.mesLabel}{p.partial ? ` (até ${shortDate(p.to)})` : ''}</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
        {KPIS.map((kpi) => {
          const value = Number(p.kpis[kpi.key]) || 0;
          return (
            <div key={kpi.key} style={{ background: '#fbfcfe', border: '1px solid #e6ebf2', borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 10.5, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>{kpi.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: kpi.color }}>{kpi.sign && value ? kpi.sign : ''}{value}</div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>{kpi.sub}</div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 12, color: '#475569', marginTop: 8 }}>
        Saldo do mês: <b>{p.kpis.net > 0 ? '+' : ''}{p.kpis.net}</b> · Churn: <b>{(Number(p.kpis.churnRate) || 0).toFixed(1).replace('.', ',')}%</b> (saídas ÷ alunos no início)
      </div>

      {p.modalidades.length > 0 && (
        <>
          <SectionTitle color="#0e7490">Por modalidade</SectionTitle>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: '#64748b', fontSize: 11 }}>
                  <th style={{ ...cell, textAlign: 'left' }}>Modalidade</th>
                  <th style={numCell}>Início</th><th style={numCell}>Entradas</th><th style={numCell}>Retornos</th>
                  <th style={numCell}>Saídas</th><th style={numCell}>Fim</th><th style={numCell}>Repasse</th>
                </tr>
              </thead>
              <tbody>
                {p.modalidades.map((row) => (
                  <tr key={row.modalidade}>
                    <td style={{ ...cell, textTransform: 'capitalize' }}>{row.modalidade}</td>
                    <td style={numCell}>{row.baseStart}</td><td style={numCell}>{row.entries}</td><td style={numCell}>{row.returns}</td>
                    <td style={numCell}>{row.exits}</td><td style={numCell}>{row.baseEnd}</td>
                    <td style={{ ...numCell, fontWeight: 700 }}>{formatCurrency(row.repasse)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <SectionTitle color="#16a34a">Quem entrou e quem saiu ({movimento.length})</SectionTitle>
      {movimento.length === 0 ? (
        <div style={{ fontSize: 12.5, color: '#64748b' }}>Nenhuma entrada, retorno ou saída no mês.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <tbody>
            {movimento.map(([tipo, row]) => (
              <tr key={`${tipo}:${row.aluno}:${row.data}`}>
                <td style={{ ...cell, width: 80, fontWeight: 700, color: MOVE_COLORS[tipo] }}>{tipo}</td>
                <td style={cell}>{row.aluno}</td>
                <td style={{ ...cell, color: '#475569', textTransform: 'capitalize' }}>{row.modalidade || '—'}</td>
                <td style={{ ...numCell, color: '#64748b', width: 90 }}>{shortDate(row.data)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {v.composicao?.length > 0 && (
        <>
          <SectionTitle color="#166534">Composição do repasse</SectionTitle>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <tbody>
              {v.composicao.map((row) => (
                <tr key={row.label}>
                  <td style={cell}>{row.label}</td>
                  <td style={{ ...numCell, fontWeight: 600, color: row.valor < 0 ? '#b91c1c' : '#0f172a' }}>{formatCurrency(row.valor)}</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...cell, fontWeight: 700 }}>Total a receber</td>
                <td style={{ ...numCell, fontWeight: 700, color: '#16a34a' }}>{formatCurrency(v.total)}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

export default function StatementPreview({ view: v }) {
  if (!v) return null;
  return (
  <div className="coach-statement-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 16px' }}>
    <div className="coach-statement-sheet" style={{ maxWidth: 820, margin: '0 auto', background: '#fff', borderRadius: 12, padding: 28, color: '#1e293b' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 1.2, color: '#2563eb', fontWeight: 700 }}>ENDURANCE ON</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f172a', margin: '4px 0 0' }}>Extrato de Repasse</h1>
          <div style={{ fontSize: 13, color: '#64748b', textTransform: 'capitalize' }}>{v.mesLabel}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10.5, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>Total a receber</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#16a34a' }}>{formatCurrency(v.total)}</div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                    background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, margin: '16px 0' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{v.coach?.name}</div>
          <div style={{ fontSize: 12, color: '#64748b', textTransform: 'capitalize' }}>{v.coach?.role}</div>
        </div>
        <div style={{ fontSize: 11.5, color: '#94a3b8', textAlign: 'right' }}>
          Gerado em {v.generatedAt}<br />Situação: {v.statusLabel}
        </div>
      </div>

      <Panorama v={v} />

      <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', margin: '4px 0 2px' }}>Detalhamento do repasse</div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>Alunos em ordem alfabética.</div>

      {[
        { titulo: `Alunos (${v.alunos.length})`, cor: '#2563eb', lista: v.alunos },
        { titulo: `Liderança e co-liderança (${v.liderancas.length})`, cor: '#7c3aed', lista: v.liderancas },
        { titulo: `Resgatado de meses anteriores (${v.resgatados.length})`, cor: '#ea580c', lista: v.resgatados },
      ].filter((s) => s.lista.length > 0).map((s) => (
        <div key={s.titulo} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ width: 3, height: 13, borderRadius: 2, background: s.cor, display: 'inline-block' }} />
            <strong style={{ fontSize: 13, color: '#0f172a' }}>{s.titulo}</strong>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {s.lista.map((it) => (
                <tr key={it.id} style={{ borderBottom: '1px solid #eef2f7' }}>
                  <td style={{ padding: '6px 0' }}>
                    {it.aluno}
                    {it.refLabel && (
                      <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: '#c2410c',
                                     background: '#ffedd5', padding: '1px 5px', borderRadius: 6 }}>ref. {it.refLabel}</span>
                    )}
                    {it.licenca && (
                      <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: '#0369a1',
                                     background: '#e0f2fe', padding: '1px 5px', borderRadius: 6 }}>
                        em licença {it.licenca.ate ? `${it.licenca.desde} a ${it.licenca.ate}` : `desde ${it.licenca.desde}`}
                      </span>
                    )}
                    {it.source_type !== 'athlete_repasse' && (
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{it.tipoLabel}{it.sobre ? ` · sobre ${it.sobre}` : ''}</div>
                    )}
                  </td>
                  <td style={{ padding: '6px 0', color: '#475569', textTransform: 'capitalize', width: 110 }}>{it.modalidade || '—'}</td>
                  <td style={{ padding: '6px 0', color: '#94a3b8', fontSize: 11.5, textAlign: 'right', width: 110 }}>
                    {it.valid_days != null ? `${it.valid_days}/${it.month_days}d · ${(Number(it.prorata_factor) * 100).toFixed(0)}%` : ''}
                  </td>
                  <td style={{ padding: '6px 0', fontWeight: 700, textAlign: 'right', width: 90 }}>{formatCurrency(it.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {[
        { titulo: `Repasse extra e descontos (${(v.extras || []).length})`, cor: '#059669', lista: v.extras || [] },
        { titulo: `Gastos e reembolsos (${(v.gastos || []).length})`, cor: '#d97706', lista: v.gastos || [] },
      ].filter((s) => s.lista.length > 0).map((s) => (
        <div key={s.titulo} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ width: 3, height: 13, borderRadius: 2, background: s.cor, display: 'inline-block' }} />
            <strong style={{ fontSize: 13, color: '#0f172a' }}>{s.titulo}</strong>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {s.lista.map((a) => (
                <tr key={a.id} style={{ borderBottom: '1px solid #eef2f7' }}>
                  <td style={{ padding: '6px 0' }}>
                    {a.categoria}
                    {(a.descricao || a.reason) && (
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{[a.descricao, a.reason].filter(Boolean).join(' · ')}</div>
                    )}
                  </td>
                  <td style={{ padding: '6px 0', fontWeight: 700, textAlign: 'right', width: 90,
                               color: a.amount < 0 ? '#b91c1c' : '#0f172a' }}>{formatCurrency(a.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: 14, marginTop: 16 }}>
        <strong style={{ color: '#166534', fontSize: 14 }}>Total a receber neste fechamento</strong>
        <strong style={{ color: '#16a34a', fontSize: 19 }}>{formatCurrency(v.total)}</strong>
      </div>

      {v.emLicencaIntegral?.length > 0 && (
        <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: 14, marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ color: '#075985', fontSize: 13 }}>Alunos em licença ({v.emLicencaIntegral.length})</strong>
            <strong style={{ color: '#0369a1' }}>{formatCurrency(0)}</strong>
          </div>
          <p style={{ fontSize: 11.5, color: '#0369a1', margin: '4px 0 8px' }}>
            Afastados durante todo o mês — não geram repasse nesta competência, mas continuam
            na sua carteira. Quando voltarem, os dias voltam a contar automaticamente.
          </p>
          {v.emLicencaIntegral.map((a) => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid #e0f2fe' }}>
              <span style={{ flex: 1, fontSize: 13 }}>
                {a.aluno}
                {a.modalidade && <span style={{ color: '#94a3b8', textTransform: 'capitalize' }}> · {a.modalidade}</span>}
              </span>
              <span style={{ fontSize: 11, color: '#0369a1', fontWeight: 700 }}>
                {a.licenca?.ate ? `${a.licenca.desde} a ${a.licenca.ate}` : `desde ${a.licenca?.desde}`}
              </span>
              <span style={{ fontSize: 13, color: '#64748b', width: 70, textAlign: 'right' }}>{formatCurrency(0)}</span>
            </div>
          ))}
        </div>
      )}

      {v.pendings.length > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 14, marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ color: '#92400e', fontSize: 13 }}>Aguardando pagamento ({v.pendings.length})</strong>
            <strong style={{ color: '#b45309' }}>
              {formatCurrency(v.pendings.reduce((a, p) => a + Number(p.amount), 0))}
            </strong>
          </div>
          <p style={{ fontSize: 11.5, color: '#a16207', margin: '4px 0 8px' }}>
            Alunos que ainda não pagaram — não entram neste total. Quando pagarem, o repasse entra
            no fechamento do mês do pagamento, com a referência de {v.mesLabel}.
          </p>
          {v.pendings.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderTop: '1px solid #fef3c7' }}>
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 8,
                             background: p.overdue ? '#fee2e2' : '#f1f5f9', color: p.overdue ? '#b91c1c' : '#64748b' }}>
                {p.overdue ? 'vencido' : 'a vencer'}
              </span>
              <span style={{ flex: 1, fontSize: 13 }}>{p.aluno}</span>
              <span style={{ fontSize: 13, color: '#64748b' }}>{formatCurrency(p.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
  );
}
