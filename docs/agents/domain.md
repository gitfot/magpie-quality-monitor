# Domain Docs

## Layout

This is a single-context repository:

- `GLOSSARY.md` at the repository root.
- Architecture decision records under `docs/adr/`.

## Before exploring

Read the root glossary and ADRs relevant to the area being explored.

If these files do not exist, proceed silently. Do not flag their
absence or suggest creating them upfront. The domain-modeling skill
creates them lazily when terminology or decisions are resolved.

## Use domain vocabulary

Use glossary terms in issue titles, proposals, hypotheses, and tests.
Avoid synonyms the glossary explicitly rejects.

If a concept is missing, reconsider whether it belongs to the domain
or note the gap for domain-modeling.

## Flag ADR conflicts

Explicitly identify any proposal that contradicts an existing ADR.
Do not silently override an accepted decision.
