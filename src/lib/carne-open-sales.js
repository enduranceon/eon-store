// Carnê de boleto/PIX parcelado nas vendas em aberto: cada parcela ainda não
// registrada vira uma linha, com o valor, o vencimento e o link dela. A linha
// do contrato fica de fora da lista de cobrança (o saldo está nas parcelas) e
// continua existindo para identificar os recebimentos já registrados.

const GONE_IN_ASAAS = new Set(['DELETED', 'REFUNDED']);
const PAID_IN_ASAAS = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);

const byNumber = (a, b) => a.installment_number - b.installment_number;

// Parcelas que ainda são saldo: sem pagamento registrado e não removidas nem
// estornadas no Asaas.
export function carneOpenParcels(parcels) {
  return (parcels || [])
    .filter(parcel => !parcel.payment_row_id && !GONE_IN_ASAAS.has(String(parcel.asaas_status)))
    .sort(byNumber);
}

// Anexa o carnê (todas as parcelas e as em aberto) às linhas dos contratos que
// têm parcelas importadas.
export function attachCarneToContracts(contractRows, parcels) {
  const byContract = new Map();
  for (const parcel of parcels || []) {
    if (!byContract.has(parcel.contract_id)) byContract.set(parcel.contract_id, []);
    byContract.get(parcel.contract_id).push(parcel);
  }
  return (contractRows || []).map(row => {
    const list = byContract.get(row.id);
    if (!list?.length) return row;
    const sorted = [...list].sort(byNumber);
    return { ...row, carne: { parcels: sorted, open: carneOpenParcels(sorted) } };
  });
}

// Uma linha de venda em aberto por parcela em aberto do contrato.
export function carneParcelRows(contractRow) {
  if (!contractRow?.carne) return [];
  return contractRow.carne.open.map(parcel => ({
    ...contractRow,
    carne: null,
    is_carne_parcel: true,
    carne_parcel: {
      id: parcel.id,
      number: parcel.installment_number,
      total: parcel.total_installments,
      invoice_url: parcel.invoice_url || null,
      paid_in_asaas: PAID_IN_ASAAS.has(String(parcel.asaas_status)),
    },
    list_key: `carne-parcel:${parcel.id}`,
    order_number: `${contractRow.order_number} · parcela ${parcel.installment_number}/${parcel.total_installments}`,
    total_value: Number(parcel.value) || 0,
    due_date: parcel.due_date,
    payment_date: null,
    external_payment_link: parcel.invoice_url || contractRow.external_payment_link || null,
  }));
}

// Contratos com carnê que ainda têm parcela em aberto: seguem na conferência
// de Cobranças mesmo "pagos parcialmente".
export function carneContractsToCheck(orders) {
  return (orders || []).filter(order => order?.carne?.open?.length > 0);
}

// Lista da conferência: as vendas abertas de sempre (sem as linhas de parcela,
// que repetiriam o contrato) mais os carnês com parcela em aberto.
export function asaasCheckOrders(activeOrders, orders) {
  const seen = new Set();
  const list = [];
  for (const order of [
    ...(activeOrders || []).filter(order => !order.is_carne_parcel),
    ...carneContractsToCheck(orders),
  ]) {
    const key = `${order.type}:${order.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(order);
  }
  return list;
}
