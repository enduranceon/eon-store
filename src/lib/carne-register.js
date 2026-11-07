// Registra um carnê da conferência de Cobranças: importa as parcelas (se ainda
// não foram importadas) e registra o pagamento de cada parcela paga no Asaas,
// uma de cada vez. A versão do contrato passa de uma chamada para a próxima,
// porque cada uma muda o contrato. Se algo falhar no meio, o que já foi feito
// fica feito e o erro diz até onde chegou; a próxima conferência retoma dali.
export async function registerCarneItem(item, api) {
  const order = item.order;
  let version = order.updated_at;
  let parcels = order.carne?.parcels || [];
  let imported = false;

  if (!item.imported) {
    const result = await api.importContractParcels(order.id, { expectedUpdatedAt: version });
    version = result?.contract?.updated_at ?? version;
    parcels = result?.parcels || [];
    imported = true;
  }

  const done = [];
  for (const row of item.toRecord) {
    const parcel = parcels.find(candidate => candidate.installment_number === row.number);
    try {
      if (!parcel) throw new Error('parcela não encontrada no contrato');
      const result = await api.recordContractParcelPayment(order.id, parcel.id, version);
      version = result?.contract?.updated_at ?? version;
      done.push(row.number);
    } catch (error) {
      const progress = [
        imported ? 'as parcelas foram importadas' : null,
        done.length ? `parcela${done.length > 1 ? 's' : ''} ${done.join(', ')} registrada${done.length > 1 ? 's' : ''}` : null,
      ].filter(Boolean).join('; ');
      const reason = error?.message || 'erro desconhecido';
      throw new Error(
        `Não foi possível registrar a parcela ${row.number}: ${reason}${progress ? ` (${progress})` : ''}.`,
        { cause: error },
      );
    }
  }
  return { imported, recorded: done };
}
