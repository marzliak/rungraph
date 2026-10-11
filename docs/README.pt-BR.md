# RunGraph para famílias de agentes Hermes

**Veja o agente principal e os agentes que ele chamou no mesmo grafo.**

[English README](../README.md) · [Instalação da integração](HERMES_FAMILIES.md) · [Textos para compartilhar](SHARE.md)

Um agente Hermes chama vários workers Claude Code. Cada worker aparece como uma
execução separada, mas a lista sozinha não explica quem chamou quem. Você precisa
trocar filtros e abrir sessões uma a uma para reconstruir a tarefa.

Este fork acrescenta vínculos explícitos entre o pai Hermes e seus workers
Claude Code persistidos. Ao abrir o pai, você vê os filhos nativos e os workers
registrados no mesmo grafo, mesmo quando usam modelos diferentes.

![Comparação conceitual entre execuções separadas e uma família conectada.](family-overview.svg)

*A ilustração usa nomes fictícios. Não é uma captura de tela nem uma conversa de usuário.*

## O que muda

- Os workers registrados ficam ligados ao pai, inclusive com o filtro Hermes ativo.
- Você pode inspecionar o filho, abrir sua execução individual e voltar ao pai.
- O modelo solicitado aparece quando foi registrado; o fork não troca seu modelo ou provider.
- Um filho recém-lançado pode aparecer conectado antes de existir transcript disponível.
- `running` exige evidência de execução. Recência é `recent`; ausência ou inconsistência de telemetria vira `unknown`.

O fork observa as execuções. Ele não é um novo orquestrador e não passa a controlar
seus agentes. A composição de famílias está na WebUI; CLI/MCP mantêm seu escopo
nativo do upstream.

## Começar

Use **Node.js ≥ 22.13** para ler o SQLite do Hermes. O lançador opcional também
precisa de **Python ≥ 3.10** e de uma instalação existente do Claude Code.

```bash
git clone --branch homolog https://github.com/marzliak/rungraph.git
cd rungraph
npm ci
npm run build
node bin/rungraph.js
```

Isso inicia o visualizador local. Para ligar novos workers externos ao pai, siga
o [guia do lançador e do registry](HERMES_FAMILIES.md#connect-new-claude-code-workers).
Instalar apenas o visualizador não cria os vínculos retroativamente.

**`npx rungraph` instala o pacote original, não esta integração do fork.**

## Limites que importam

O lançador liga chamadas headless persistidas `claude -p` / `--print` que herdam
um `HERMES_SESSION_ID` válido. Chamadas interativas, anônimas e com
`--no-session-persistence` passam sem vínculo. Não inferimos parentesco por nome
ou horário. Execuções antigas sem registro continuam independentes; a importação
histórica exige ledger e prova exata em formato específico.

A verificação de processo usa `/proc` no Linux. Sem essa evidência, o estado pode
ficar `unknown`. Uma conversa sem mensagens novas não prova que o agente terminou.

Os transcripts e os registros de execução continuam privados. O registry não
armazena prompts, mas contém IDs, rótulos e diretórios. Não exponha o visualizador
na internet sem autenticação e controles de rede próprios. Não anexe conversas
reais ou registry privado a issues públicas.

## Testar e contribuir

Encontrou um problema? Abra uma [issue](https://github.com/marzliak/rungraph/issues)
com versões, comportamento esperado e um exemplo sanitizado.

Se for útil para você, deixe uma **star** para encontrar o projeto depois.
Há [textos curtos em português e inglês](SHARE.md) para apresentar o fork.

## Crédito

Fork focado do [RunGraph de Fayzan Malik](https://github.com/fayzan123/rungraph),
baseado na versão v0.8.1 e distribuído sob a [licença MIT original](../LICENSE).
As melhorias não são uma versão oficial do upstream nem implicam endosso do autor.
O demo e o GIF originais não demonstram esta integração de famílias.
