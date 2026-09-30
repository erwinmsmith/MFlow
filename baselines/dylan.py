"""Run the unmodified official MATH script for each canonical problem."""
import ast, importlib.util, json, os, runpy, sys, tempfile
from pathlib import Path
from bench_common import SOURCES, RUNS, PROTOCOL, call
class DyLAN:
    def __init__(self):
        self.path=SOURCES/'DyLAN/code/MATH/llmlp_gen_math_listwise_deeper_markov.py'
        sys.path.insert(0,str(self.path.parent))
        import util
        self.util=util;self.answers=[]
    def final(self):
        if PROTOCOL.get('benchmark')=='automationbench':
            return self.answers[-1] if self.answers else ''
        answers=[self.util.extract_math_answer(s) for s in self.answers]
        if not answers:return ''
        return max(answers,key=lambda a:sum(self.util.is_equiv(a,b) for b in answers))
    def solve(self,prompt):
        import openai
        self.answers=[]
        def generate(**kwargs):
            messages=kwargs['messages'];ranking='Please choose the best 2 solutions' in messages[-1]['content']
            content=call(messages,tools=False) if PROTOCOL.get('benchmark')=='automationbench' and ranking else call(messages)
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
                os.chdir(scratch);sys.argv=[str(self.path),str(data),'0','0',PROTOCOL['model'],PROTOCOL['model']]
                if PROTOCOL.get('benchmark')=='automationbench':
                    # Adapt prompt/answer IO only; official debate, pruning and consensus remain intact.
                    tree=ast.parse(self.path.read_text())
                    for node in ast.walk(tree):
                        if isinstance(node,ast.Constant) and isinstance(node.value,str):
                            node.value=node.value.replace('Follow the given examples and answer the mathematics problem.','Inspect and complete the requested API workflow. Use previous agents as evidence; verify current state and repair missing effects without duplicating writes. End with Final Summary: followed by factual completed effects.')
                    for node in tree.body:
                        if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='EXAMPLES' for t in node.targets):node.value=ast.Constant('')
                    # Override imported math normalization before the untouched __main__ controller.
                    index=next(i for i,n in enumerate(tree.body) if isinstance(n,ast.If) and ast.unparse(n.test)=="__name__ == '__main__'")
                    tree.body[index:index]=ast.parse("extract_math_answer=lambda s: s.rsplit('Final Summary:',1)[-1].strip().lower()\nis_equiv=lambda a,b: a==b").body
                    result={'__name__':'__main__','__file__':str(self.path)};exec(compile(ast.fix_missing_locations(tree),str(self.path),'exec'),result)
                else:result=runpy.run_path(str(self.path),run_name='__main__')
                contexts=next(iter(result['response_dict'].values()))[0]
                self.answers=[c[-1]['content'] for c in contexts]
                return self.final()
        finally:
            sys.argv=old_argv;os.chdir(old_cwd);openai.ChatCompletion.create=previous
