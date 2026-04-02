function randomId() {
  return Math.random().toString(36).slice(2, 10);
}
export class TopologyStore {
  graph = {
    nodes: new Map(),
    edges: new Map(),
    outEdges: new Map(),
    inEdges: new Map(),
  };
  // Node operations
  addNode(params) {
    const node = { id: params.id ?? randomId(), ...params };
    this.graph.nodes.set(node.id, node);
    return node;
  }
  addServiceNode(service) {
    const existing = this.findNodeByServiceId(service.id);
    if (existing)
      return existing;
    return this.addNode({
      id: service.id,
      type: service.type,
      name: service.name,
      metadata: service.metadata,
      tags: service.tags,
      service,
    });
  }
  getNode(id) {
    return this.graph.nodes.get(id);
  }
  findNodeByName(name) {
    for (const node of this.graph.nodes.values()) {
      if (node.name === name)
        return node;
    }
  }
  findNodeByServiceId(serviceId) {
    for (const node of this.graph.nodes.values()) {
      if (node.service?.id === serviceId)
        return node;
    }
  }
  /**
   * Fuzzy-match a partial name/id against all nodes.
   * Priority: (1) name/id starts-with partial, (2) name/id includes partial,
   * (3) partial starts-with name/id, (4) partial includes name/id.
   */
  findNodeByPartialName(partial) {
    const lower = partial.toLowerCase();
    let includesMatch;
    for (const node of this.graph.nodes.values()) {
      const nameLower = node.name.toLowerCase();
      const idLower = node.id.toLowerCase();
      if (nameLower.startsWith(lower) || idLower.startsWith(lower)) {
        return node;
      }
      if (lower.startsWith(nameLower) || lower.startsWith(idLower)) {
        return node;
      }
      if (!includesMatch && (nameLower.includes(lower) || idLower.includes(lower))) {
        includesMatch = node;
      }
    }
    return includesMatch;
  }
  listNodes(type) {
    const all = [...this.graph.nodes.values()];
    return type ? all.filter((n) => n.type === type) : all;
  }
  removeNode(id) {
    if (!this.graph.nodes.has(id)) {
      return false;
    }
    const edgesToRemove = [];
    for (const edgeId of this.graph.outEdges.get(id) ?? []) {
      edgesToRemove.push(edgeId);
    }
    for (const edgeId of this.graph.inEdges.get(id) ?? []) {
      edgesToRemove.push(edgeId);
    }
    for (const edgeId of edgesToRemove) {
      this.removeEdge(edgeId);
    }
    this.graph.nodes.delete(id);
    this.graph.outEdges.delete(id);
    this.graph.inEdges.delete(id);
    return true;
  }
  // Edge operations
  addEdge(params) {
    if (!this.graph.nodes.has(params.sourceId)) {
      throw new Error(`Source node not found: ${params.sourceId}`);
    }
    if (!this.graph.nodes.has(params.targetId)) {
      throw new Error(`Target node not found: ${params.targetId}`);
    }
    const edge = { id: params.id ?? randomId(), ...params };
    this.graph.edges.set(edge.id, edge);
    if (!this.graph.outEdges.has(edge.sourceId)) {
      this.graph.outEdges.set(edge.sourceId, new Set());
    }
    this.graph.outEdges.get(edge.sourceId).add(edge.id);
    if (!this.graph.inEdges.has(edge.targetId)) {
      this.graph.inEdges.set(edge.targetId, new Set());
    }
    this.graph.inEdges.get(edge.targetId).add(edge.id);
    return edge;
  }
  getEdge(id) {
    return this.graph.edges.get(id);
  }
  listEdges(type) {
    const all = [...this.graph.edges.values()];
    return type ? all.filter((e) => e.type === type) : all;
  }
  removeEdge(id) {
    const edge = this.graph.edges.get(id);
    if (!edge) {
      return false;
    }
    this.graph.outEdges.get(edge.sourceId)?.delete(id);
    this.graph.inEdges.get(edge.targetId)?.delete(id);
    this.graph.edges.delete(id);
    return true;
  }
  // Graph traversal
  /** Direct downstream dependencies (nodes this node calls/depends on) */
  getDownstream(nodeId, edgeTypes) {
    const result = [];
    for (const edgeId of this.graph.outEdges.get(nodeId) ?? []) {
      const edge = this.graph.edges.get(edgeId);
      if (edgeTypes && !edgeTypes.includes(edge.type))
        continue;
      const node = this.graph.nodes.get(edge.targetId);
      if (node) {
        result.push({ node, edge });
      }
    }
    return result;
  }
  /** Direct upstream callers (nodes that call/depend on this node) */
  getUpstream(nodeId, edgeTypes) {
    const result = [];
    for (const edgeId of this.graph.inEdges.get(nodeId) ?? []) {
      const edge = this.graph.edges.get(edgeId);
      if (edgeTypes && !edgeTypes.includes(edge.type))
        continue;
      const node = this.graph.nodes.get(edge.sourceId);
      if (node) {
        result.push({ node, edge });
      }
    }
    return result;
  }
  /** BFS: all transitive downstream dependencies */
  getTransitiveDownstream(nodeId, edgeTypes) {
    return this.bfs(nodeId, 'downstream', edgeTypes);
  }
  /** BFS: all transitive upstream callers */
  getTransitiveUpstream(nodeId, edgeTypes) {
    return this.bfs(nodeId, 'upstream', edgeTypes);
  }
  /** Get all direct dependencies of a service (calls + depends_on edges) */
  getServiceDependencies(serviceId) {
    return this.getDownstream(serviceId, ['calls', 'depends_on']);
  }
  /** Get all services that depend on this service */
  getServiceDependents(serviceId) {
    return this.getUpstream(serviceId, ['calls', 'depends_on']);
  }
  bfs(startId, direction, edgeTypes) {
    const visited = new Set();
    const queue = [startId];
    const result = [];
    visited.add(startId);
    while (queue.length > 0) {
      const current = queue.shift();
      const neighbors = direction === 'downstream'
        ? this.getDownstream(current, edgeTypes)
        : this.getUpstream(current, edgeTypes);
      for (const { node } of neighbors) {
        if (!visited.has(node.id)) {
          visited.add(node.id);
          result.push(node);
          queue.push(node.id);
        }
      }
    }
    return result;
  }
  // Serialization
  toJSON() {
    return {
      nodes: [...this.graph.nodes.values()],
      edges: [...this.graph.edges.values()],
    };
  }
  loadJSON(data) {
    this.graph = {
      nodes: new Map(),
      edges: new Map(),
      outEdges: new Map(),
      inEdges: new Map(),
    };
    for (const node of data.nodes) {
      this.graph.nodes.set(node.id, node);
    }
    for (const edge of data.edges) {
      this.addEdge(edge);
    }
  }
  clear() {
    this.graph = {
      nodes: new Map(),
      edges: new Map(),
      outEdges: new Map(),
      inEdges: new Map(),
    };
  }
}
//# sourceMappingURL=TopologyStore.js.map
