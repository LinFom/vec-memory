const scopeKinds = new Set(['private', 'group', 'game', 'channel']);

export function createMoonMemoryAdapter({baseURL, spaceId, roleId, token, fetcher = fetch, timeoutMs = 2500}) {
  const origin = new URL(baseURL);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
    throw new TypeError('Provide a vec-memory HTTP(S) base URL');
  }
  for (const [name, value] of Object.entries({spaceId, roleId, token})) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(name + ' is required');
  }
  const base = origin.href.replace(/\/+$/, '') + '/api/v1/spaces/' + encodeURIComponent(spaceId);

  async function request(endpoint, body) {
    const response = await fetcher(base + '/' + endpoint, {
      method: 'POST',
      headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json();
    if (!response.ok || result?.ok !== true) {
      throw Object.assign(new Error('vec-memory request failed'), {status: response.status, code: result?.code});
    }
    return result;
  }

  function forConversation({kind, id}) {
    if (!scopeKinds.has(kind) || typeof id !== 'string' || !id.trim()) throw new TypeError('Invalid conversation scope');
    const scope = {kind, id: id.trim()};
    return {
      recall: ({query, limit} = {}) => request('recall', {query, limit, scope, purpose: 'query'}),
      temporalQuery: ({actorId, attribute, view} = {}) =>
        request('temporal-memory/query', {actorId, attribute, view, scope}),
      notes: () => request('role-notes/query', {roleId, scope}),
      tasks: () => request('continuity-tasks/query', {scope}),
      writeNote: input => request('role-notes', {...input, roleId, scope}),
      writeTask: input => request('continuity-tasks', {...input, scope}),
    };
  }

  return {forConversation};
}
