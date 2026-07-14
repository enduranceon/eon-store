export function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function normalizeCep(value) {
  return onlyDigits(value).slice(0, 8);
}

export function formatCep(value) {
  const digits = normalizeCep(value);
  if (digits.length <= 5) return digits;
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

export async function lookupCepAddress(value) {
  const cep = normalizeCep(value);
  if (cep.length !== 8) throw new Error('Informe um CEP com 8 dígitos');

  const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
  if (!res.ok) throw new Error('Não foi possível consultar o CEP');

  const data = await res.json();
  if (data?.erro) throw new Error('CEP não encontrado');

  return {
    zip: data.cep || formatCep(cep),
    street: data.logradouro || '',
    complement: data.complemento || '',
    neighborhood: data.bairro || '',
    city: data.localidade || '',
    state: data.uf || '',
  };
}

export function formatCustomerAddress(customer = {}) {
  const line1 = [
    customer.address_street,
    customer.address_number ? `n. ${customer.address_number}` : '',
  ].filter(Boolean).join(', ');
  const line2 = [
    customer.address_complement,
    customer.address_neighborhood,
  ].filter(Boolean).join(' - ');
  const cityState = [
    customer.address_city,
    customer.address_state,
  ].filter(Boolean).join('/');
  return [line1, line2, cityState, customer.address_zip ? `CEP ${formatCep(customer.address_zip)}` : '']
    .filter(Boolean)
    .join(' - ');
}
