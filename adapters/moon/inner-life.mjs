const chatKeyPattern = /^(private|group):(.+)$/;

export function installInnerLifeMemory(adapter, host = globalThis) {
  const key = '__MOON_MEMBUS__';
  if (host[key] != null) throw new Error('Disable the original moon-membus before installing vec-memory');

  async function load(input, select) {
    const match = chatKeyPattern.exec(input?.chatKey ?? '');
    if (!match) return {ok: false, hits: [], why: 'invalid-chat'};
    try {
      const chat = adapter.forConversation({kind: match[1], id: match[2]});
      return {ok: true, hits: await select(chat, match[0])};
    } catch {
      return {ok: false, hits: [], why: 'vec-memory-unavailable'};
    }
  }

  const facade = Object.freeze({
    ready: true,
    recallFor: input => load(input, async (chat, chatKey) => {
      if (typeof input.query !== 'string' || !input.query.trim()) return [];
      const {items} = await chat.recall({query: input.query, limit: input.limit, mode: 'keyword', automatic: true});
      return items.filter(item => item.sourceRefs?.length &&
        item.sourceRefs.every(ref => ref.chatKey === chatKey && ref.type === 'message'))
        .slice(0, input.limit ?? 6)
        .map(item => ({id: item.id, text: item.text, kind: 'event', sourceRefs: item.sourceRefs}));
    }),
    restoreFor: input => load(input, async chat => {
      if (!input.chatKey.startsWith('private:')) return [];
      const [{items: tasks}, {items: notes}] = await Promise.all([chat.tasks(), chat.notes()]);
      return [...tasks.map(item => ({...item, id: 'task:' + item.id})),
        ...notes.map(item => ({...item, id: 'note:' + item.id}))]
        .slice(0, input.limitOpen ?? 3)
        .map(item => ({id: item.id, text: item.text, kind: 'open', sourceRefs: item.sourceRefs}));
    }),
  });
  host[key] = facade;
  return () => {
    if (host[key] === facade) delete host[key];
  };
}
