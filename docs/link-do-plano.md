# Planos agrupados e link do plano para WhatsApp

## Planos agrupados

Um grupo (`assessment_plan_families`, ex.: "Corrida - Essencial") reúne as
durações do mesmo plano. Cada duração continua sendo um registro de
`assessment_plans` (agora com `family_id`): contratos, renovações, trocas de
plano, matriz de upgrade e repasse seguem apontando para a duração, sem mudança.

- Tela Planos: um bloco por grupo com as durações; "Novo plano" cria o grupo e
  as durações (mensal, trimestral, semestral) de uma vez; "Duração" adiciona
  outra duração ao grupo; planos sem grupo (ex.: os do sistema antigo) aparecem
  em "Planos sem grupo".
- O banco aceita uma duração ativa por grupo e só duração da mesma modalidade.
- Na publicação, os planos ativos foram agrupados pelo nome
  ("X - Mensal/Trimestral/Semestral" → grupo "X").

## Link do plano

Cada grupo tem dois links secretos: com matrícula (`link_token`) e sem
matrícula (`link_token_no_fee`). O segredo do link sem matrícula é outro, então
ninguém tira a taxa mexendo no endereço.

- Planos > "Link para WhatsApp": escolhe o coach e onde a pessoa vai treinar
  (os dois opcionais) e marca "Sem taxa de matrícula" se quiser; copia o link
  ou a mensagem com o link.
- Endereço: `https://eon-store.netlify.app/plano/<segredo>`, com
  `?coach=<id do coach>` e/ou `regiao=florianopolis|online`. O que vem no link
  já chega escolhido e a página não pergunta de novo; região fora dessas duas é
  ignorada (a pessoa escolhe).
- A pessoa escolhe a duração, preenche nome, WhatsApp, e-mail, CPF, data de
  nascimento (obrigatória na página), gênero (opcional: Feminino, Masculino,
  Outro ou "Prefiro não informar") e endereço e confirma. No servidor os dois
  campos novos são opcionais (a página aberta antes da publicação não quebra);
  cliente novo já nasce com eles e cliente existente não é alterado (o enviado
  fica no comprovante, no card "Perfil enviado" de Prospects). Vira prospect "Novo" no quadro (envio com `source = 'plan_link'`;
  o card mostra "Formulário do link do plano"). No link sem matrícula, o
  prospect chega com matrícula zero.
- Coach do link: precisa estar ativo e atender a modalidade (pode ser coach que
  não aparece no site). Sem coach no link, a pessoa escolhe entre os coaches
  ativos da modalidade.
- Desligar o link (editar o grupo) faz os links já enviados mostrarem que não
  estão mais ativos.

Servidor: função pública `public-plan-link` (GET mostra o plano, POST cadastra)
e RPCs `get_plan_link` e `submit_plan_link_prospect` (só `service_role`). Sem
login: a proteção é o segredo do link, a origem da página (eon-store.netlify.app,
prévias e localhost), o campo isca e o mesmo limite de tentativas do cadastro
do site. O cadastro do site (`public-assessment-prospect`) não mudou.
