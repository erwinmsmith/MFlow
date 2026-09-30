"""Call the official SPP collaboration_func; adapt only MATH final-answer formatting."""
import sys
from bench_common import SOURCES, PROTOCOL, call
class EvoAgent:
    def __init__(self):
        import os
        os.environ['task']='logic';sys.path.insert(0,str(SOURCES/'EvoAgent/spp'))
        import util_func as official
        from langchain.prompts import PromptTemplate
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
