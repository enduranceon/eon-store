import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasProspectSubmissionIdentityDifference,
  matchesProspectSearch,
  prospectContactCustomer,
  prospectSubmittedAddress,
  prospectSubmissionIdentityDifferences,
  sortProspectsByLatestSubmission,
} from './assessment-prospect-submission.js';

const customer = {
  customer_code: 'CLI-0001',
  full_name: 'João da Silva',
  whatsapp: '+55 48 99999-0000',
  email: 'JOAO@EXAMPLE.COM',
  cpf: '123.456.789-00',
};

test('comparação ignora formatação equivalente de nome, telefone e e-mail', () => {
  const submission = {
    submitted_full_name: '  Joao   da Silva ',
    submitted_whatsapp: '(48) 99999-0000',
    submitted_email: 'joao@example.com ',
  };
  assert.equal(hasProspectSubmissionIdentityDifference(customer, submission), false);
});

test('identifica e descreve dados enviados diferentes do cliente vinculado', () => {
  const submission = {
    submitted_full_name: 'Maria Souza',
    submitted_whatsapp: '(48) 98888-1111',
    submitted_email: 'maria@example.com',
  };
  assert.deepEqual(
    prospectSubmissionIdentityDifferences(customer, submission).map(item => item.label),
    ['Nome', 'WhatsApp', 'E-mail'],
  );
  assert.equal(hasProspectSubmissionIdentityDifference(customer, submission), true);
});

test('contato operacional usa os dados do formulário sem apagar metadados do cliente', () => {
  const result = prospectContactCustomer(customer, {
    submitted_full_name: 'Maria Souza',
    submitted_whatsapp: '(48) 98888-1111',
    submitted_email: 'maria@example.com',
  });
  assert.equal(result.customer_code, 'CLI-0001');
  assert.equal(result.full_name, 'Maria Souza');
  assert.equal(result.whatsapp, '(48) 98888-1111');
  assert.equal(result.email, 'maria@example.com');
});

test('mantém e formata o endereço enviado separado do cliente canônico', () => {
  const address = prospectSubmittedAddress({
    submitted_address_zip: '88095122',
    submitted_address_street: 'Rua José Beiro',
    submitted_address_number: '218',
    submitted_address_complement: '502B',
    submitted_address_neighborhood: 'Jardim Atlântico',
    submitted_address_city: 'Florianópolis',
    submitted_address_state: 'SC',
  });
  assert.equal(address, 'Rua José Beiro, 218, 502B · Jardim Atlântico · Florianópolis - SC · CEP 88095-122');
});

test('ordena pelo envio mais recente, mesmo quando o contrato é antigo', () => {
  const result = sortProspectsByLatestSubmission([
    { id: 'new-contract', created_at: '2026-10-08T12:00:00Z' },
    {
      id: 'old-contract-new-submission',
      created_at: '2026-01-01T12:00:00Z',
      latest_submission: { submitted_at: '2026-10-08T15:00:00Z' },
    },
  ]);
  assert.deepEqual(result.map(item => item.id), ['old-contract-new-submission', 'new-contract']);
});

test('busca encontra cadastro e envio por nome, contato, CPF e contrato', () => {
  const prospect = {
    contract_number: 'ASS-002113',
    latest_submission: {
      request_id: '123e4567-e89b-42d3-a456-426614174000',
      submitted_full_name: 'Maria Souza',
      submitted_whatsapp: '(48) 98888-1111',
      submitted_email: 'maria@example.com',
      submitted_cpf: '987.654.321-00',
      submitted_address_street: 'Rua José Beiro',
      submitted_address_city: 'Florianópolis',
    },
  };

  assert.equal(matchesProspectSearch(prospect, customer, 'maria'), true);
  assert.equal(matchesProspectSearch(prospect, customer, '988881111'), true);
  assert.equal(matchesProspectSearch(prospect, customer, '987654321'), true);
  assert.equal(matchesProspectSearch(prospect, customer, 'ASS-002113'), true);
  assert.equal(matchesProspectSearch(prospect, customer, 'EON-123E4567'), true);
  assert.equal(matchesProspectSearch(prospect, customer, '123e4567-e89b-42d3-a456-426614174000'), true);
  assert.equal(matchesProspectSearch(prospect, customer, 'José Beiro'), true);
  assert.equal(matchesProspectSearch(prospect, customer, 'joão'), true);
  assert.equal(matchesProspectSearch(prospect, customer, 'inexistente'), false);
});
