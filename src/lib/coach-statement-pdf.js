import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

const money = (value) => new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
}).format(Number(value) || 0);

const safe = (value) => (value == null || value === '' ? '-' : String(value));

const shortDate = (value) => {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text.slice(8, 10)}/${text.slice(5, 7)}/${text.slice(0, 4)}` : '-';
};

const percent = (value) => `${(Number(value) || 0).toFixed(1).replace('.', ',')}%`;

const signed = (value) => (value > 0 ? `+${value}` : String(value));

function addFooter(doc) {
  const pageCount = doc.internal.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    const width = doc.internal.pageSize.getWidth();
    const height = doc.internal.pageSize.getHeight();
    doc.setDrawColor(226, 232, 240);
    doc.line(40, height - 36, width - 40, height - 36);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    doc.text('Endurance ON - extrato gerado automaticamente pelo fechamento oficial.', 40, height - 20);
    doc.text(`${page}/${pageCount}`, width - 40, height - 20, { align: 'right' });
  }
}

function sectionTitle(doc, title, y, color = [37, 99, 235]) {
  doc.setFillColor(...color);
  doc.roundedRect(40, y - 9, 3, 12, 1, 1, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text(title, 49, y);
}

function drawRowsSection(doc, { title, y, color, head, body, foot, columnStyles }) {
  if (!body.length) return y;
  if (y > 740) {
    doc.addPage();
    y = 44;
  }
  sectionTitle(doc, title, y, color);
  autoTable(doc, {
    columnStyles,
    startY: y + 8,
    head: [head],
    body,
    foot: foot ? [foot] : undefined,
    theme: 'grid',
    margin: { left: 40, right: 40, bottom: 48 },
    styles: {
      font: 'helvetica',
      fontSize: 8.5,
      cellPadding: { top: 4, right: 5, bottom: 4, left: 5 },
      lineColor: [226, 232, 240],
      lineWidth: 0.5,
      overflow: 'linebreak',
      valign: 'middle',
    },
    headStyles: {
      fillColor: [248, 250, 252],
      textColor: [100, 116, 139],
      fontStyle: 'bold',
      lineColor: [203, 213, 225],
    },
    footStyles: {
      fillColor: [248, 250, 252],
      textColor: [15, 23, 42],
      fontStyle: 'bold',
    },
    alternateRowStyles: { fillColor: [252, 253, 255] },
  });
  return doc.lastAutoTable.finalY + 18;
}

const KPI_CARDS = [
  { key: 'baseStart', label: 'ALUNOS NO INICIO', sub: 'contratos vigentes', color: [15, 23, 42] },
  { key: 'entries', label: 'ENTRADAS', sub: 'novos alunos', color: [22, 163, 74], sign: '+' },
  { key: 'returns', label: 'RETORNOS', sub: 'ex-alunos que voltaram', color: [234, 88, 12], sign: '+' },
  { key: 'exits', label: 'SAIDAS', sub: 'saidas reais', color: [220, 38, 38], sign: '-' },
  { key: 'renewals', label: 'RENOVACOES', sub: 'renovaram no mes', color: [124, 58, 237] },
  { key: 'baseEnd', label: 'ALUNOS NO FIM', sub: 'contratos vigentes', color: [37, 99, 235] },
];

const TABLE_STYLE = {
  theme: 'grid',
  margin: { left: 40, right: 40, bottom: 48 },
  styles: {
    font: 'helvetica', fontSize: 8.5, cellPadding: { top: 4, right: 5, bottom: 4, left: 5 },
    lineColor: [226, 232, 240], lineWidth: 0.5, overflow: 'linebreak', valign: 'middle',
  },
  headStyles: { fillColor: [248, 250, 252], textColor: [100, 116, 139], fontStyle: 'bold', lineColor: [203, 213, 225] },
  footStyles: { fillColor: [248, 250, 252], textColor: [15, 23, 42], fontStyle: 'bold' },
};

const right = (content) => ({ content, styles: { halign: 'right' } });

// Título de seção não fica sozinho no pé da página.
function ensureSpace(doc, y, needed = 90) {
  if (y + needed <= doc.internal.pageSize.getHeight() - 50) return y;
  doc.addPage();
  return 44;
}

// Primeira página: o mês do coach em números, por modalidade, quem entrou e
// saiu, e de onde vem o valor a receber.
function drawPanorama(doc, view, y, width) {
  const panorama = view.panorama;
  if (!panorama) return y;
  const k = panorama.kpis;
  sectionTitle(doc, `Panorama de ${view.mesLabel}${panorama.partial ? ` (ate ${shortDate(panorama.to)})` : ''}`, y);
  y += 12;

  const gap = 8;
  const cardWidth = (width - 80 - gap * 2) / 3;
  KPI_CARDS.forEach((card, index) => {
    const x = 40 + (index % 3) * (cardWidth + gap);
    const top = y + Math.floor(index / 3) * (52 + gap);
    const value = Number(k[card.key]) || 0;
    doc.setFillColor(251, 252, 254);
    doc.setDrawColor(230, 235, 242);
    doc.roundedRect(x, top, cardWidth, 52, 6, 6, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(card.label, x + 10, top + 15);
    doc.setFontSize(16);
    doc.setTextColor(...card.color);
    doc.text(`${card.sign && value ? card.sign : ''}${value}`, x + 10, top + 34);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text(card.sub, x + 10, top + 46);
  });
  y += 2 * 52 + gap + 16;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(`Saldo do mes: ${signed(k.net)} aluno(s)   -   Churn: ${percent(k.churnRate)} (saidas / alunos no inicio)`, 40, y);
  y += 22;

  if (panorama.modalidades?.length) {
    y = ensureSpace(doc, y);
    sectionTitle(doc, 'Por modalidade', y, [14, 116, 144]);
    autoTable(doc, {
      ...TABLE_STYLE,
      startY: y + 8,
      head: [['Modalidade', ...['Inicio', 'Entradas', 'Retornos', 'Saidas', 'Fim', 'Repasse'].map(right)]],
      body: panorama.modalidades.map((row) => [
        safe(row.modalidade), row.baseStart, row.entries, row.returns, row.exits, row.baseEnd, money(row.repasse),
      ]),
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' } },
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  const movimento = [
    ...(panorama.entradas || []).map((row) => ['Entrada', row]),
    ...(panorama.retornos || []).map((row) => ['Retorno', row]),
    ...(panorama.saidas || []).map((row) => ['Saida', row]),
  ];
  y = ensureSpace(doc, y);
  sectionTitle(doc, `Quem entrou e quem saiu (${movimento.length})`, y, [22, 163, 74]);
  if (movimento.length) {
    autoTable(doc, {
      ...TABLE_STYLE,
      startY: y + 8,
      head: [['Movimento', 'Aluno', 'Modalidade', right('Data')]],
      body: movimento.map(([tipo, row]) => [tipo, safe(row.aluno), safe(row.modalidade), shortDate(row.data)]),
      columnStyles: { 3: { halign: 'right' } },
      didParseCell: (cell) => {
        if (cell.section === 'body' && cell.column.index === 0) {
          cell.cell.styles.textColor = cell.cell.raw === 'Saida' ? [185, 28, 28] : cell.cell.raw === 'Retorno' ? [194, 65, 12] : [21, 128, 61];
          cell.cell.styles.fontStyle = 'bold';
        }
      },
    });
    y = doc.lastAutoTable.finalY + 18;
  } else {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text('Nenhuma entrada, retorno ou saida no mes.', 49, y + 16);
    y += 34;
  }

  if (view.composicao?.length) {
    y = ensureSpace(doc, y, 120);
    sectionTitle(doc, 'Composicao do repasse', y, [22, 101, 52]);
    autoTable(doc, {
      ...TABLE_STYLE,
      startY: y + 8,
      head: [['Origem', right('Valor')]],
      body: view.composicao.map((row) => [row.label, money(row.valor)]),
      foot: [['Total a receber', right(money(view.total))]],
      columnStyles: { 1: { halign: 'right' } },
    });
    y = doc.lastAutoTable.finalY + 14;
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(148, 163, 184);
  doc.text(
    doc.splitTextToSize('Alunos no inicio e no fim: contratos vigentes no dia anterior ao mes e no ultimo dia. Saida: cancelamento ou nao renovacao sem outro contrato em ate 45 dias; troca de plano e venda desfeita nao contam.', width - 80),
    40, y,
  );
  return y + 24;
}

export function downloadCoachStatementPdf(view, fileName, title = fileName) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setProperties({
    title,
    subject: `Extrato de repasse - ${view.mesLabel}`,
    author: 'Endurance ON',
    creator: 'EON Store',
  });
  const width = doc.internal.pageSize.getWidth();
  let y = 42;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(37, 99, 235);
  doc.text('ENDURANCE ON', 40, y);

  y += 20;
  doc.setFontSize(21);
  doc.setTextColor(15, 23, 42);
  doc.text('Extrato de Repasse', 40, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(100, 116, 139);
  doc.text(view.mesLabel, 40, y + 16);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text('TOTAL A RECEBER', width - 40, 42, { align: 'right' });
  doc.setFontSize(22);
  doc.setTextColor(22, 163, 74);
  doc.text(money(view.total), width - 40, 68, { align: 'right' });

  y += 46;
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(40, y, width - 80, 54, 6, 6, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42);
  doc.text(safe(view.coach?.name), 54, y + 22);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(safe(view.coach?.role), 54, y + 38);
  doc.setTextColor(148, 163, 184);
  doc.text(`Gerado em ${safe(view.generatedAt)}`, width - 54, y + 22, { align: 'right' });
  doc.text(`Situacao: ${safe(view.statusLabel)}`, width - 54, y + 38, { align: 'right' });

  drawPanorama(doc, view, y + 76, width);

  // Detalhamento em ordem alfabética, a partir da segunda página.
  doc.addPage();
  y = 44;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text('Detalhamento do repasse', 40, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`${safe(view.coach?.name)} - ${view.mesLabel} - alunos em ordem alfabetica`, 40, y + 14);
  y += 40;

  const alunoBody = (view.alunos || []).map((item) => [
    [safe(item.aluno), item.refLabel ? `ref. ${item.refLabel}` : '', item.licenca ? 'em licenca' : ''].filter(Boolean).join('\n'),
    safe(item.modalidade),
    item.valid_days != null ? `${item.valid_days}/${item.month_days}d` : '',
    money(item.amount),
  ]);
  y = drawRowsSection(doc, {
    title: `Alunos (${view.alunos?.length || 0})`,
    y,
    color: [37, 99, 235],
    head: ['Aluno', 'Modalidade', 'Periodo', 'Valor'],
    body: alunoBody,
    foot: ['', '', 'Subtotal', money((view.alunos || []).reduce((sum, item) => sum + Number(item.amount), 0))],
  });

  const liderancaBody = (view.liderancas || []).map((item) => [
    safe(item.aluno),
    [safe(item.tipoLabel), item.sobre ? `sobre ${item.sobre}` : ''].filter(Boolean).join(' - '),
    money(item.amount),
  ]);
  y = drawRowsSection(doc, {
    title: `Lideranca e co-lideranca (${view.liderancas?.length || 0})`,
    y,
    color: [124, 58, 237],
    head: ['Aluno', 'Relacao', 'Valor'],
    body: liderancaBody,
    foot: ['', 'Subtotal', money((view.liderancas || []).reduce((sum, item) => sum + Number(item.amount), 0))],
  });

  const resgatadoBody = (view.resgatados || []).map((item) => [
    safe(item.aluno),
    safe(item.tipoLabel),
    item.refLabel ? `ref. ${item.refLabel}` : '',
    money(item.amount),
  ]);
  y = drawRowsSection(doc, {
    title: `Resgatado de meses anteriores (${view.resgatados?.length || 0})`,
    y,
    color: [234, 88, 12],
    head: ['Aluno', 'Tipo', 'Referencia', 'Valor'],
    body: resgatadoBody,
    foot: ['', '', 'Subtotal', money((view.resgatados || []).reduce((sum, item) => sum + Number(item.amount), 0))],
  });

  // Lançamentos manuais: repasse extra e desconto, depois gasto e reembolso.
  const manualSections = [
    { title: 'Repasse extra e descontos', color: [5, 150, 105], head: ['Tipo', 'Explicacao', 'Valor'], list: view.extras || [] },
    { title: 'Gastos e reembolsos', color: [217, 119, 6], head: ['Categoria', 'Descricao', 'Valor'], list: view.gastos || [] },
  ];
  for (const section of manualSections) {
    y = drawRowsSection(doc, {
      title: `${section.title} (${section.list.length})`,
      y,
      color: section.color,
      head: section.head,
      body: section.list.map((item) => [
        safe(item.categoria),
        [item.descricao, item.reason].filter(Boolean).join(' - '),
        money(item.amount),
      ]),
      foot: ['', 'Subtotal', money(section.list.reduce((sum, item) => sum + Number(item.amount), 0))],
    });
  }

  if (y > 704) {
    doc.addPage();
    y = 44;
  }
  doc.setFillColor(240, 253, 244);
  doc.setDrawColor(187, 247, 208);
  doc.roundedRect(40, y, width - 80, 44, 6, 6, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(22, 101, 52);
  doc.text('Total a receber neste fechamento', 54, y + 27);
  doc.setFontSize(16);
  doc.setTextColor(22, 163, 74);
  doc.text(money(view.total), width - 54, y + 28, { align: 'right' });
  y += 66;

  const licencaBody = (view.emLicencaIntegral || []).map((item) => [
    safe(item.aluno),
    safe(item.modalidade),
    item.licenca?.ate ? `${item.licenca.desde} a ${item.licenca.ate}` : `desde ${safe(item.licenca?.desde)}`,
    money(0),
  ]);
  y = drawRowsSection(doc, {
    title: `Alunos em licenca (${view.emLicencaIntegral?.length || 0})`,
    y,
    color: [3, 105, 161],
    head: ['Aluno', 'Modalidade', 'Periodo', 'Valor'],
    body: licencaBody,
  });

  const pendingBody = (view.pendings || []).map((item) => [
    item.overdue ? 'Vencido' : 'A vencer',
    safe(item.aluno),
    safe(item.tipoLabel),
    money(item.amount),
  ]);
  drawRowsSection(doc, {
    title: `Aguardando pagamento (${view.pendings?.length || 0})`,
    y,
    color: [180, 83, 9],
    head: ['Status', 'Aluno', 'Tipo', 'Valor'],
    body: pendingBody,
    foot: ['', '', 'Total pendente', money((view.pendings || []).reduce((sum, item) => sum + Number(item.amount), 0))],
  });

  addFooter(doc);
  doc.save(fileName);
}
