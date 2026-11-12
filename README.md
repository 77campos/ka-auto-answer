# KA Auto Answer

Página de instalação do bookmarklet e userscript da Khan Academy. O modo automático prioriza OpenAI (API do ChatGPT), com Gemini como fallback e suporte opcional a API compatível com OpenAI Chat Completions.

## Usar

Abra a página do GitHub Pages, cole a(s) chave(s) e gere o favorito. A API OpenAI é usada primeiro quando configurada; Gemini e a API compatível podem atuar como fallback. A API OpenAI exige uma chave da plataforma OpenAI e é cobrada separadamente da assinatura ChatGPT. A API personalizada requer URL base, nome do modelo e suporte a CORS.

O script só resolve quando você clica em **Resolver agora**. Ele acompanha o feedback da resposta, mas não resolve questões seguintes sozinho.

## Arquivos

- `index.html`: página de instalação, com o código atualizado embutido.
- `ka-auto-answer.user.js`: versão para userscript manager.
- `ka-auto-answer.bookmarklet.txt`: bookmarklet genérico, sem chaves.

As chaves não estão incluídas no repositório. O bookmarklet personalizado gerado no navegador contém as chaves informadas; não o compartilhe.

