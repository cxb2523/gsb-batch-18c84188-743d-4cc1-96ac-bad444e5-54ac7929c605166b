// Wet marks are stored in pose-independent rest coordinates. A hit on the
// deformed mesh is mapped back to its nearest rest vertex, and the fabric
// shader compares the mark against the `restPosition` attribute, so the stain
// stays attached to the same piece of skin after the leg changes pose.
const lookupCache = new WeakMap();

export function restPointAt(mesh, worldPoint) {
  const geometry = mesh.geometry;
  const rest = geometry.getAttribute?.('restPosition');
  if (!rest) return null;

  let members = lookupCache.get(geometry);
  if (!members) {
    const index = geometry.getIndex?.();
    members = index ? Uint32Array.from(new Set(index.array)) : null;
    lookupCache.set(geometry, members);
  }

  const local = mesh.worldToLocal(worldPoint.clone());
  const positions = geometry.getAttribute('position').array;
  let best = -1;
  let bestDistance = Infinity;
  if (members) {
    for (const vertex of members) {
      const offset = vertex * 3;
      const dx = positions[offset] - local.x;
      const dy = positions[offset + 1] - local.y;
      const dz = positions[offset + 2] - local.z;
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = vertex;
      }
    }
  } else {
    for (let vertex = 0, end = positions.length / 3; vertex < end; vertex++) {
      const offset = vertex * 3;
      const dx = positions[offset] - local.x;
      const dy = positions[offset + 1] - local.y;
      const dz = positions[offset + 2] - local.z;
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = vertex;
      }
    }
  }
  if (best < 0) return null;
  return { x: rest.getX(best), y: rest.getY(best), z: rest.getZ(best) };
}
