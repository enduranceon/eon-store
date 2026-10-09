function normalizedText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizedPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length > 11 && digits.startsWith('55') ? digits.slice(2) : digits;
}

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

const SUBMITTED_IDENTITY_FIELDS = [
  ['full_name', 'submitted_full_name', 'Nome', normalizedText],
  ['whatsapp', 'submitted_whatsapp', 'WhatsApp', normalizedPhone],
  ['email', 'submitted_email', 'E-mail', normalizedEmail],
];

export function prospectSubmissionIdentityDifferences(customer, submission) {
  if (!submission) return [];
  return SUBMITTED_IDENTITY_FIELDS.flatMap(([customerKey, submissionKey, label, normalize]) => {
    const submittedValue = String(submission[submissionKey] || '').trim();
    if (!submittedValue) return [];
    const customerValue = String(customer?.[customerKey] || '').trim();
    if (normalize(submittedValue) === normalize(customerValue)) return [];
    return [{
      field: customerKey,
      label,
      submittedValue,
      customerValue,
    }];
  });
}

export function hasProspectSubmissionIdentityDifference(customer, submission) {
  return prospectSubmissionIdentityDifferences(customer, submission).length > 0;
}

export function prospectContactCustomer(customer, submission) {
  if (!submission) return customer;
  return {
    ...customer,
    full_name: String(submission.submitted_full_name || '').trim() || customer?.full_name,
    whatsapp: String(submission.submitted_whatsapp || '').trim() || customer?.whatsapp,
    email: String(submission.submitted_email || '').trim() || customer?.email,
  };
}

export function prospectSubmittedAddress(submission) {
  if (!submission) return '';
  const streetLine = [
    submission.submitted_address_street,
    submission.submitted_address_number,
    submission.submitted_address_complement,
  ].map(value => String(value || '').trim()).filter(Boolean).join(', ');
  const cityLine = [
    submission.submitted_address_neighborhood,
    [submission.submitted_address_city, submission.submitted_address_state]
      .map(value => String(value || '').trim()).filter(Boolean).join(' - '),
  ].filter(Boolean).join(' · ');
  const zip = String(submission.submitted_address_zip || '').replace(/\D/g, '');
  const formattedZip = zip.length === 8 ? `${zip.slice(0, 5)}-${zip.slice(5)}` : zip;
  return [streetLine, cityLine, formattedZip ? `CEP ${formattedZip}` : ''].filter(Boolean).join(' · ');
}

export function prospectLatestActivityAt(prospect) {
  return prospect?.latest_submission?.submitted_at || prospect?.created_at || '';
}

export function sortProspectsByLatestSubmission(prospects) {
  return [...prospects].sort((left, right) => {
    const activityOrder = prospectLatestActivityAt(right).localeCompare(prospectLatestActivityAt(left));
    if (activityOrder !== 0) return activityOrder;
    return String(right?.created_at || '').localeCompare(String(left?.created_at || ''));
  });
}

export function matchesProspectSearch(prospect, customer, query) {
  const normalizedQuery = normalizedText(query);
  if (!normalizedQuery) return true;

  const submission = prospect?.latest_submission;
  const requestProtocol = submission?.request_id
    ? `EON-${String(submission.request_id).slice(0, 8).toUpperCase()}`
    : '';
  const values = [
    prospect?.contract_number,
    customer?.customer_code,
    customer?.full_name,
    customer?.whatsapp,
    customer?.email,
    customer?.cpf,
    submission?.submitted_full_name,
    submission?.submitted_whatsapp,
    submission?.submitted_email,
    submission?.submitted_cpf,
    submission?.submitted_address_zip,
    submission?.submitted_address_street,
    submission?.submitted_address_number,
    submission?.submitted_address_complement,
    submission?.submitted_address_neighborhood,
    submission?.submitted_address_city,
    submission?.submitted_address_state,
    submission?.request_id,
    requestProtocol,
  ];
  const textHaystack = normalizedText(values.join(' '));
  const digitHaystack = values.map(value => String(value || '').replace(/\D/g, '')).join(' ');

  return normalizedQuery.split(' ').every(token => {
    const digits = token.replace(/\D/g, '');
    return textHaystack.includes(token) || (digits.length >= 3 && digitHaystack.includes(digits));
  });
}
