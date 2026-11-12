# KA Auto Answer

Página de instalação do bookmarklet e userscript para Khan Academy. O modo automático prioriza a OpenAI API e usa Gemini como fallback; também aceita uma API compatível com OpenAI Chat Completions.

## Usar

Abra a página do GitHub Pages, informe uma chave da OpenAI API e, se quiser, uma chave Gemini para fallback. Você também pode configurar uma API compatível. O script só resolve quando você clica em **Resolver agora** e acompanha o feedback da resposta.

A chave da OpenAI API é diferente da assinatura do ChatGPT e precisa ter acesso à API habilitado. As chaves ficam no navegador e as solicitações vão diretamente ao provedor. O bookmarklet personalizado gerado contém as chaves; não o compartilhe.

## Arquivos

- index.html: página de instalação, com o código atualizado embutido.
- ka-auto-answer.user.js: versão para gerenciador de userscripts.
- ka-auto-answer.bookmarklet.txt: bookmarklet genérico, sem chaves.
