---
"callsheet": patch
---

Make the homelab connector insist that overnight work is reported.

The instruction it gave read "if something was fixed overnight, one line is enough", which a
summariser reasonably treats as a ceiling rather than a floor — so a night with five repairs
could be summarised as nothing at all. The point of surfacing a maintenance job in a brief is
to tell the reader what was handled on their behalf, and silence there is indistinguishable
from an idle night.

The wording is now conditional on `action_taken`: when work was done it asks for at least one
line, and when nothing changed it says so explicitly so the brief cannot imply otherwise.
