"""Provider adapter for Ditto's public WebSearchProvider interface (no agent logic)."""
import json
import sys
from ddgs import DDGS

if __name__=='__main__':
    rows=DDGS(timeout=30).text(sys.argv[1],max_results=int(sys.argv[2]),backend='duckduckgo')
    print(json.dumps([{'title':r['title'],'url':r['href'],'snippet':r['body']} for r in rows]))
