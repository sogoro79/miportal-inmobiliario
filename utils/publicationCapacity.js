// A write to the owner document, not a commercial counter or a separate mutex.
export async function fencePublicationUser(UsuarioModel, usuarioId, session, options = {}) {
  return UsuarioModel.updateOne({ _id: usuarioId, activo: { $ne: false } },
    { $inc: { publicationVersion: 1 } }, { session, ...options });
}

export const publicationTransactionOptions = Object.freeze({
  readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000
});
