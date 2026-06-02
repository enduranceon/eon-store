// Padrão de SKU: NNNN-SIZE-GENDER
// - NNNN: product_number sequencial (4 dígitos zero-padded)
// - SIZE:  PP/P/M/G/GG/XG ou 34..48 (opcional)
// - GENDER: M=Masculino, F=Feminino, U=Unissex (opcional)
//
// Exemplos:
//   formatSku(42, 'M', 'Masculino')  → '0042-M-M'
//   formatSku(42, 'G', 'Feminino')   → '0042-G-F'
//   formatSku(67, '40', 'Unissex')   → '0067-40-U'
//   formatSku(89)                    → '0089' (sem variação)

const GENDER_TO_CODE = {
  'Masculino': 'M',
  'Feminino':  'F',
  'Unissex':   'U',
};

const CODE_TO_GENDER = {
  M: 'Masculino',
  F: 'Feminino',
  U: 'Unissex',
};

// Formata o número do produto como string de 4 dígitos zero-padded.
export function formatProductNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return '';
  return String(num).padStart(4, '0');
}

// Gera o SKU completo da variação.
export function formatSku(productNumber, size = '', gender = '') {
  const base = formatProductNumber(productNumber);
  if (!base) return '';
  const sz = size ? String(size).trim() : '';
  const g  = GENDER_TO_CODE[gender] || (gender && typeof gender === 'string' && gender.length === 1
    ? gender.toUpperCase()
    : '');
  const parts = [base];
  if (sz) parts.push(sz);
  if (g)  parts.push(g);
  return parts.join('-');
}

// Quebra um SKU em suas partes. Retorna { number, size, gender }.
export function parseSku(sku) {
  if (!sku) return { number: null, size: null, gender: null };
  const parts = String(sku).split('-');
  const number = parts[0] ? parseInt(parts[0], 10) : null;
  return {
    number: Number.isFinite(number) ? number : null,
    size:   parts[1] || null,
    gender: parts[2] ? (CODE_TO_GENDER[parts[2]] || parts[2]) : null,
  };
}

// Converte 'Masculino' → 'M', 'Feminino' → 'F', 'Unissex' → 'U'
export function genderToCode(gender) {
  return GENDER_TO_CODE[gender] || '';
}

// Converte 'M' → 'Masculino', 'F' → 'Feminino', 'U' → 'Unissex'
export function codeToGender(code) {
  return CODE_TO_GENDER[code] || '';
}
