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

export default function StatementPreview({ view: v }) {
  if (!v) return null;
  return (
  <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 16px' }}>
    <div style={{ maxWidth: 820, margin: '0 auto', background: '#fff', borderRadius: 12, padding: 28, color: '#1e293b' }}>
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

      {v.porModalidade.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
          {v.porModalidade.map((m) => (
            <div key={m.modalidade} style={{ flex: '1 1 140px', background: '#fbfcfe', border: '1px solid #e6ebf2', borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'capitalize' }}>{m.modalidade}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>{formatCurrency(m.total)}</div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>{m.alunos} {m.alunos === 1 ? 'aluno' : 'alunos'}</div>
            </div>
          ))}
        </div>
      )}

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

      {v.ajustes.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ width: 3, height: 13, borderRadius: 2, background: '#d97706', display: 'inline-block' }} />
            <strong style={{ fontSize: 13, color: '#0f172a' }}>Ajustes e reembolsos ({v.ajustes.length})</strong>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {v.ajustes.map((a) => (
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
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: 14, marginTop: 16 }}>
        <strong style={{ color: '#166534', fontSize: 14 }}>Total a receber neste fechamento</strong>
        <strong style={{ color: '#16a34a', fontSize: 19 }}>{formatCurrency(v.total)}</strong>
      </div>

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
