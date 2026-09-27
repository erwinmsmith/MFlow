"""Call the official SPP collaboration_func; adapt only MATH final-answer formatting."""
import sys
from bench_common import SOURCES, call
class EvoAgent:
    def __init__(self):
        import os
        os.environ['task']='logic';sys.path.insert(0,str(SOURCES/'EvoAgent/spp'))
        import util_func as official
        from langchain.prompts import PromptTemplate
        for name in ['multi_agent_prompt','refine_agent_prompt']:
            old=getattr(official,name)
            setattr(official,name,PromptTemplate(input_variables=old.input_variables,template=old.template.replace('Final Answer: choice: XX',r'Final Answer: \boxed{{your final answer}}')))
        self.answer=''
        def invoke(messages,*args):
            result=call(messages)
            if 'Revised Answer:' in messages[0]['content']:self.answer=result
            return result
        official.evaluator_construction=invoke;self.official=official
    def solve(self,prompt):
        self.answer=''
        self.answer=call([{'role':'user','content':prompt}])
        self.history,self.answer=self.official.collaboration_func(3,prompt,self.answer,'deepseek-flash','openai')
        return self.answer
    def final(self):return self.answer
