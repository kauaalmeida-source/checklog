# CheckLog modularizado

O arquivo principal da SPA foi dividido em 12 telas dentro de `pages/`. O `index.html` agora contém apenas a estrutura compartilhada: cabeçalho, aparência, modais globais, chatbot, rodapé e o ponto de montagem das telas.

## Estrutura principal

- `index.html`: casca da SPA.
- `pages/*.html`: documentos individuais de cada tela.
- `css/style.css`: CSS compartilhado e reorganizado.
- `js/app.js`: lógica existente e carregador dos módulos HTML.
- `js/*.js`: regras de negócio e serviços já usados pelo projeto.
- `vendor/chart.umd.min.js`: biblioteca de gráficos local.
- `docs/`: documentação do Firebase e Power BI.

## Telas geradas

1. `login.html`
2. `cadastro.html`
3. `pagina-inicial.html`
4. `registrar_ponto.html`
5. `meu-checklog.html`
6. `gerenciamento-ponto.html`
7. `justificativas.html`
8. `controle-estoque.html`
9. `fornecedores.html`
10. `dashboard.html`
11. `encomendar.html`
12. `relatorios.html`

## Execução

Use um servidor HTTP, como a extensão **Live Server** do VS Code, Firebase Hosting ou outro servidor local. Não abra o `index.html` diretamente por `file://`, pois o navegador pode bloquear o carregamento dos módulos feito com `fetch`.

## Navegação

A função global `navigate(pageId)` foi preservada. Antes de inicializar Firebase, eventos e renderizações, `app.js` carrega todas as telas em paralelo e aguarda a montagem completa do DOM.

Na revisão 1.6.2, a navegação redefine imediatamente a posição da página e o layout usa a rolagem normal do navegador. Isso remove a disputa entre o `body` travado e a antiga rolagem interna de `#app-content`, evitando telas cortadas após trocar de módulo, inclusive no Opera GX.

Na versão 1.7.0, o visual recebeu um refinamento discreto: hierarquia tipográfica mais clara, espaçamentos consistentes, cards com bordas e sombras leves, campos maiores, foco acessível, botões sólidos e tabelas mais legíveis. A identidade verde, o tema escuro e a estrutura funcional foram mantidos.

## Recursos externos

Este projeto usa Firebase por módulos ES e VLibras pela internet. Ele precisa de conexão para carregar esses serviços.

Os anexos recebidos não continham a pasta `img/`. Para manter logotipo e imagem de fundo, copie a pasta de imagens do projeto original para a raiz, preservando estes caminhos:

- `img/checklog-logo-removebg-preview.png`
- `img/logo-CheckLog-removebg-preview.png`
- `img/background.png`

## Observação técnica

Este projeto não utiliza `database.js` e `auth.js` separados. Autenticação e Realtime Database são importados diretamente do Firebase dentro de `js/app.js`; por isso as referências reais do projeto foram preservadas.
