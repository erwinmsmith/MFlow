"""Call the official SPP collaboration_func with task-specific roles and answer contracts."""
import sys
from bench_common import SOURCES, PROTOCOL, call
class EvoAgent:
    def __init__(self):
        import os
        os.environ['task']='logic';sys.path.insert(0,str(SOURCES/'EvoAgent/spp'))
        import util_func as official
        from langchain.prompts import PromptTemplate
        context=('Create complementary API discovery, entity resolution, dependency execution or effect-audit expertise for the actual unresolved task. All experts share one task world: preserve successful writes and inspect current state before repairs.' if PROTOCOL.get('benchmark')=='automationbench' else
                 'Create expertise specific to the academic subject and unresolved assumption. Prefer independent methods, exact computation, counterexamples or source verification over repeated generic review. Inspect supplied images when relevant.' if PROTOCOL.get('benchmark')=='hle' else
                 'Create complementary mathematical expertise for a concrete gap: derivation, exact computation, case analysis or counterexample checking.')
        for name in ['meta_agent_prompt','check_agent_prompt']:
            old=getattr(official,name)
            setattr(official,name,PromptTemplate(input_variables=old.input_variables,template=context+'\n'+old.template))
        for name in ['multi_agent_prompt','refine_agent_prompt']:
            old=getattr(official,name)
            output='Final Summary: completed API effects, checked postconditions and concrete remaining blockers' if PROTOCOL.get('benchmark')=='automationbench' else 'Explanation: reasoning; Answer: precise answer or option letter; Confidence: 0-100%' if PROTOCOL.get('benchmark')=='hle' else r'Final Answer: \boxed{{your final answer}}'
            setattr(official,name,PromptTemplate(input_variables=old.input_variables,template=old.template.replace('Final Answer: choice: XX',output)))
        self.answer=''
        def invoke(messages,*args):
            design=PROTOCOL.get('benchmark') in ('automationbench','hle') and any(marker in messages[0]['content'] for marker in ['Now, you can give the description for a new expert','Give the reason first and then give the choice'])
            result=call(messages,tools=False) if design else call(messages)
            if 'Revised Answer:' in messages[0]['content']:self.answer=result
            return result
        official.evaluator_construction=invoke;self.official=official
    def solve(self,prompt):
        self.answer=''
        self.answer=call([{'role':'user','content':prompt}])
        self.history,self.answer=self.official.collaboration_func(3,prompt,self.answer,PROTOCOL['model'],'openai')
        return self.answer
    def final(self):return self.answer
