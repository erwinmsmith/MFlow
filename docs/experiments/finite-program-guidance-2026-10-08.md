# Finite program output repair — 2026-10-08

## Observed problem

DROP policy decisions sometimes continued debating inside JSON string fields.
MBPP Python tool arguments sometimes grew to hundreds of thousands of characters
and ended as invalid, truncated JSON. Exact-cycle detection does not cover all
such output. A generated DROP outer composition also used bound-agent context
fields, causing `Unknown agent undefined`.

## Change

The application adds a shared formatting instruction to future requests that
expose Python tools or request structured JSON. It asks for finite executable
programs, loops instead of unrolled calculations, concise decision evidence and
properly closed JSON. MAS optimization requests also clarify the outer versus
bound-agent context contract. It preserves agent diversity, tool creation and
the searched dynamic routing. Model, temperature, token/context allowances,
tool schemas, datasets and native AFlow search/selection are unchanged.

This is preventive prompt guidance, not a proof that every future long response
will terminate promptly. Existing exact-cycle and code execution guards remain.

## Deployment without cancelling requests

`installGenerationGuidance()` wraps application-level fetch for future calls.
It leaves already started fetches, streams, signals, responses and usage settlement
alone. Ditto's published provider continues to own request execution and parsing.
`scripts/install_generation_guidance.mjs` uses the local Node inspector without
pausing execution, checks both PID and working directory, verifies the repair
module checksum inside the target process, and closes the inspector it opened.
It is only an explicit repair utility, not a remote service or background monitor.

Deployment receipts record each process and activation time outside the code
snapshot. A recorded bootstrap addition to the existing external repair hook
preserves the guidance if its supervisor later restarts an actor. Original hooks
are archived with their checksums; frozen experiment source is unchanged.

Existing answers and token records are retained, including old requests that
finish after activation. Evaluations spanning activation therefore have mixed
prompt versions, which must be disclosed in later comparisons. Completed
baselines are not resampled. All subsequent Python/JSON requests from the active
MFlow and baseline processes receive the same guidance.

## Verification

Regression checks verify request settings/schema preservation and idempotency.
A live fixture starts a pending request, installs the wrapper through the same
inspector utility, and verifies that the original answer completes unchanged
while only the following request receives guidance. This fixture makes no paid
model calls and is not benchmark quality evidence.
