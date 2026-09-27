"""Run the unmodified official MATH script for each canonical problem."""
import importlib.util, json, os, runpy, sys, tempfile
from pathlib import Path
from bench_common import SOURCES, RUNS, call
class DyLAN:
    def __init__(self):
        self.path=SOURCES/'DyLAN/code/MATH/llmlp_gen_math_listwise_deeper_markov.py'
        sys.path.insert(0,str(self.path.parent))
        import util
        self.util=util;self.answers=[]
    def final(self):
        answers=[self.util.extract_math_answer(s) for s in self.answers]
        if not answers:return ''
        return max(answers,key=lambda a:sum(self.util.is_equiv(a,b) for b in answers))
    def solve(self,prompt):
        import openai
        self.answers=[]
        def generate(**kwargs):
            messages=kwargs['messages'];content=call(messages)
            if 'Please choose the best 2 solutions' not in messages[-1]['content']:self.answers.append(content)
            return {'choices':[{'message':{'content':content}}]}
        previous=openai.ChatCompletion.create;openai.ChatCompletion.create=generate
        old_argv=sys.argv;old_cwd=Path.cwd()
        try:
            RUNS.mkdir(parents=True,exist_ok=True)
            with tempfile.TemporaryDirectory(prefix='dylan-',dir=RUNS) as scratch:
                data=Path(scratch)/'inputs';data.mkdir()
                # The upstream script stores this unused reference in its output; real gold stays in the evaluator.
                (data/'0.json').write_text(json.dumps({'problem':prompt,'level':'Level 5','type':'MATH','solution':r'\boxed{0}'}))
                os.chdir(scratch);sys.argv=[str(self.path),str(data),'0','0','deepseek-flash','deepseek-flash']
                result=runpy.run_path(str(self.path),run_name='__main__')
                contexts=next(iter(result['response_dict'].values()))[0]
                self.answers=[c[-1]['content'] for c in contexts]
                return self.final()
        finally:
            sys.argv=old_argv;os.chdir(old_cwd);openai.ChatCompletion.create=previous
