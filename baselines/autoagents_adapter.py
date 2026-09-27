"""Official Manager/observers/Group/CustomAction with Ditto model and search transport."""
import asyncio, importlib, os, re, sys, types
from pathlib import Path
from bench_common import ROOT, SOURCES, RUNS, SCOPE, call, save_row, search_web
from repairs import install_autoagents_repairs
class AutoAgents:
    def __init__(self):
        source=SOURCES/'AutoAgents';sys.path.insert(0,str(source))
        os.chdir(source)
        owner=self
        class LLM:
            def __init__(self,*args,**kwargs):pass
            async def aask(self,prompt,system_msgs=None):
                content=call([{'role':'system','content':s} for s in (system_msgs or ['You are a helpful assistant.']) if s]+[{'role':'user','content':prompt}])
                owner.remember_roles(content)
                return content
        transport=types.ModuleType('autoagents.system.provider.llm_api');transport.LLMAPI=LLM
        sys.modules[transport.__name__]=transport
        import cfg
        cfg.LONG_TERM_MEMORY=False;cfg.TOTAL_COST=0;cfg.MAX_BUDGET=10
        from autoagents.system.tools import SearchEngineType
        from autoagents.system.tools.search_engine import SearchEngine
        cfg.SEARCH_ENGINE=SearchEngineType.CUSTOM_ENGINE
        original_search_init=SearchEngine.__init__
        def search_init(engine,*args,**kwargs):
            original_search_init(engine,*args,**kwargs)
            engine.engine=SearchEngineType.CUSTOM_ENGINE;engine.run_func=search_web
        SearchEngine.__init__=search_init
        from autoagents.explorer import Explorer
        from autoagents.roles import Manager
        from autoagents.environment import Environment
        from autoagents.actions.custom_action import CustomAction
        self.remember_roles,self.clear_roles=install_autoagents_repairs(call,lambda kind,error:save_row(RUNS/'AutoAgents/repairs.jsonl',{'taskId':SCOPE.get()[2],'kind':kind,'error':error}))
        self.Explorer=Explorer;self.Manager=Manager;self.answer=''
        original_publish=Environment.publish_message
        async def publish(env,message):
            info=getattr(message,'instruct_content',None)
            if info is not None and hasattr(info,'Response'):
                self.answer=info.Response
                if '>>>> Final Output' in self.answer:self.answer=self.answer.rsplit('>>>> Final Output',1)[1].split('>>>>',1)[0].strip()
            return await original_publish(env,message)
        Environment.publish_message=publish
        # Scratch files stay inside this benchmark's per-task directory.
        def save(action,filename,content):
            folder=RUNS/'AutoAgents/scratch'/SCOPE.get()[2].replace(':','-');folder.mkdir(parents=True,exist_ok=True)
            target=(folder/filename).resolve()
            if not target.is_relative_to(folder.resolve()):raise ValueError('Scratch path outside task directory')
            target.parent.mkdir(parents=True,exist_ok=True);target.write_text(content)
        CustomAction._save=save
        self.answer=''
    def solve(self,prompt):
        self.answer=''
        self.clear_roles()
        async def execute():
            team=self.Explorer();team.hire([self.Manager(llm_api_key='local-ditto-bridge')]);team.invest(10)
            await team.start_project(idea=prompt,llm_api_key='local-ditto-bridge',task_id=SCOPE.get()[2])
            await team.run(n_round=10)
        asyncio.run(execute());return self.answer
    def final(self):return self.answer
