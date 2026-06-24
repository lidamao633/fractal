# Business Glossary (domains)
#
# Describe core business concepts in domain language (not technical jargon),
# linked to code anchors. When an agent receives a related task, the system
# auto-injects matching entries by trigger keywords.
#
# Format (one ## block per entry):
#   ## Concept Name
#   - trigger: keyword1, keyword2       <- inject this entry when these words appear in the task
#   - anchor: src/xxx/**, ...            <- related code locations (glob / directory / file)
#   - doc: docs/xxx.md                   <- optional, detailed documentation
#   - verified: YYYY-MM-DD              <- last verified date
#   Business rule description in plain language...
#
# See `nav capture` (run without args) for examples.
# This file starts empty — entries are added during real project work, not as placeholders.
