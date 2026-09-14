# Publicação em produção

## Regra operacional

- Toda alteração entra por pull request.
- A automação publica uma prévia da pull request na Netlify.
- Produção só é publicada a partir da branch `main`, por integração ou execução manual do workflow nessa branch. Executar o workflow em outra branch apenas valida o código.
- O deploy de produção deve usar o artefato da automação, contendo `dist/` e `netlify.toml` do mesmo commit. A configuração acompanha o site para aplicar redirecionamentos e cabeçalhos; não publicar `dist` de uma cópia local.
- O uso atual registra cobranças externas e pagamentos externos. A integração Asaas continua preparada para uso futuro; esta etapa não a ativa nem publica suas funções auxiliares.

## Ordem da automação e limites

1. Validar as migrações em um banco local descartável e executar lint, testes e build.
2. Somente se as duas validações passarem e a origem for `main`, publicar `api-v1` no projeto `bsiljrrodgtmtdilnuxr`.
3. Somente se a publicação da API concluir com sucesso, publicar o frontend na Netlify (`9a9edc3b-04e4-431f-8927-f946900b0b27`).

`NETLIFY_AUTH_TOKEN` e `SUPABASE_ACCESS_TOKEN` ausentes interrompem seus passos com erro. Não tratar uma etapa pulada por falta de credencial como publicação bem-sucedida. A Netlify CLI está fixada em `27.5.2`, a versão registrada no último deploy auditado (run `34629189530`, commit `2bbcfc4`); atualizar essa versão em alteração separada, com validação de build e prévia.

Pull requests publicam somente a prévia do frontend. Elas não publicam a API, outras Edge Functions nem migrações remotas. **A prévia usa a configuração de produção e pode acessar dados reais:** ela não é um ambiente de homologação isolado. Nesta etapa, validar a prévia pública sem submissões; usar fixtures locais para cenários de cobrança externa e pagamento externo. Não registrar operações fictícias em alunos reais.

O workflow valida migrações localmente, mas não aplica migrações no banco remoto. Mudanças que dependam de schema novo exigem um plano próprio antes da integração. Funções auxiliares, inclusive `generate-monthly-closing`, também não são publicadas por este workflow; reconciliar seu código no Git não altera a versão em execução.

API e frontend são publicados em sequência, sem transação conjunta. Se a Netlify falhar após o deploy da API, o frontend anterior continuará usando a API nova. Manter a API compatível com o frontend anterior e revisar esse intervalo em mudanças de contrato.

## Validação antes da integração

1. Conferir a prévia publicada pela automação.
2. Testar o fluxo público que foi alterado, sem submissões, e verificar os cabeçalhos HTTP e o console da prévia. Nesta reconciliação, a configuração passa a acompanhar o artefato: conferir a busca de CEP sob a CSP existente e registrar os fluxos ainda não verificados.
3. Para mudanças administrativas, validar as regras com fixtures locais. Login, navegação administrativa, cobrança externa, pagamento externo e geração/impressão de PDFs devem ser verificados em navegador local com backend simulado: carregar uma tela administrativa pode disparar gravações, mesmo sem clicar em salvar. A integração Asaas não faz parte da validação atual.
4. Integrar a pull request.
5. Conferir a URL oficial após a publicação.

## Recuperação

Se uma publicação regredir, identificar qual componente mudou, usar o deploy anterior da Netlify como referência e abrir uma pull request de correção. Uma restauração do frontend não restaura `api-v1`, funções auxiliares nem banco de dados. Não reutilizar pastas temporárias ou builds antigos como fonte de uma nova produção.

## Exceções

Uma publicação manual só pode ocorrer para restaurar uma indisponibilidade e deve:

1. partir de um build concluído com `netlify build --context production`;
2. ser registrada em uma pull request imediatamente depois;
3. conter no título do deploy o motivo da exceção.
