# Coupling Protocols (protocols)
#
# Record "change A, must sync B" constraints. Before an agent edits a file
# matching an anchor, the system auto-injects the relevant protocol as a reminder.
#
# Format (one ## block per entry):
#   ## A ↔ B one-line title
#   - anchor: src/a.ts, src/b.ts        <- editing any of these triggers this entry
#   - verified: YYYY-MM-DD
#   Description: what in A must stay in sync with what in B.
#
# See `nav capture` (run without args) for examples.
# This file starts empty — entries are added during real project work, not as placeholders.
