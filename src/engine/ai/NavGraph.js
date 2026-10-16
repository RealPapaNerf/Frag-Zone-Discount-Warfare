import { v3, distance } from '../math/vec3.js';

/**
 * Waypoint navigation. Maps ship a node list; most edges are derived here by
 * checking that two nodes are close, within a step height of each other and
 * mutually visible. Traversals that geometry cannot imply — jump pads, drops
 * off a ledge — are listed explicitly in the map JSON.
 */
export class NavGraph {
  constructor(doc = {}, arena = null) {
    const nodes = doc.nodes ?? [];
    this.nodes = nodes.map((n, i) => ({
      id: n.id ?? String(i),
      index: i,
      pos: { x: n.pos[0], y: n.pos[1], z: n.pos[2] },
      tags: n.tags ?? [],
    }));
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.edges = this.nodes.map(() => []);

    this.#autoLink(doc.autoLink, arena);
    this.#explicitLinks(doc.links);
  }

  get size() {
    return this.nodes.length;
  }

  #addEdge(fromIndex, toIndex, cost, kind) {
    if (fromIndex === toIndex) return;
    const existing = this.edges[fromIndex].find((e) => e.to === toIndex);
    if (existing) {
      if (cost < existing.cost) { existing.cost = cost; existing.kind = kind; }
      return;
    }
    this.edges[fromIndex].push({ to: toIndex, cost, kind });
  }

  #autoLink(cfg, arena) {
    if (!cfg) return;
    const maxDist = cfg.maxDistance ?? 12;
    const maxStep = cfg.maxStepUp ?? 1.5;
    const eye = cfg.eyeHeight ?? 0.9;
    const needLos = cfg.requireLineOfSight !== false && arena != null;

    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const a = this.nodes[i];
        const b = this.nodes[j];
        const dist = distance(a.pos, b.pos);
        if (dist > maxDist) continue;
        if (Math.abs(a.pos.y - b.pos.y) > maxStep) continue;
        if (needLos) {
          const from = { x: a.pos.x, y: a.pos.y + eye, z: a.pos.z };
          const to = { x: b.pos.x, y: b.pos.y + eye, z: b.pos.z };
          if (!arena.lineOfSight(from, to)) continue;
        }
        this.#addEdge(i, j, dist, 'walk');
        this.#addEdge(j, i, dist, 'walk');
      }
    }
  }

  #explicitLinks(links = []) {
    for (const link of links) {
      const a = this.byId.get(link.from);
      const b = this.byId.get(link.to);
      if (!a || !b) continue;
      const cost = link.cost ?? distance(a.pos, b.pos);
      this.#addEdge(a.index, b.index, cost, link.kind ?? 'walk');
      if (!link.oneWay) this.#addEdge(b.index, a.index, cost, link.kind ?? 'walk');
    }
  }

  /** Nearest node, preferring ones on roughly the same floor. */
  nearest(pos, maxDistance = Infinity) {
    let best = null;
    let bestCost = Infinity;
    for (const node of this.nodes) {
      const dy = Math.abs(node.pos.y - pos.y);
      const d = distance(node.pos, pos);
      if (d > maxDistance) continue;
      // Weight vertical separation heavily so a bot on the ring does not path
      // from a node directly beneath it.
      const cost = d + dy * 3;
      if (cost < bestCost) { bestCost = cost; best = node; }
    }
    return best;
  }

  randomNode(rng) {
    return this.nodes.length ? this.nodes[rng.int(this.nodes.length)] : null;
  }

  /** A* over the graph. Returns an array of nodes, start first, or null. */
  findPath(startId, goalId) {
    const start = this.byId.get(startId);
    const goal = this.byId.get(goalId);
    if (!start || !goal) return null;
    if (start === goal) return [start];

    const n = this.nodes.length;
    const gScore = new Float64Array(n).fill(Infinity);
    const fScore = new Float64Array(n).fill(Infinity);
    const cameFrom = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);

    gScore[start.index] = 0;
    fScore[start.index] = distance(start.pos, goal.pos);
    const open = [start.index];

    while (open.length) {
      // Small graphs: a linear scan beats the bookkeeping of a real heap.
      let bestAt = 0;
      for (let i = 1; i < open.length; i++) {
        if (fScore[open[i]] < fScore[open[bestAt]]) bestAt = i;
      }
      const current = open.splice(bestAt, 1)[0];
      if (current === goal.index) return this.#reconstruct(cameFrom, current);
      closed[current] = 1;

      for (const edge of this.edges[current]) {
        if (closed[edge.to]) continue;
        const tentative = gScore[current] + edge.cost;
        if (tentative >= gScore[edge.to]) continue;
        cameFrom[edge.to] = current;
        gScore[edge.to] = tentative;
        fScore[edge.to] = tentative + distance(this.nodes[edge.to].pos, goal.pos);
        if (!open.includes(edge.to)) open.push(edge.to);
      }
    }
    return null;
  }

  #reconstruct(cameFrom, end) {
    const path = [];
    let at = end;
    while (at !== -1) {
      path.push(this.nodes[at]);
      at = cameFrom[at];
    }
    return path.reverse();
  }

  /** Diagnostic: node ids no edge leaves, which would strand a bot. */
  findIsolatedNodes() {
    return this.nodes.filter((n) => this.edges[n.index].length === 0).map((n) => n.id);
  }
}
