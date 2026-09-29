"""Resume an already frozen AFlow test; transport outages cannot become wrong answers."""
import asyncio
import json
import sys
import urllib.error
from pathlib import Path


class InfrastructureUnavailable(BaseException):
    """Bypass the official workflow's answer-generation retries and scoring."""


def guard_transport(call, transport_error):
    def guarded(*args, **kwargs):
        try:
            return call(*args, **kwargs)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            raise InfrastructureUnavailable(str(error)) from None
        except transport_error as error:
            # Preserve the original method's handling of a model output limit.
            if str(error).startswith('Provider context/output ceiling reached'):
                raise
            raise InfrastructureUnavailable(str(error)) from None
    return guarded


def main():
    root = Path(__file__).resolve().parents[1]
    # The local scripts/benchmarks.py must not shadow AFlow's benchmarks package.
    sys.path = [str(root / 'baselines')] + [p for p in sys.path if Path(p).resolve() != root / 'scripts']
    sys.argv = ['aflow.py', '--phase', 'search-test']
    import aflow
    from bench_common import TransportFailure

    out = aflow.RUNS / 'AFlow'
    if not (out / 'frozen.json').exists():
        raise RuntimeError('This recovery requires an already frozen strategy; it cannot restart search')
    # main() validates the original manifest and selected workflow hashes, then
    # test() skips completed task IDs, including completed incorrect answers.
    aflow.call = guard_transport(aflow.call, TransportFailure)
    try:
        asyncio.run(aflow.main())
    except InfrastructureUnavailable as error:
        results = out / 'test/results.jsonl'
        completed = len(results.read_text().splitlines()) if results.exists() else 0
        (out / 'test/recovery-status.json').write_text(json.dumps({
            'status': 'interrupted', 'completed': completed, 'planned': 486,
            'error': str(error), 'reason': 'Transport failure; no score written for the interrupted task',
        }, indent=2) + '\n')
        raise SystemExit(str(error)) from None
    (out / 'test/recovery-status.json').write_text(json.dumps({'status': 'completed', 'planned': 486}) + '\n')


if __name__ == '__main__':
    main()
