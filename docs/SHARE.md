# Share this fork

Copy that you can adapt for a post. These are descriptions, not posts already
published elsewhere. The project is a fork of RunGraph by Fayzan Malik, under MIT.

## Short post

I made a RunGraph fork for Hermes users who launch Claude Code workers: open the
parent and see its registered workers in the same graph, even with different
models. It also separates verified execution from recent transcript activity.

Code and setup: https://github.com/marzliak/rungraph

External workers need explicit launch registration. I'd like feedback from people
using this setup. If it's useful, a star helps others find the fork.

## Longer introduction

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

## Visual to attach

Use [the conceptual illustration](family-overview.svg). It has synthetic labels
and is explicitly marked as an illustration, not a screenshot. Don't crop away
that note or present it as a live-session capture. The upstream demo is not a demo
of this fork's family integration.
