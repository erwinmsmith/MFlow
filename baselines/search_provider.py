"""External provider for public Ditto WebSearchProvider; pinned HLE retrieval rules."""
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit
from ddgs import DDGS


def hle_rules(question):
    home=Path(os.environ.get('BENCHMARK_HOME',Path(__file__).resolve().parents[2]/'Benchmarks'))
    rules=json.loads((home/'collections/hle/official/docs/blocklist.json').read_text())
    patterns=[re.compile(p,re.I) for p in rules['url_patterns']]+[re.compile(p) for p in rules['patterns_case_sensitive']]
    titles=[re.compile(p,re.I) for p in rules['answer_title_patterns']]
    words=lambda s:re.findall(r'\w+',s.casefold())
    question_words=words(question)
    # Official rules require rejecting long verbatim spans; this protocol uses 12 words.
    spans={tuple(question_words[i:i+12]) for i in range(len(question_words)-11)}
    def domain(host):return next((d for d in rules['domains'] if host==d or host.endswith('.'+d)),None)
    def blocked(query=None,result=None):
        if query is not None:
            for host in re.findall(r'\bsite:([^\s/]+)',query,re.I):
                if rule:=domain(host.lower()):return 'site:'+rule
            q=words(query)
            if any(tuple(q[i:i+12]) in spans for i in range(len(q)-11)):return 'verbatim-question-span-12-words'
            values=[query]
        else:
            url=result['href'];decoded=url
            for _ in range(3):decoded=unquote(decoded)
            for host in [urlsplit(url).hostname or '',*re.findall(r'https?://([^/\s]+)',decoded)]:
                if rule:=domain(host.lower()):return 'domain:'+rule
            clean=lambda s:re.sub(r'^https?://(?:www\.)?','',s,flags=re.I).lower()
            for prefix in rules['url_prefixes']:
                if clean(decoded).startswith(clean(prefix)):return 'url-prefix:'+prefix
            for pattern in rules['serp_url_patterns']:
                if re.search(pattern,decoded,re.I):return 'serp:'+pattern
            if (urlsplit(url).hostname or '') not in rules['answer_title_allow_hosts']:
                for pattern in titles:
                    if pattern.search(result['title']) or pattern.search(re.split(r'\s+[|–—-]\s+',result['title'])[0]):return 'answer-title:'+pattern.pattern
            values=[decoded,result['title'],result['body']]
        for pattern in patterns:
            if any(pattern.search(v) for v in values):return 'pattern:'+pattern.pattern
        return None
    return blocked


def log_blocked(task,query,rule,result=None):
    path=os.environ.get('MFLOW_HLE_BLOCKED_SEARCH_LOG')
    if path:
        import fcntl
        with Path(path).open('a') as stream:
            fcntl.flock(stream,fcntl.LOCK_EX)
            stream.write(json.dumps({'taskId':task,'query':query,'rule':rule,'result':result,'at':time.time()})+'\n')


if __name__=='__main__':
    query=sys.argv[1];check=hle_rules(sys.argv[3]) if len(sys.argv)>3 else None
    if check and (rule:=check(query=query)):
        log_blocked(sys.argv[4],query,rule);rows=[]
    else:
        rows=DDGS(timeout=30).text(query,max_results=int(sys.argv[2]),backend='duckduckgo')
        if check:
            allowed=[]
            for row in rows:
                if rule:=check(result=row):log_blocked(sys.argv[4],query,rule,row)
                else:allowed.append(row)
            rows=allowed
    print(json.dumps([{'title':r['title'],'url':r['href'],'snippet':r['body']} for r in rows]))
