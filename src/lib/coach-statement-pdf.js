import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

const money = (value) => new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
}).format(Number(value) || 0);

const safe = (value) => (value == null || value === '' ? '-' : String(value));

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

function drawRowsSection(doc, { title, y, color, head, body, foot }) {
  if (!body.length) return y;
  sectionTitle(doc, title, y, color);
  autoTable(doc, {
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

  y += 76;

  if (view.porModalidade?.length) {
    const cardGap = 8;
    const cardWidth = (width - 80 - cardGap * (view.porModalidade.length - 1)) / view.porModalidade.length;
    view.porModalidade.forEach((item, index) => {
      const x = 40 + index * (cardWidth + cardGap);
      doc.setFillColor(251, 252, 254);
      doc.setDrawColor(230, 235, 242);
      doc.roundedRect(x, y, cardWidth, 52, 6, 6, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text(safe(item.modalidade).toUpperCase(), x + 10, y + 17);
      doc.setFontSize(14);
      doc.setTextColor(15, 23, 42);
      doc.text(money(item.total), x + 10, y + 35);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text(`${item.alunos} ${item.alunos === 1 ? 'aluno' : 'alunos'}`, x + 10, y + 46);
    });
    y += 74;
  }

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

  const ajusteBody = (view.ajustes || []).map((item) => [
    safe(item.categoria),
    [item.descricao, item.reason].filter(Boolean).join(' - '),
    money(item.amount),
  ]);
  y = drawRowsSection(doc, {
    title: `Ajustes e reembolsos (${view.ajustes?.length || 0})`,
    y,
    color: [217, 119, 6],
    head: ['Categoria', 'Descricao', 'Valor'],
    body: ajusteBody,
    foot: ['', 'Subtotal', money((view.ajustes || []).reduce((sum, item) => sum + Number(item.amount), 0))],
  });

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
