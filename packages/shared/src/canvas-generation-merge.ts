type Element = Record<string, unknown>;

const geometryKeys = ["x", "y", "width", "height", "angle", "frameId", "groupIds", "locked", "isDeleted"];
const geometryOf = (element: Element) => Object.fromEntries(geometryKeys
  .filter(key => element[key] !== undefined).map(key => [key, element[key]]));
const versionOf = (element: Element) => Number(element.version ?? 0);
const submissionRevision = (request: Element | undefined) =>
  typeof request?.submissionRevision === "number" && Number.isSafeInteger(request.submissionRevision)
    ? request.submissionRevision : 0;

/** Completion changes content, while a concurrent drag may change geometry. */
export function mergeCompletedImageReplacement(a: Element, b: Element): Element | null {
  if (a.id !== b.id) return null;
  const dataA = a.customData as Element | undefined;
  const dataB = b.customData as Element | undefined;
  const isPending = (data: Element | undefined) =>
    data?.type === "image-replacement" || data?.type === "image-generator";
  const pending = isPending(dataA) ? a : isPending(dataB) ? b : null;
  const image = a.type === "image" ? a : b.type === "image" ? b : null;
  if (!pending || !image) return null;
  const jobId = (pending.customData as Element)?.jobId;
  const requestId = ((pending.customData as Element)?.nodeImageRequest as Element | undefined)?.requestId;
  const matchesJob = typeof jobId === "string" && (image.customData as Element)?.sourceJobId === jobId;
  // A response may be lost before the browser learns jobId. The server carries
  // the frozen node request identity onto its completed image for this case.
  const matchesRequest = typeof requestId === "string" && (image.customData as Element)?.sourceRequestId === requestId;
  // A tab opened before submission (or before an earlier attempt completed)
  // has no current request identity. Completion of this same generator node
  // is authoritative regardless of the stale tab's request or element version.
  const completedGenerator = (pending.customData as Element)?.type === "image-generator" &&
    (image.customData as Element)?.sourceNodeType === "image-generator";
  if (!matchesJob && !matchesRequest && !completedGenerator) return null;
  if (Number(pending.version ?? 0) < Number(image.version ?? 0)) return image;
  const geometry = geometryOf(pending);
  return { ...image, ...geometry, version: Math.max(Number(pending.version ?? 0), Number(image.version ?? 0)) + 1,
    versionNonce: (Number(pending.versionNonce ?? 0) + 1) % 2147483647 };
}

/** Accept durable progress while preserving a newer local move or tombstone. */
export function mergePendingNodeImageSubmission(a: Element, b: Element): Element | null {
  if (a.id !== b.id) return null;
  const da = a.customData as Element | undefined;
  const db = b.customData as Element | undefined;
  if (da?.type !== "image-generator" || db?.type !== "image-generator") return null;
  const ra = da.nodeImageRequest as Element | undefined;
  const rb = db.nodeImageRequest as Element | undefined;
  const acceptedA = ra?.state === "accepted" && typeof da.jobId === "string";
  const acceptedB = rb?.state === "accepted" && typeof db.jobId === "string";
  let accepted = acceptedA ? a : acceptedB ? b : null;
  if (!accepted) return null;
  const base = versionOf(b) > versionOf(a) ? b : a;
  if (acceptedA && acceptedB) {
    const revisionA = submissionRevision(ra);
    const revisionB = submissionRevision(rb);
    if (revisionA !== revisionB) accepted = revisionA > revisionB ? a : b;
    else if (ra?.requestId === rb?.requestId && da.jobId === db.jobId) accepted = base;
    else return null; // Legacy unrelated attempts have no reliable ordering.
  } else {
    const otherRequest = accepted === a ? rb : ra;
    const acceptedRequest = accepted === a ? ra : rb;
    // A terminal attempt may be replaced by an explicit new submission. An
    // active attempt, however, cannot lose its binding to any old browser copy.
    if ((accepted.customData as Element).status === "error" &&
      typeof otherRequest?.requestId === "string" &&
      otherRequest.requestId !== acceptedRequest?.requestId) return null;
  }
  const acceptedData = accepted.customData as Element;
  const request = acceptedData.nodeImageRequest as Element;
  // After failure the visible fields become an editable draft for the next
  // explicit retry; the old request record itself remains frozen.
  const frozenData = Object.fromEntries((acceptedData.status === "error" ? [] : ["prompt", "model", "aspectRatio", "quality"])
    .filter(key => request[key] !== undefined).map(key => [key, request[key]]));
  if (accepted === base && Object.entries(frozenData).every(([key, value]) => acceptedData[key] === value)) return base;
  return { ...accepted, ...geometryOf(base), version: Math.max(versionOf(a), versionOf(b)) + 1,
    versionNonce: (Number(base.versionNonce ?? 0) + 1) % 2147483647,
    customData: { ...acceptedData, ...frozenData } };
}
