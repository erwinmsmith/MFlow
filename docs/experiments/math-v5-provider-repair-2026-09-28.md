# MATH v5 provider-stream repair

Historical incident, 2026-09-28. Round 1 had four complete validation passes plus 118 tasks in pass five: **594 valid rows**. No synthetic zero row replaced the unfinished task.

A request at 20:22 failed at 21:18 with a non-object field error. A whole-task retry was still running at 22:01. Usage for the first failed request and any interrupted request was unknown. The exact malformed field was not established; non-object tool arguments reproduced a possible failure path in a synthetic fixture, which did not prove the production cause.

## Repair boundary

The adapter used Ditto's public streaming interface and added progress records with task/round/pass, character/non-whitespace counts, timestamps, finish/error status, and known usage. Progress updates were approximately every two seconds and did not include credentials or response content.

The original exception remained visible. Provider faults suspend the controller instead of causing five complete task retries. A new manifest recorded the audited streaming repair while retaining all 594 committed results and continuing the one outstanding task. Prompts, model options, and organization policy were unchanged.

This is engineering recovery evidence, not a new validation score or a reason to erase earlier request costs.
