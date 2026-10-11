# Share this fork

Copy that you can adapt for a post. These are descriptions, not posts already
published elsewhere. The project is a fork of RunGraph by Fayzan Malik, under MIT.

## English

### Short post

I made a RunGraph fork for Hermes users who launch Claude Code workers: open the
parent and see its registered workers in the same graph, even with different
models. It also separates verified execution from recent transcript activity.

Code and setup: https://github.com/marzliak/rungraph

External workers need explicit launch registration. I'd like feedback from people
using this setup. If it's useful, a star helps others find the fork.

### Longer introduction

My Hermes agent could launch several Claude Code workers, but each external run
appeared independently. I wanted to open the parent and see the whole task without
hunting through another filter.

This RunGraph fork adds explicit links for persisted Claude Code launches,
connected placeholders before transcripts arrive, and navigation between parent
and child runs. Models can differ; the integration doesn't change your provider
or orchestrate the work.

It also separates `running`, `completed`, `error` and `unknown` evidence from
simple recency. Process evidence uses Linux `/proc`; unavailable evidence stays
unknown. It's a local observer, and your transcripts and registry should stay
private.

Source, setup and a conceptual diagram: https://github.com/marzliak/rungraph

The optional launcher is required to register external children. This feature is
not in the upstream npm package. Credit to Fayzan Malik for the original RunGraph
viewer and adapters. Try it, report a sanitized reproduction if something breaks,
and star it if you'd like to keep track.

## Português

### Post curto

Fiz um fork do RunGraph para quem usa Hermes chamando workers Claude Code:
você abre o agente principal e vê seus workers registrados no mesmo grafo,
mesmo com modelos diferentes. Também separa execução comprovada de conversa
que só teve atividade recente.

Código e instalação: https://github.com/marzliak/rungraph

Os workers externos precisam passar pelo lançador para registrar o vínculo.
Quero ouvir quem usa esse fluxo. Se for útil, uma star ajuda a divulgar o fork.

### Apresentação mais completa

Meu agente Hermes chamava vários workers Claude Code, mas cada execução externa
aparecia separada. Eu queria abrir o pai e entender a tarefa inteira sem procurar
os filhos em outro filtro.

Este fork do RunGraph acrescenta vínculos explícitos para chamadas persistidas,
mostra o filho conectado antes de o transcript chegar e permite navegar entre
pai e filho. Os modelos podem ser diferentes; a integração não troca seu provider
nem passa a orquestrar o trabalho.

O estado também tem significado: `running` depende de evidência de execução;
`recent` é só recência; falta de evidência vira `unknown`. A verificação de processo
usa `/proc` no Linux. O visualizador é local e os transcripts continuam privados.

Código, instalação e ilustração: https://github.com/marzliak/rungraph

O lançador opcional precisa registrar os workers externos. A melhoria não está
no pacote npm original. Crédito ao Fayzan Malik pelo RunGraph e seus adapters.
Teste, envie uma reprodução sanitizada se encontrar problema e deixe uma star
se quiser acompanhar.

## Visual to attach

Use [the conceptual illustration](family-overview.svg). It has synthetic labels
and is explicitly marked as an illustration, not a screenshot. Don't crop away
that note or present it as a live-session capture. The upstream demo is not a demo
of this fork's family integration.
