// In-memory Mongo model double. Never opens a connection.
export function providerSnapshotStore() {
  const docs = new Map(), effects = { reads: 0, inserts: 0, inits: 0, sessions: [] }, faults = {};
  const matches = (doc, filter) => Object.entries(filter).every(([key, value]) => value?.$gte
    ? new Date(doc[key]) >= value.$gte : String(doc[key]) === String(value));
  function query(read) {
    return { select() { return this; }, lean() { return this; }, session(session) { effects.sessions.push(session); return this; },
      then(resolve, reject) { return Promise.resolve().then(read).then(value => structuredClone(value)).then(resolve, reject); } };
  }
  const Model = {
    async init() { effects.inits++; },
    findOne(filter) {
      effects.reads++;
      return query(async () => {
        if (faults.read) throw new Error("private database error");
        await faults.beforeRead?.();
        return [...docs.values()].find(doc => matches(doc, filter)) || null;
      });
    },
    findOneAndUpdate(filter, update, options) {
      if (!options.upsert || !options.new || !update.$setOnInsert || update.$set) throw new Error("Expected insert-only snapshot");
      return query(() => {
        if (faults.write) throw new Error("private database error");
        const id = String(filter.runId);
        if (!docs.has(id)) { docs.set(id, structuredClone(update.$setOnInsert)); effects.inserts++; }
        return docs.get(id);
      });
    }
  };
  return { Model, docs, effects, faults };
}
