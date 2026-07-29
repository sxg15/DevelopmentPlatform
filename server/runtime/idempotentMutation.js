export function findIdempotentMutation({
  items,
  clientMutationId,
  mutationFingerprint,
  belongsToActor = () => true,
  conflictMessage = 'clientMutationId 已用于不同的写操作',
}) {
  const normalizedMutationId = String(clientMutationId || '').trim();
  if (!normalizedMutationId) {
    return null;
  }

  const existing = (Array.isArray(items) ? items : []).find((item) => (
    String(item?.clientMutationId || item?.client_mutation_id || '').trim()
      === normalizedMutationId
    && belongsToActor(item)
  ));
  if (!existing) {
    return null;
  }

  const existingFingerprint = String(
    existing.mutationFingerprint || existing.mutation_fingerprint || '',
  ).trim();
  if (existingFingerprint !== String(mutationFingerprint || '').trim()) {
    const error = new Error(conflictMessage);
    error.statusCode = 409;
    throw error;
  }
  return existing;
}
