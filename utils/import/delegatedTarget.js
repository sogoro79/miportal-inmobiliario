// Delegated targets only: accept explicit supported values or genuine legacy
// field absence. Stored null/unknown values are never treated as absence.
const rules = { role: 'user', activo: true };
export function delegatedTargetFieldAllowed(user, field) {
  return Boolean(user) && (!Object.prototype.hasOwnProperty.call(user, field) || user[field] === rules[field]);
}
export function delegatedTargetFilter(userId) {
  return { _id: userId, $and: Object.entries(rules).map(([field, value]) =>
    ({ $or: [{ [field]: value }, { [field]: { $exists: false } }] })) };
}
