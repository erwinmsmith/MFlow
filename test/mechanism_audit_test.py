import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('audit', Path(__file__).resolve().parents[1] / 'scripts/audit_mechanisms.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class MechanismAudit(unittest.TestCase):
    def test_graph_renaming_is_not_new_structure_but_edges_and_types_are(self):
        a = [{'id':'root/x','type':'CONTEXT.LOAD','dependencies':[]}, {'id':'root/y','type':'INFER.REASONING.SAMPLE','dependencies':['root/x']}]
        b = [{'id':'renamed/b','type':'INFER.REASONING.SAMPLE','dependencies':['renamed/a']}, {'id':'renamed/a','type':'CONTEXT.LOAD','dependencies':[]}]
        self.assertEqual(audit.graph_key(a), audit.graph_key(b))
        b[0]['dependencies'] = []
        self.assertNotEqual(audit.graph_key(a), audit.graph_key(b))

    def test_missing_evidence_is_not_a_zero_spawn_observation(self):
        o=audit.Observations();o.add(None)
        x=o.finish()
        self.assertEqual(x['episodes'],1)
        self.assertEqual(x['lifecycleObserved'],0)
        self.assertNotIn('rootOnlyEpisodes',x)

    def test_registration_calls_and_cross_agent_reuse_are_separate(self):
        o=audit.Observations()
        o.add({'lifecycle':[{'action':'INITIAL','agentId':'root'}, {'action':'SPAWN','agentId':'child','parentId':'root'}],
               'tools':[{'creatorId':'root','origin':'generated','definition':{'name':'generated_check'}}],
               'toolUsage':[{'name':'create_tool','status':'failed','agentId':'root'}, {'name':'create_tool','status':'success','agentId':'root'}, {'name':'generated_check','status':'success','agentId':'child'}]})
        x=o.finish()
        self.assertEqual(x['createToolAttempts'],2)
        self.assertEqual(x['registeredGeneratedTools'],1)
        self.assertEqual(x['successfulGeneratedToolCalls'],1)
        self.assertEqual(x['crossAgentGeneratedToolCalls'],1)
        self.assertEqual(x['rootOnlyEpisodes'],0)

    def test_template_id_only_is_not_library_content_change(self):
        def candidate(name):return {'organization':{'agentTemplates':[{'id':name,'profile':{'id':name,'tools':[]},'composition':'return loop({});'}]}}
        x=audit.strategy_delta(candidate('a'),candidate('b'))
        self.assertFalse(x['normalizedLibraryChanged'])
        self.assertEqual(x['addedTemplates'],['b'])

    def test_round_id_only_is_a_repeat_but_instructions_are_not(self):
        a={'id':'round-1','composition':'return result;', 'instructions':'check'}
        b={**a,'id':'round-2'}
        self.assertTrue(audit.strategy_delta(a,b)['identicalExceptRoundId'])
        b['instructions']='check again'
        self.assertFalse(audit.strategy_delta(a,b)['identicalExceptRoundId'])

    def test_repeats_require_unique_matched_task_sets(self):
        self.assertTrue(audit.complete_task_sets([['a','b'],['b','a']],2,2))
        self.assertFalse(audit.complete_task_sets([['a','a'],['a','b']],2,2))
        self.assertFalse(audit.complete_task_sets([['a','b'],['a','c']],2,2))


if __name__=='__main__':unittest.main()
