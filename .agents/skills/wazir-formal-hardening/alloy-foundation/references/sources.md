# Sources and provenance

This skill is an **original instructional synthesis**, not a reproduction of the upstream book or reference. Code snippets and teaching examples are newly written for this skill. Consult the linked primary sources for exact language semantics and tool-specific behavior.

## Official Alloy project

- Documentation hub: https://alloytools.org/documentation.html
- Alloy 6 temporal semantics, time scopes, lasso traces, and compatibility notes: https://alloytools.org/alloy6.html
- Language reference (grammar, semantics, type system, declarations, functions, commands): https://alloytools.org/spec.html
- Official download: https://alloytools.org/download.html
- Upstream releases (6.2.0 as the site's listed release when reviewed): https://github.com/AlloyTools/org.alloytools.alloy/releases/tag/v6.2.0
- Official project code and build notes: https://github.com/AlloyTools/org.alloytools.alloy

## Practical Alloy (authors: Cunha, Macedo, Brunel, Chemouil)

- Modern open-access book: https://practicalalloy.github.io/
- Structural modeling: https://practicalalloy.github.io/chapters/structural-modeling/index.html
- Relational logic: https://practicalalloy.github.io/chapters/structural-topics/topics/relational-logic/index.html
- Commands and scopes: https://practicalalloy.github.io/chapters/structural-topics/topics/commands/index.html
- Working with integers: https://practicalalloy.github.io/chapters/structural-topics/topics/integers/index.html
- Behavioral modeling: https://practicalalloy.github.io/chapters/behavioral-modeling/index.html
- Temporal logic: https://practicalalloy.github.io/chapters/behavioral-topics/topics/temporal-logic/index.html
- Safety/liveness/fairness: https://practicalalloy.github.io/chapters/behavioral-topics/topics/fairness/index.html

## CLI compatibility notes

- Alloy 6.2 release notes announce `help`, `exec`, and `lsp`: https://github.com/AlloyTools/org.alloytools.alloy/releases/tag/v6.2.0
- Documented Alloy CLI 6.2 `exec` flags: https://alloytools.discourse.group/t/how-do-i-specify-options-to-alloy-6-2-cli-exec-command/538

## Verification status of this skill bundle

- Official language semantics and CLI behavior: **documentation-reviewed**.
- Local file structure, examples, and references: **self-reviewed**.
- Executing `.als` models in the actual Alloy 6.2 Analyzer: **NOT EXECUTED** in this authoring environment because the Alloy JAR was unavailable and external download was inaccessible. The bundled CLI script enables recipient-side validation.
- Versions after 6.2.x: may require revalidation against the upstream grammar and installed `exec --help`.

Last source review: 2026-10-23.
