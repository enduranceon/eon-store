# Publicação em produção

## Regra operacional

- Toda alteração entra por pull request.
- A automação publica uma prévia da pull request na Netlify.
- Somente a integração na branch `main` publica em produção.
- O deploy de produção deve ser o artefato gerado pela automação; não publicar `dist` de uma cópia local.

## Validação antes da integração

1. Conferir a prévia publicada pela automação.
2. Testar o fluxo público que foi alterado.
3. Para mudanças administrativas, validar ao menos uma sessão logada.
4. Integrar a pull request.
5. Conferir a URL oficial após a publicação.

## Recuperação

Se uma publicação regredir, usar o deploy anterior da Netlify como referência e abrir uma pull request de correção. Não reutilizar pastas temporárias ou builds antigos como fonte de uma nova produção.

## Exceções

Uma publicação manual só pode ocorrer para restaurar uma indisponibilidade e deve:

1. partir de um build concluído com `netlify build --context production`;
2. ser registrada em uma pull request imediatamente depois;
3. conter no título do deploy o motivo da exceção.
