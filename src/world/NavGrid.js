/**
 * NavGrid — coarse walkability grid plus a shared flow field.
 *
 * Every AI attacker wants the same thing (the player), so instead of running a
 * per-agent A* we bake one breadth-first flow field out from the player and let
 * each soldier read the local gradient. Rebuilding is cheap enough to do a few
 * times a second, which keeps the field honest while the player moves.
 */

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export class NavGrid {
  constructor(collision, opts = {}) {
    this.collision = collision;
    this.cell = opts.cell ?? 1.5;
    this.half = opts.half ?? 78; // world is roughly +/-80 m around the outpost
    this.agentRadius = opts.agentRadius ?? 0.46;
    this.h = this.half * 2 + 1;
    this.cols = Math.max(8, Math.round(this.h / this.cell));
    this.rows = this.cols;
    this.originX = -this.half;
    this.originZ = -this.half;
    this.cell = this.h / this.cols; // snap so the grid tiles the world exactly
    this.blocked = new Uint8Array(this.cols * this.rows);
    this.dist = new Uint16Array(this.cols * this.rows);
    this.flowX = new Int8Array(this.cols * this.rows);
    this.flowZ = new Int8Array(this.cols * this.rows);
    this.target = { x: 0, z: 0 };
    this.valid = false;
  }

  /** Sample every cell against collision geometry and static ground height. */
  bake() {
    const { collision, cols, rows, cell, originX, originZ } = this;
    for (let iz = 0; iz < rows; iz++) {
      for (let ix = 0; ix < cols; ix++) {
        const x = originX + (ix + 0.5) * cell;
        const z = originZ + (iz + 0.5) * cell;
        const y = collision.groundAt(x, z, 4, 1.2);
        const solid = collision.overlaps(x, z, this.agentRadius, y + 0.45, y + 1.7);
        this.blocked[iz * cols + ix] = solid ? 1 : 0;
      }
    }
    this.valid = false;
  }

  index(ix, iz) {
    return iz * this.cols + ix;
  }

  cellOf(x, z) {
    const ix = Math.floor((x - this.originX) / this.cell);
    const iz = Math.floor((z - this.originZ) / this.cell);
    return { ix, iz };
  }

  inBounds(ix, iz) {
    return ix >= 0 && iz >= 0 && ix < this.cols && iz < this.rows;
  }

  walkable(ix, iz) {
    return this.inBounds(ix, iz) && !this.blocked[this.index(ix, iz)];
  }

  /**
   * Flood the grid outward from a world position. Returns true when a usable
   * field was produced (the target cell itself may sit inside geometry, in
   * which case the nearest open cell is used).
   */
  computeField(x, z) {
    const { cols, rows, dist, flowX, flowZ, blocked } = this;
    this.target.x = x;
    this.target.z = z;
    dist.fill(0xffff);
    flowX.fill(0);
    flowZ.fill(0);

    let { ix, iz } = this.cellOf(x, z);
    ix = Math.max(0, Math.min(cols - 1, ix));
    iz = Math.max(0, Math.min(rows - 1, iz));
    // If the player stands in geometry (on a roof, on debris), seed the search
    // from the closest open cell instead.
    if (blocked[this.index(ix, iz)]) {
      let best = null;
      let bestD = Infinity;
      for (let r = 1; r <= 6 && !best; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const nx = ix + dx;
            const nz = iz + dz;
            if (!this.walkable(nx, nz)) continue;
            const d = dx * dx + dz * dz;
            if (d < bestD) {
              bestD = d;
              best = { nx, nz };
            }
          }
        }
      }
      if (!best) return false;
      ix = best.nx;
      iz = best.nz;
    }

    const queue = new Int32Array(cols * rows);
    let head = 0;
    let tail = 0;
    const start = this.index(ix, iz);
    dist[start] = 0;
    queue[tail++] = start;

    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % cols;
      const cz = (cur - cx) / cols;
      const cd = dist[cur];
      for (let n = 0; n < 8; n++) {
        const nx = cx + NEIGHBOURS[n][0];
        const nz = cz + NEIGHBOURS[n][1];
        if (!this.walkable(nx, nz)) continue;
        // No squeezing diagonally between two blocked cells.
        if (n >= 4) {
          const a = this.walkable(cx + NEIGHBOURS[n][0], cz);
          const b = this.walkable(cx, cz + NEIGHBOURS[n][1]);
          if (!a && !b) continue;
        }
        const ni = this.index(nx, nz);
        if (dist[ni] !== 0xffff) continue;
        dist[ni] = cd + 1;
        queue[tail++] = ni;
      }
    }

    // Gradient pass: point each cell at its cheapest neighbour, preferring
    // orthogonal steps. Diagonal flow makes actors clip the corners of blocked
    // cells, so diagonals are only used when they are clearly better and both
    // orthogonal neighbours are open.
    const ORTHO = [0, 1, 2, 3];
    for (let iz2 = 0; iz2 < rows; iz2++) {
      for (let ix2 = 0; ix2 < cols; ix2++) {
        const i = this.index(ix2, iz2);
        const d = dist[i];
        if (d === 0xffff || d === 0) continue;
        let bestOrtho = 0xffff;
        let ox = 0;
        let oz = 0;
        for (const n of ORTHO) {
          const nx = ix2 + NEIGHBOURS[n][0];
          const nz = iz2 + NEIGHBOURS[n][1];
          if (!this.walkable(nx, nz)) continue;
          const nd = dist[this.index(nx, nz)];
          if (nd < bestOrtho) {
            bestOrtho = nd;
            ox = NEIGHBOURS[n][0];
            oz = NEIGHBOURS[n][1];
          }
        }
        let bx = ox;
        let bz = oz;
        let best = bestOrtho;
        for (let n = 4; n < 8; n++) {
          const sx = NEIGHBOURS[n][0];
          const sz = NEIGHBOURS[n][1];
          const nx = ix2 + sx;
          const nz = iz2 + sz;
          if (!this.walkable(nx, nz)) continue;
          if (!this.walkable(ix2 + sx, iz2) && !this.walkable(ix2, iz2 + sz)) continue;
          const nd = dist[this.index(nx, nz)];
          if (nd + 2 < best) {
            best = nd;
            bx = sx;
            bz = sz;
          }
        }
        if (bx || bz) {
          const len = Math.hypot(bx, bz) || 1;
          flowX[i] = Math.round((bx / len) * 100);
          flowZ[i] = Math.round((bz / len) * 100);
        }
      }
    }
    this.valid = true;
    return true;
  }

  /** Unit direction the actor at (x,z) should walk, or null when unreachable. */
  sample(x, z, out = { x: 0, z: 0 }) {
    if (!this.valid) return null;
    const { ix, iz } = this.cellOf(x, z);
    if (!this.inBounds(ix, iz)) return null;
    const i = this.index(ix, iz);
    if (this.blocked[i] || this.dist[i] === 0xffff) {
      // Standing in geometry (or off the field): point at the neighbour that
      // costs least, so the actor can at least climb back out.
      let best = 0xffff;
      let bx = 0;
      let bz = 0;
      for (let n = 0; n < 8; n++) {
        const nx = ix + NEIGHBOURS[n][0];
        const nz = iz + NEIGHBOURS[n][1];
        if (!this.walkable(nx, nz)) continue;
        const nd = this.dist[this.index(nx, nz)];
        if (nd < best) {
          best = nd;
          bx = NEIGHBOURS[n][0];
          bz = NEIGHBOURS[n][1];
        }
      }
      if (!bx && !bz) return null;
      const len = Math.hypot(bx, bz) || 1;
      out.x = bx / len;
      out.z = bz / len;
      return out;
    }
    let fx = this.flowX[i];
    let fz = this.flowZ[i];
    if (!fx && !fz) return null; // standing on the goal cell
    if (fx && fz) {
      const sx = Math.sign(fx);
      const sz = Math.sign(fz);
      const freeX = this.walkable(ix + sx, iz);
      const freeZ = this.walkable(ix, iz + sz);
      if (!freeX && !freeZ) return null;
      if (!freeX) {
        fx = 0;
        fz = sz;
      } else if (!freeZ) {
        fx = sx;
        fz = 0;
      }
    }
    const len = Math.hypot(fx, fz) || 1;
    out.x = fx / len;
    out.z = fz / len;
    return out;
  }

  /** Remaining grid distance to the goal in metres (Infinity when unreachable). */
  distanceTo(x, z) {
    if (!this.valid) return Infinity;
    const { ix, iz } = this.cellOf(x, z);
    if (!this.inBounds(ix, iz)) return Infinity;
    const d = this.dist[this.index(ix, iz)];
    return d === 0xffff ? Infinity : d * this.cell;
  }
}
