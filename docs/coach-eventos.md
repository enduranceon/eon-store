# Coach nos eventos: responsáveis, grupo do WhatsApp e login do coach

Decisões do usuário (2026-11-09) para os coaches passarem a cuidar de eventos.

## O que o coach vai ver

- **Só os eventos em que é responsável.** Um evento pode ter **mais de um** coach
  responsável.
- **Só olhar.** Lista dos inscritos e quem está pago e quem não pagou.
- **Sem valores.** Nada de preço, valor recebido, taxa, despesa, centro de receita, link
  de cobrança nem observação interna; o coach não tem noção de ganhos do evento.
- **Operação do grupo do WhatsApp.** Se a pessoa já está no grupo ou não.

## Grupo do WhatsApp (feito)

- Ao criar/editar o evento, a equipe marca "Este evento tem grupo no WhatsApp"
  (`events.whatsapp_group_enabled`).
- Em evento com grupo, cada inscrição **paga** mostra uma lista com "Falta adicionar",
  "No grupo" e "Não quer entrar" (`event_registrations.whatsapp_group_status`:
  `pending`, `added`, `declined`). Inscrição ainda não paga mostra "depois que pagar";
  cancelada/reembolsada não entra.
- O topo da lista de inscritos resume ("2 de 5 pagos já estão no grupo · 2 faltam
  adicionar") e tem o filtro "Mostrar só quem falta".
- A equipe (painel) e o **coach responsável** do evento (área do coach) mudam a situação.
  O coach só mexe nisso, nas inscrições pagas dos eventos dele.

## Coaches responsáveis (feito)

- `event_coaches (event_id, coach_id)`; a equipe escolhe ao criar ou editar o evento
  (vários). A tabela só é lida por administrador e escrita por `set_event_coaches`
  (via `PUT /events/:id/coaches`). **Ainda não dá acesso a ninguém.**

## Login do coach (feito)

O coach entra em `/login` com e-mail e senha, como a equipe. O servidor decide quem é
a conta: administrador vai para `/admin`; coach ativo vai para `/coach`; qualquer outra
conta é desconectada ("Esta conta não tem acesso ao sistema").

**Área do coach** (`/coach`, `/coach/eventos/:id`, `/coach/senha`):
- Lista dos eventos em que ele é responsável (próximos e anteriores), com inscritos,
  pagos, sem pagar e quantos faltam no grupo.
- Evento: data, local, mapa, avisos públicos; inscritos agrupados em Pagos, Ainda não
  pagaram e Canceladas; busca por nome; resumo e filtro "Mostrar só quem falta".
- Em evento com grupo, cada inscrição **paga** mostra a lista "Falta adicionar / No grupo /
  Não quer entrar" (o coach responsável **marca**; decisão do usuário em 2026-11-09), o
  WhatsApp da pessoa (para adicioná-la ao grupo; só de inscrição paga em evento com grupo)
  e os botões Copiar e Abrir conversa.
- Só leitura no resto. Nunca aparece preço, valor, taxa, despesa, centro de receita,
  cobrança, CPF, e-mail, respostas do formulário nem observações internas.
- Primeiro acesso: a senha provisória da equipe precisa ser trocada antes de qualquer
  outra tela; depois há "Trocar senha" no topo.

**Como a equipe cria o acesso** (Assessoria > Coaches, coluna "Acesso"):
- "Criar acesso" cria a conta com o e-mail do cadastro e mostra a senha provisória **uma
  única vez**, com a mensagem pronta para copiar. "Gerar nova senha provisória" e
  "Remover acesso" (apaga a conta; o coach perde os dados na hora).
- Coach inativo ou sem e-mail válido não recebe acesso. E-mail que já tem conta (por
  exemplo de administrador) é recusado sem mexer nela. Conta de administrador nunca vira
  conta de coach. Uma conta pertence a um único coach.
- O e-mail de login é o do cadastro no momento da criação; se mudar, remova e crie de novo.

**Segurança (o que garante que o coach não alcança o resto):**
1. **Banco fechado.** Todas as tabelas seguem com RLS restrita a administrador; um usuário
   logado que não é administrador lê 0 linhas (conferido na produção em 2026-11-09: 56
   tabelas com permissão de leitura, nenhuma linha visível) e não grava em nenhuma. O teste
   `supabase/tests/coach_login_test.sql` varre todas as tabelas e views a cada CI e falha
   se isso mudar, e falha também se uma função `SECURITY DEFINER` do schema `public` ficar
   aberta a usuário logado.
2. **Única porta: `coach-api`** (`supabase/functions/coach-api`). Valida o JWT, pega o id
   da conta **só do token** (nunca do que o cliente envia) e chama as funções `coach_*` do
   banco, que conferem que a conta é de um coach ativo e que o evento é dele, e devolvem uma
   lista **fixa** de campos (o teste confere as chaves exatas e que nada de dinheiro
   aparece). Evento de outro coach e evento inexistente dão a mesma resposta.
3. **API da equipe fechada.** `api-v1` continua exigindo administrador: o coach recebe 403.
   O painel (`AdminLayout`) manda coach de volta para `/coach`.
4. As funções `coach_*`, `link_coach_auth_user` e `unlink_coach_auth_user` só executam
   como `service_role`.

## Painel do coach: alunos, entradas e saídas (etapa 1 do perfil completo)

Pedido do usuário em 2026-11-10: o coach ter um perfil com seus alunos, entradas e saídas, e
(próximas etapas) o que tem a receber e o que já recebeu. Decisões (todas "segue o recomendado"):

1. O coach só verá **dinheiro dele** (o repasse, nas próximas etapas). Nunca mensalidade, valor
   do plano nem "carteira por mês" (o que a empresa fatura).
2. Fechamento de repasse **em revisão** só aparece depois de aprovado (etapa 2).
3. Coach líder: só o valor do bônus de liderança, sem lista dos alunos da equipe (etapa 2).
4. **Sem WhatsApp/e-mail/CPF** dos alunos no painel.
5. Ajustes manuais do extrato: valor e motivo curto (etapa 2).

**Telas** (`/coach`, `/coach/alunos`, `/coach/movimento`, `/coach/eventos`): ver a seção
"Interface do coach" abaixo (redesenho de 2026-11-10, sem mudança de dados nem de regras).

**O que o coach não vê, de propósito:** mensalidade/valor, pagamento atrasado do aluno (aparece como
"Ativo"), contato e ids internos. Situação mostrada: Ativo, Em licença ou Renovação em andamento.

**Como é calculado.** Com **as mesmas regras do perfil do coach no painel da equipe**
(`coach-profile.js`): quem é entrada, retorno, renovação ou saída depende de TODOS os contratos
(um aluno que veio de outro coach, por exemplo), então a conta roda **no servidor**
(`coach-api`, `GET /panel`) e o navegador do coach só recebe o resultado dele, em lista fixa de
campos (o teste confere as chaves exatas, que nada de dinheiro/contato aparece e que gente de
outro coach nunca entra). Os contratos ficam em memória por 60 segundos entre as chamadas.

**Código compartilhado e fuso horário.** Os módulos de cálculo (`assessment-movement`,
`-yearly-indicators`, `-contract-lifecycle`, `-contract-mrr`, `-renewal-pipeline`,
`-metric-data`, `coach-profile`) passaram a morar em `supabase/functions/_shared/assessment-metrics/`;
os arquivos de `src/lib/` só reexportam, então o painel da equipe não mudou. O servidor roda em
UTC e o painel em horário de Brasília: para os dois darem **o mesmo número**, a conversão de um
instante (`created_at`, `updated_at`...) em dia é sempre no fuso de Brasília (`dates.js`), e a
função do coach recebe o "hoje" de Brasília explícito (`today` é obrigatório). O teste
`coach-panel.test.js` roda a conta em quatro fusos, a 22h10 de Brasília, e exige resultado idêntico.

**Fora desta etapa:** "esqueci a senha" pelo próprio coach (a equipe gera nova senha),
check-in no dia do evento, ver respostas do formulário de inscrição e, do perfil completo,
as etapas 2 a 4: **recebimentos** (fechamentos aprovados, extrato, repasse aguardando o aluno
pagar), **previsão do mês** (com a conta do fechamento) e renovações/prospects/PDF do extrato.

## Interface do coach (redesenho)

Pedido do usuário em 2026-11-10: a área do coach estava "crua", sem cara de software. O redesenho
mexe **só na apresentação**: a API, os campos e as regras de cálculo são os mesmos, e nada de
dinheiro ou contato passou a aparecer.

- **Casca:** no computador, barra lateral escura (a mesma identidade do painel da equipe) com
  Início, Alunos, Evolução e Eventos, mais conta, "Trocar senha" e "Sair" embaixo. No celular,
  barra de abas fixa embaixo (área do polegar) e menu da conta no topo. O título da aba do
  navegador muda por tela.
- **Início:** saudação por horário e data por extenso; cartão de destaque com os alunos ativos
  hoje e a linha dos últimos 12 meses; **"Precisa da sua atenção"** (contrato que já venceu,
  vence em até 30 dias, renovação em andamento e licença, do mais urgente ao menos); próximos
  eventos com contagem regressiva e pendências; alunos por modalidade; os números dos 12 meses em
  linguagem simples (entraram, renovaram, saíram, saldo) e entradas × saídas por mês.
- **Alunos:** abas Ativos/Saíram, busca (sem acento, sem diferenciar maiúsculas), filtros por
  situação (Vencendo, Em renovação, Em licença, só os que têm alguém), modalidade e ordem
  (nome, vencimento, início). Cada aluno mostra a barra do contrato e "faltam N dias". Quem
  está em renovação ou licença não aparece como "vencendo": a conversa já começou. Saíram:
  mais recente primeiro, com o motivo ou "Sem motivo registrado".
- **Evolução:** período de 6 ou 12 meses, frase-resumo, melhor mês e mês com mais saídas, dois
  gráficos (alunos no fim de cada mês; entradas para cima e saídas para baixo) e a tabela mês a
  mês, com o mês atual marcado "em andamento".
- **Eventos:** data em destaque, contagem regressiva, barra de pagos e de grupo. No detalhe, o
  grupo do WhatsApp é marcado com **três botões** (Falta / No grupo / Não quer) no lugar da lista
  suspensa: a escolha aparece na hora e volta ao que estava se o servidor recusar. Filtros
  (todos, pagos, sem pagar, faltam no grupo) e "Copiar números de quem falta" (só o que o coach
  já via: nome e número de quem pagou, em evento com grupo).
- **Senha e login:** tela de senha com mostrar/ocultar e requisitos que acendem; login com a marca
  "Endurance ON", preenchimento automático e aviso de que, para recuperar a senha, o coach pede
  para a equipe.
- **Código:** regras testáveis em `src/lib/coach-ui.js` (atenção, filtros, ordem, resumo do
  período, contagem regressiva de eventos; datas por número de dia em UTC, então o resultado não
  depende do fuso do aparelho); peças visuais em `src/components/coach/` (`kit.jsx`, `charts.jsx`,
  `event-parts.jsx`). Aba, busca e filtros da lista de alunos ficam no estado da tela; o
  endereço só abre a tela já filtrada (`?q=`, `?filtro=`, `?aba=`, `?modalidade=`, `?ordem=`).
