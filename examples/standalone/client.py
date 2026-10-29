"""Python standard library client. Set VEC_TOKEN and VEC_SPACE first."""
import json
import os
import uuid
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.parse import quote

base = os.environ.get('VEC_BASE_URL', 'http://127.0.0.1:8091').rstrip('/')
token, space = os.environ['VEC_TOKEN'], os.environ['VEC_SPACE']

def request(route, body=None):
    data = None if body is None else json.dumps(body).encode('utf-8')
    req = Request(f'{base}/api/v1/spaces/{quote(space, safe="")}/{route}', data=data,
                  headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    with urlopen(req, timeout=30) as response:
        result = json.load(response)
    if result.get('ok') is False:
        raise RuntimeError(result.get('code', result.get('error')))
    return result

conversation = 'python-demo'
scope = {'kind': 'private', 'id': conversation}
print(request('messages', {'messages': [{'messageId': str(uuid.uuid4()),
    'conversationId': conversation, 'actorId': 'demo-user', 'role': 'user',
    'timestamp': datetime.now(timezone.utc).isoformat(), 'text': '我喜欢不加糖的茶。', 'scope': scope}]}))
# Model calls require explicit opt-in.
if os.environ.get('VEC_RUN_CONSOLIDATE') == '1':
    job_id = request('jobs', {'type': 'consolidate'})['jobId']
    deadline = time.monotonic() + 300
    while True:
        job = request(f'jobs/{quote(job_id, safe="")}')['job']
        if job['status'] == 'failed':
            raise RuntimeError(f'Consolidation failed: {job.get("error")}')
        if job['status'] == 'completed':
            print(job)
            break
        if time.monotonic() > deadline:
            raise TimeoutError(f'Job {job_id} still pending; query its status to resume')
        time.sleep(1)
recalled = request('recall', {'query': '我喜欢喝什么？', 'conversationId': conversation,
    'scope': scope, 'actorIds': ['demo-user']})
print(recalled)
# Confirm only after appending the returned items to the actual model context.
if os.environ.get('VEC_CONFIRM_ADOPTION') == '1' and recalled.get('receiptId'):
    print(request('adoptions', {'receiptId': recalled['receiptId'],
        'itemIds': [item['id'] for item in recalled['items']]}))
