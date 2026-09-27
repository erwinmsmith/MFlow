"""Syntax/serialization repairs only; no benchmark answers or scoring feedback."""
import ast
import json
import re


def unfence(text):
    text=text.strip()
    if text.startswith('```') and text.endswith('```'):
        return text.split('\n',1)[1].rsplit('```',1)[0].strip()
    return text


def validate_workflow(response):
    result=dict(response)
    graph=unfence(result['graph']);prompt=unfence(result['prompt'])
    tree=ast.parse(graph)
    required={n.attr for n in ast.walk(tree) if isinstance(n,ast.Attribute) and isinstance(n.value,ast.Name) and n.value.id=='prompt_custom'}
    def defined(source):
        parsed=ast.parse(source)
        return {n.id for n in ast.walk(parsed) if isinstance(n,ast.Name) and isinstance(n.ctx,ast.Store)}
    if required-defined(prompt):
        lines=prompt.splitlines()
        if lines and all(not line.strip() or line.lstrip().startswith('#') for line in lines):
            uncommented='\n'.join(re.sub(r'^\s*# ?', '',line) for line in lines)
            if not required-defined(uncommented):prompt=uncommented
    missing=required-defined(prompt)
    if missing:raise ValueError('Undefined prompt_custom names: '+', '.join(sorted(missing)))
    compile(graph,'graph.py','exec');compile(prompt,'prompt.py','exec')
    result.update(graph=graph,prompt=prompt)
    return result


def parse_roles(text):
    """Read role sections, never task text, with a JSON decoder aware of quoted braces."""
    sections=re.findall(r'##\s*(?:Selected|Created) Roles List\s*:?\s*\n(.*?)(?=\n\s*##|\Z)',text,re.S|re.I)
    if not sections:raise ValueError('Missing role sections')
    roles=[]
    for section in sections:
        decoder=json.JSONDecoder();index=0
        while index<len(section):
            start=section.find('{',index)
            if start<0:break
            try:role,end=decoder.raw_decode(section,start)
            except json.JSONDecodeError:
                # Some upstream examples use double braces around valid JSON.
                if section[start:start+2]=='{{':index=start+1;continue
                raise ValueError('Invalid JSON in role section') from None
            index=end
            if not isinstance(role,dict) or not role:continue
            for key in ('name','description','tools','suggestions','prompt'):
                if key not in role:raise ValueError('Missing role field: '+key)
            if not isinstance(role['tools'],list):raise ValueError('Role tools must be a list')
            roles.append(role)
    if not roles:raise ValueError('No executable roles found')
    return roles


def canonical_sections(info):
    return '\n\n'.join('## '+name+'\n'+str(value) for name,value in info.dict().items())


def validate_role_plan(text):
    roles=parse_roles(text)
    normalize=lambda s:re.sub(r'[^a-z0-9]','',s.lower())
    names={normalize(r['name']) for r in roles}
    plan=re.search(r'##\s*Execution Plan\s*:?\s*\n(.*?)(?=\n\s*##|\Z)',text,re.S|re.I)
    if not plan:raise ValueError('Missing execution plan')
    for group in re.findall(r'^\s*\d+[.)]\s*\[([^\]]+)\]',plan.group(1),re.M):
        for name in re.split(r',|;',group):
            if normalize(name) in names:continue
            for part in re.split(r'\s+and\s+',name):
                if normalize(part) not in names:raise ValueError('Plan role has no definition: '+part.strip())
    return roles


def install_autoagents_repairs(call,save_event):
    from autoagents.environment import Environment
    from autoagents.roles.group import Group
    from autoagents.actions.create_roles import PROMPT_TEMPLATE
    import autoagents.actions.create_roles as roles_module
    # Correct the invalid JSON example (double braces and trailing comma).
    roles_module.PROMPT_TEMPLATE=PROMPT_TEMPLATE.replace('{{{{','{{').replace('}}}}','}}').replace('"ROLE PROMPT",','"ROLE PROMPT"')
    Environment._parser_roles=lambda self,text:parse_roles(text)
    history=[]
    def remember(content):
        if 'Roles List' in content:history.append(content)
    original=Environment.publish_message
    async def publish(self,message):
        if 'Manager' in message.role and message.instruct_content is not None:
            text=canonical_sections(message.instruct_content)
            while True:
                try:validate_role_plan(text);break
                except ValueError as error:
                    save_event('roles_format_repair',str(error))
                    text=call([{'role':'system','content':'Repair serialization and role-reference consistency. Preserve the execution plan and intended roles. Return the same ## sections with valid complete role JSON objects. Restore definitions of roles referenced by the plan from previous drafts. Do not solve the task or add unplanned roles.'},{'role':'user','content':json.dumps({'current':text,'previousRoleDrafts':history,'error':str(error)})}])
            message.content=text
        return await original(self,message)
    Environment.publish_message=publish
    original_think=Group._think
    async def think(self):
        await original_think(self)
        if not self.next_step:return
        normalize=lambda s:re.sub(r'[^a-z0-9]','',s.lower())
        header=normalize(self.next_step.split(':',1)[0])
        self.next_state=[i for i,action in enumerate(self._actions) if normalize(str(action).removesuffix('_Action')) in header]
        if not self.next_state:
            names=[str(action).removesuffix('_Action') for action in self._actions]
            while not self.next_state:
                save_event('role_reference_repair',self.next_step)
                reply=call([{'role':'system','content':'Normalize abbreviated role references in an existing execution plan. Return ONLY a JSON array of exact registered role names that the step already refers to. Do not add roles or redesign the plan.'},{'role':'user','content':json.dumps({'step':self.next_step,'registeredRoles':self.roles,'exactNames':names})}])
                try:
                    selected=json.loads(unfence(reply))
                    if isinstance(selected,list) and selected and all(name in names for name in selected):self.next_state=[names.index(name) for name in selected]
                except (ValueError,TypeError):pass
    Group._think=think
    # API transport handles scheduling; this historical delay does not affect the algorithm.
    import autoagents.roles.group as group_module
    group_module.SLEEP_RATE=0
    return remember,history.clear
