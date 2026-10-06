# Qwen MATH recovery — 2026-10-07

The hb comparison uses the published Ditto package, Qwen3.5-9B Q4_K_M, and
the pinned AFlow MATH split: 119 search tasks and 486 test tasks. Split IDs
and exact prompts are disjoint. Completed incorrect results are retained.

The previous MFlow optimizer request exceeded the server's 65,536-token slot
context (71,327 tokens). `search_evidence.py` factors repeated JSON values into
explicit references; definitions retain original values. It does not truncate
programs, node contracts, examples or answers. The recovered parent evidence
decreased from 39,467 to 18,333 tokens using the server tokenizer.

The MATH AFlow adapter now checkpoints candidate hashes, parent experience,
controller round and RNG state. Search results resume by candidate, validation
repeat and task ID, including wrong answers; only complete candidates can be
selected for final test. Known model output faults from old transport adapters
enter native answer recovery instead of being treated as network outages.
MATH bridge retries need no world-session reset because their calls are stateless.

Recovery snapshot: `hb:/home/b/project/experiments/qwen-math-20261007-repair`.
MFlow/AFlow run: `hb:/home/b/project/MFlow/runs/hb-qwen-math-20261007-repair`.
The original snapshot and result files remain available. `recovery.json` records
changed code hashes and preserved result hashes. MFlow's five completed Round 1
passes and AFlow's 119 Round 1 plus three Round 2 results are reused.

The legacy AFlow adapter did not save its RNG or pending modification text.
Round 1 is the only eligible parent of the existing Round 2 candidate. Recovery
records that ancestry and the exact source diff, and explicitly seeds future
proposals at 42. This is a documented continuation branch, not bit-for-bit replay
of the original search trajectory. Existing candidate programs and scores stay
unchanged; subsequent restarts use persisted RNG state.

The original DyLAN process is allowed to drain. Its repaired continuation and
EvoAgent/AutoAgents use a separate legacy run directory after handoff, preventing
two supervisors from writing one `jobs.json`. HLE and local DeepSeek runs are
outside this recovery. Model quality is measured only by the real run, not the
scripted regression checks.
