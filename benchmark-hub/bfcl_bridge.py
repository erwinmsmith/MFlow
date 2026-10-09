"""Pinned official BFCL controller/environment/scorer; Ditto owns inference and actions.

One process per task keeps BFCL's module-global worlds and RNG task-local. The
JSON-lines callback protocol lets a registered Ditto tool enter the official
environment while the unmodified BFCL controller waits for its action result.
"""
import argparse
import ast
import contextlib
import copy
import json
import os
from pathlib import Path
import sys
import time


def send(value):
    print(json.dumps(value, ensure_ascii=False), file=sys.__stdout__, flush=True)


def literal_call(source):
    call = ast.parse(source, mode="eval").body
    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.args:
        raise ValueError("Only named BFCL functions with keyword literals are permitted")
    if any(k.arg is None for k in call.keywords):
        raise ValueError("Expanded arguments are not permitted")
    return {"name": call.func.id, "arguments": {k.arg: ast.literal_eval(k.value) for k in call.keywords}, "source": source}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--official", type=Path, required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--project", required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.official))
    os.environ["BFCL_PROJECT_ROOT"] = args.project
    # Controller progress is intentionally suppressed; parent records compact progress.
    with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet):
        from bfcl_eval.model_handler import base_handler
        from bfcl_eval.model_handler.base_handler import BaseHandler
        from bfcl_eval.model_handler.api_inference.openai_completion import OpenAICompletionsHandler
        from bfcl_eval.constants.enums import ModelStyle
        from bfcl_eval.constants.default_prompts import MAXIMUM_STEP_LIMIT
        from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_utils import execute_multi_turn_func_call, is_empty_execute_response
        from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_checker import multi_turn_checker
        from bfcl_eval.utils import populate_test_cases_with_predefined_functions

        category = args.task.rsplit("_", 1)[0]
        if category not in ("multi_turn_base", "multi_turn_miss_param", "multi_turn_miss_func", "multi_turn_long_context"):
            raise ValueError("Unsupported BFCL category")
        data = args.official / "bfcl_eval/data"
        entry = next(json.loads(line) for line in (data / f"BFCL_v4_{category}.json").read_text().splitlines() if json.loads(line)["id"] == args.task)
        prompt = copy.deepcopy(entry)
        entry = populate_test_cases_with_predefined_functions([entry])[0]
        native_scope = (entry.get("initial_config", {}), entry["involved_classes"], "ditto_single", entry["id"])
        long_context = "long_context" in category
        allowed = set()
        pending_sources = set()
        unavailable_calls = []

        def native(source):
            call = literal_call(source)
            if source not in pending_sources or call["name"] not in allowed:
                return f"Error during execution: function {call['name']} is not currently available."
            return execute_multi_turn_func_call([source], *native_scope, long_context=long_context)[0][0]

        def rpc(op, **body):
            send({"op": op, **body})
            while True:
                line = sys.stdin.readline()
                if not line:
                    raise EOFError("Ditto parent closed")
                response = json.loads(line)
                if response.get("op") == "execute-native":
                    try:
                        send({"op": "native-result", "result": native(response["source"])})
                    except Exception as exc:
                        send({"op": "native-result", "error": str(exc)})
                    continue
                if response.get("error"):
                    raise RuntimeError(response["error"])
                return response["result"]

        def via_ditto(calls, *scope, **options):
            # Empty calls initialize/log state only; model-requested actions all go via Ditto.
            if not calls:
                return execute_multi_turn_func_call(calls, *scope, **options)
            decoded = [literal_call(source) for source in calls]
            unavailable_calls.extend(c["name"] for c in decoded if c["name"] not in allowed)
            pending_sources.clear()
            pending_sources.update(calls)
            try:
                result = rpc("tools", calls=decoded)
            finally:
                pending_sources.clear()
            instances = execute_multi_turn_func_call([], *scope, **options)[1]
            return result, instances

        class DittoHandler(OpenAICompletionsHandler):
            def __init__(self):
                BaseHandler.__init__(self, "ditto_single", 0, "ditto-single-FC", True)
                self.model_style = ModelStyle.OPENAI_COMPLETIONS

            def _query_FC(self, inference_data):
                allowed.clear()
                allowed.update(t["function"]["name"] for t in inference_data["tools"])
                start = time.monotonic()
                result = rpc("sample", messages=inference_data["message"], tools=inference_data["tools"])
                return result, time.monotonic() - start

            def _parse_query_response_FC(self, result):
                return result

            def decode_execute(self, result, has_tool_call_tag):
                calls = super().decode_execute(result, has_tool_call_tag)
                for source in calls:
                    literal_call(source)  # Reject executable expressions before native eval.
                return calls

        base_handler.execute_multi_turn_func_call = via_ditto
        handler = DittoHandler()
        results, metadata = handler.inference(entry, include_input_log=False, exclude_state_log=True)
        # Persist generated responses before opening reference answers or running grading.
        rpc("checkpoint", result=results, officialStepLimit=MAXIMUM_STEP_LIMIT)
        answers = next(json.loads(line) for line in (data / "possible_answer" / f"BFCL_v4_{category}.json").read_text().splitlines() if json.loads(line)["id"] == args.task)
        # Execute the exact pinned official entry evaluator without importing every
        # unrelated provider SDK pulled in by eval_runner's top-level model registry.
        source_path = args.official / "bfcl_eval/eval_checker/eval_runner.py"
        source = ast.parse(source_path.read_text())
        function = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == "_evaluate_single_multi_turn_entry")
        namespace = {"BaseHandler": BaseHandler, "multi_turn_checker": multi_turn_checker, "is_empty_execute_response": is_empty_execute_response}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source_path), "exec"), namespace)
        # Never replay an unregistered function into the official eval-based executor.
        graded = ({"valid": False, "error": {"error_type": "unavailable_tool", "error_message": unavailable_calls}}
                  if unavailable_calls else namespace[function.name](handler, args.task, results, answers["ground_truth"], prompt, "ditto_single", category))
        error = graded.get("error", {})
        send({"op": "done", "result": {"id": args.task, "category": category, "score": int(graded["valid"]),
              "errorType": error.get("error_type"), "errorMessage": error.get("error_message"),
              "turns": len(results), "inputTokens": metadata["input_token_count"], "outputTokens": metadata["output_token_count"]}})


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        send({"op": "error", "error": f"{type(exc).__name__}: {exc}"})
        sys.exit(1)
