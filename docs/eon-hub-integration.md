# Integração com o EON Hub — diagnóstico e plano

Levantamento de 06/10/2026, feito só com leitura. Este registro guarda o diagnóstico e as decisões pendentes. Em 02/11/2026 o usuário decidiu que a Store é dona do ciclo de vida do aluno e foi feita a primeira conciliação de dados no Hub (seção abaixo). A sincronização automática ainda não existe.

## Conciliação de 02/11/2026 (fase 1, parte A)

Aprovada caso a caso pelo usuário e aplicada direto no banco do Hub (`qsaowltbnefzpbphhwmr`), em um único bloco transacional. Sem nomes neste arquivo.

- **Antes:** Store com 227 alunos atuais (219 ativos e 8 em licença); Hub com 240 (229 e 11).
- **Aplicado no Hub na parte A (34 fichas):** 8 saídas (7 "Não renovou" e 1 cancelamento, com a data de fim da Store), 4 retornos de atletas cancelados, 3 voltas de licença, 6 licenças (data de início da Store), 1 troca de coach e 12 atletas criados.
- **Formato:** o mesmo das telas do Hub (status em `athletes` mais o movimento em `athlete_movements`, com a data efetiva da Store). Cada movimento leva `extra_data.batch = '2026-11-02'` e `source = 'store_reconciliation'`.
- **Desfazer:** cada ficha tem um `audit_logs` com `action` iniciando por `store_reconciliation_` e `extra_data.before` com a linha completa anterior (`null` nos 12 criados).
- **Vínculo:** as fichas tocadas receberam `extra_data.eon_store_customer_id` (o id de `presale_customers`), seguindo o padrão já usado por 15 atletas; as criadas também têm `origem = 'eon-store'` e `eon_store_plan`.
- **Depois da parte A:** os 227 alunos atuais da Store batem no Hub com o mesmo status e coach. O Hub tinha 248 (234 ativos e 14 em licença); os 21 a mais foram para a parte B.
- **Parte B (mesmo dia, decidida pelo usuário):**
  - 6 licenças antigas, sem coach e fora da Store (uma era ficha duplicada de uma aluna ativa) viraram saída **datada no início da licença**, em 2024 e 2025. Mesmo marcador, com `part = 'B'`.
  - 6 parceiros/cortesia continuam ativos sem contrato na Store e ficaram marcados com `extra_data.cortesia = true` e `fora_da_store = 'cortesia'`.
  - 8 contas da equipe como atleta continuam ativas. Duas receberam a marca que as outras seis já tinham (`is_coach_account`, `linked_coach_id` e a nota "Não contar como aluno"), e as oito têm `fora_da_store = 'equipe'`.
  - 1 aluno continua ativo no Hub mesmo sem contrato vigente na Store: o anterior acabou em 23/10 e o novo começa em 23/11. A sincronização precisa tolerar esse intervalo quando já existe contrato novo agendado.
- **Resultado final:** o Hub tem 242 atuais (234 ativos e 8 em licença) = 227 alunos da Store + 1 aluno no intervalo entre contratos + 6 cortesias + 8 contas da equipe. `fora_da_store` é a etiqueta que a sincronização deve usar para não mexer numa ficha.
- **Pendência de dados:** 9 dos 12 criados vieram da Store sem gênero e nascimento.
- **Casamento entre os sistemas:** e-mail, depois telefone (8 últimos dígitos) e nome normalizado. 18 alunos só casam por telefone ou nome, porque o e-mail difere entre os sistemas.
- **Mapa de coaches usado:** pelo nome; Jéssica Vieira (Store) = Jéssica Rodrigues (Hub), Vinicius Koerich = Vinicius Koeric. Modalidade: corrida = `run`, triathlon = `triathlon`.

Objetivo pedido: os alunos do Hub acompanharem os da Store automaticamente. Quem entra na assessoria aparece no Hub, e quem sai deixa de aparecer, sem cadastro duplicado à mão.

## Os dois sistemas

| | EON Store | EON Hub |
| --- | --- | --- |
| Papel | Loja, financeiro, contratos e renovações | Operação: treinos, Strava/Intervals, portal do atleta |
| Repositório | `enduranceon/eon-store` | `enduranceon/eon-hub` |
| Supabase | `bsiljrrodgtmtdilnuxr` (sa-east-1, São Paulo) | `qsaowltbnefzpbphhwmr` (us-east-1, EUA) |
| Tamanho do banco | 58 MB | ~1,25 GB (880 MB em `activity_streams`, 185 MB em `activity_laps`) |
| Tabelas / funções / triggers / políticas RLS | 60 / 252 / 74 / 107 | 101 / 109 / 27 / 279 |
| Edge Functions | 15 | 19 |

O Hub também tem módulos próprios de repasse, eventos, prospects e coaches. Quatro tabelas têm o mesmo nome nos dois bancos: `events`, `payout_growth_tiers`, `payout_monthly_statement_items` e `payout_role_modality_rates`.

## Como o Hub cadastra alunos hoje

- Tabela `athletes`: `status` (`active`, `cancelled`, `on_leave`), `active`, `is_deleted`, `coach_id`, `start_date`, `end_date`, `email` e `cpf`. O índice único `ux_athletes_email_norm` usa `lower(btrim(email))`. 33 chaves estrangeiras apontam para `athletes`.
- `athlete_movements` guarda o histórico: `new_entry`, `entry`, `return`, `return_from_leave`, `leave`, `exit`, `coach_change` e `athlete_type_change`.
- RPC `public.register_athlete_entry(p_name, p_email, p_whatsapp, p_gender, p_birth_date, p_modality, p_coach_id, p_start_date)`, implementada em `private.register_athlete_entry_internal` (migração `20260928150859_direct_athlete_entry_rpc.sql` do Hub):
  - trava por e-mail (`pg_advisory_xact_lock`);
  - cria o atleta, reativa um antigo (grava um movimento `return`) ou devolve `existing`;
  - grava `athlete_movements` e `audit_logs`;
  - exige e-mail, WhatsApp, gênero, nascimento, coach e modalidade (`run`, `triathlon`, `trail_run`, `bike`, `swim`, `both` ou `other`);
  - já aceita `service_role`, reservado no código para a futura integração servidor a servidor com a Store.
- A tela "Entrada de atleta" do Hub pede para copiar os dados da Store à mão.
- **Ainda não existem RPCs de saída, licença ou troca de coach no Hub.**

## Diferenças medidas em 06/10/2026

Cruzamento por e-mail normalizado. A conferência guardou só contagens; nenhum dado de aluno entrou neste arquivo.

| Situação | Alunos |
| --- | --- |
| Ativos nos dois sistemas | 194 |
| Atuais na Store, mas inativos no Hub | 12 |
| Atuais na Store, não encontrados no Hub | 15 |
| Ativos no Hub, sem contrato atual na Store | 27 |
| Atuais na Store sem e-mail (230 atuais, 221 com e-mail) | 9 |
| Ativos no Hub sem e-mail | 5 |

São **54 divergências** (12 + 15 + 27), além dos 14 cadastros sem e-mail, que precisam de conferência manual.

Outras diferenças:

- **Coaches:** o e-mail difere entre os sistemas para quase todos (só 2 coincidem). Um coach tem sobrenome diferente em cada lado, e um coach existe só no Hub. A integração precisa de um mapa explícito de coaches.
- **Modalidades:** na Store são corrida, triathlon e 2 Modalidades. No Hub são `run`, `triathlon` e `both`.

## Desenho recomendado: dois sistemas e sincronização por eventos

- **A Store é dona do ciclo de vida do aluno na assessoria:** entrada (no pagamento), troca de coach, licença e saída real. **O Hub é dono da operação:** treinos, integrações e portal.
- **Outbox na Store:** cada mudança de contrato que afeta o aluno grava um evento na mesma transação. Um worker (Edge Function agendada) entrega o evento chamando RPCs `service_role` no Hub. O id do evento garante idempotência, e há nova tentativa e uma lista de pendências visível.
- **Vínculo de IDs nos dois lados:** o cliente da Store fica guardado no Hub e o atleta do Hub fica guardado na Store, junto com os mapas de coaches e de modalidades.
- **No Hub,** a entrada e a saída manuais ficam travadas, ou ao menos com aviso, depois que a sincronização estiver ativa.
- **Conciliação diária:** compara os dois lados e lista as diferenças em vez de corrigi-las sozinha.
- **Regra de saída (`AGENTS.md`):** só o encerramento real do aluno gera saída no Hub. Troca de plano, ajuste financeiro, venda descartada e correção de cobrança não geram.

### Fases

1. Conciliar as 54 divergências: lista só de leitura, decisão caso a caso com o responsável e correção com backup.
2. Vincular os IDs e mapear coaches e modalidades.
3. Entrada automática, primeiro em modo sombra: registra o que faria, sem gravar no Hub.
4. Saída, licença e troca de coach, com novas RPCs no Hub.
5. Conciliação diária.

## Banco único: avaliado e não recomendado agora

É viável. Mover a Store para o projeto do Hub é o caminho mecanicamente mais simples, porque a Store é bem menor. A maior dificuldade é de significado, não de cópia:

- há dois modelos de "aluno" (clientes e contratos na Store, `athletes` no Hub com 33 chaves estrangeiras);
- há domínios duplicados (repasse, eventos, prospects e coaches) e tabelas com o mesmo nome;
- dois repositórios passariam a migrar o mesmo banco;
- seria preciso uma virada de produção.

A sincronização mantém a separação entre o sistema da loja e financeiro e o sistema operacional, que é o que se quer preservar. O banco único só volta à mesa se a sincronização se mostrar insuficiente.

## Trazer o banco do Hub para o Brasil (sa-east-1)

O Supabase fixa a região no projeto. Mudar exige um projeto novo em São Paulo e migrar o Hub para ele. A organização está no plano Pro.

- **Vai junto na cópia:** estrutura, funções, RLS, triggers, dados e logins com senha. Com ~1,25 GB, a cópia leva minutos.
- **Precisa ser refeito:**
  - as 19 Edge Functions e seus secrets. Os valores dos secrets não podem ser lidos do projeto atual, então quem tem as chaves precisa cadastrá-las de novo;
  - as variáveis de ambiente do Hub no Netlify;
  - os secrets do GitHub e o `SUPABASE_PROJECT_REF` em `.github/workflows/deploy-functions.yml`, no repositório do Hub;
  - o site público (`enduranceon-site`, página de calendário), que chama o Hub diretamente;
  - o app do Strava (callback e nova inscrição do webhook) e o Intervals (URL de retorno);
  - a configuração de login: URL do site, URLs de retorno, envio de e-mail e modelos dos convites do portal;
  - o storage (8 arquivos) e o cron job.
- **Os usuários fazem login de novo.**
- **Janela:** 1 a 2 horas sem uso do Hub. As atividades do Strava recebidas nessa janela são recuperadas depois pelo sync.
- **Volta atrás:** o projeto antigo fica pausado por alguns dias.
- **Custo:** os dois projetos são pagos durante a transição.
- **Ganho:**
  - estimativa de ~120 ms a menos por consulta para quem usa o Hub no Brasil;
  - mesma região da Store;
  - dados no Brasil.
- **Recomendação:** fazer **antes** de ligar a sincronização, para a integração já nascer no endereço definitivo, e passar antes por um ensaio com uma cópia do banco.

## Decisões pendentes

1. ~~A Store passa a ser dona do ciclo de vida do aluno?~~ Sim, decidido em 02/11/2026.
2. ~~Começar pela fase 1?~~ Feita em 02/11/2026, partes A e B (seção da conciliação).
3. O coach que existe só no Hub ainda está ativo?
4. Mover o Hub para São Paulo: se e quando.
