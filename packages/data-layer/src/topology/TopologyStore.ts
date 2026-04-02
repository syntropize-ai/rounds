import type { Service } from '@agentic-obs/common';
import type {
  TopologyNode,
  TopologyEdge,
  TopologyGraph,
  NodeType,
  EdgeType,
  DependencyInfo,
} from './types.js';

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export class TopologyStore {
  private graph: TopologyGraph = {
    nodes: new Map(),
    edges: new Map(),
    outEdges: new Map(),
    inEdges: new Map(),
  };

  // — Node operations

  addNode(
    params: Omit<TopologyNode, 'id'> & { id?: string },
  ): TopologyNode {
    const node: TopologyNode = { id: params.id ?? randomId(), ...params };
    this.graph.nodes.set(node.id, node);
    return node;
  }

  addServiceNode(service: Service): TopologyNode {
    const existing = this.findNodeByServiceId(service.id);
    if (existing) return existing;
    return this.addNode({
      id: service.id,
      type: service.type as NodeType,
      name: service.name,
      metadata: service.metadata,
      tags: service.tags,
      service,
    });
  }

  getNode(id: string): TopologyNode | undefined {
    return this.graph.nodes.get(id);
  }

  findNodeByName(name: string): TopologyNode | undefined {
    for (const node of this.graph.nodes.values()) {
      if (node.name === name) return node;
    }
  }

  findNodeByServiceId(serviceId: string): TopologyNode | undefined {
    for (const node of this.graph.nodes.values()) {
      if (node.service?.id === serviceId) return node;
    }
  }

  /**
   * Fuzzy-match a partial name/id against all nodes.
   * Priority: (1) name/id starts-with partial, (2) name/id includes partial,
   *           (3) partial starts-with name/id, (4) partial includes name/id.
   */
  findNodeByPartialName(partial: string): TopologyNode | undefined {
    const lower = partial.toLowerCase();
    let includesMatch: TopologyNode | undefined;

    for (const node of this.graph.nodes.values()) {
      const nameLower = node.name.toLowerCase();
      const idLower = node.id.toLowerCase();

      // Highest priority: the node name/id starts with the partial term
      if (nameLower.startsWith(lower) || idLower.startsWith(lower)) return node;
      // Next: partial starts with the node name/id (e.g. "checkout" vs "checkout-service")
      if (lower.startsWith(nameLower) || lower.startsWith(idLower)) return node;
      // Lower priority: substring containment (store first hit as fallback)
      if (!includesMatch && (nameLower.includes(lower) || idLower.includes(lower))) {
        includesMatch = node;
      }
    }

    return includesMatch;
  }

  listNodes(type?: NodeType): TopologyNode[] {
    const all = [...this.graph.nodes.values()];
    return type ? all.filter((n) => n.type === type) : all;
  }

  removeNode(id: string): boolean {
    if (!this.graph.nodes.has(id)) return false;

    // Remove all edges connected to this node
    const edgesToRemove: string[] = [];
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

  // — Edge operations

  addEdge(
    params: Omit<TopologyEdge, 'id'> & { id?: string },
  ): TopologyEdge {
    if (!this.graph.nodes.has(params.sourceId)) {
      throw new Error(`Source node not found: ${params.sourceId}`);
    }
    if (!this.graph.nodes.has(params.targetId)) {
      throw new Error(`Target node not found: ${params.targetId}`);
    }

    const edge: TopologyEdge = { id: params.id ?? randomId(), ...params };
    this.graph.edges.set(edge.id, edge);

    if (!this.graph.outEdges.has(edge.sourceId)) {
      this.graph.outEdges.set(edge.sourceId, new Set());
    }
    this.graph.outEdges.get(edge.sourceId)!.add(edge.id);

    if (!this.graph.inEdges.has(edge.targetId)) {
      this.graph.inEdges.set(edge.targetId, new Set());
    }
    this.graph.inEdges.get(edge.targetId)!.add(edge.id);

    return edge;
  }

  getEdge(id: string): TopologyEdge | undefined {
    return this.graph.edges.get(id);
  }

  listEdges(type?: EdgeType): TopologyEdge[] {
    const all = [...this.graph.edges.values()];
    return type ? all.filter((e) => e.type === type) : all;
  }

  removeEdge(id: string): boolean {
    const edge = this.graph.edges.get(id);
    if (!edge) return false;

    this.graph.outEdges.get(edge.sourceId)?.delete(id);
    this.graph.inEdges.get(edge.targetId)?.delete(id);
    this.graph.edges.delete(id);
    return true;
  }

  // — Graph traversal

  /** Direct downstream dependencies (nodes this node calls/depends on) */
  getDownstream(nodeId: string, edgeTypes?: EdgeType[]): DependencyInfo[] {
    const results: DependencyInfo[] = [];
    for (const edgeId of this.graph.outEdges.get(nodeId) ?? []) {
      const edge = this.graph.edges.get(edgeId)!;
      if (edgeTypes && !edgeTypes.includes(edge.type)) continue;
      const node = this.graph.nodes.get(edge.targetId);
      if (node) results.push({ node, edge });
    }
    return results;
  }

  /** Direct upstream callers (nodes that call/depend on this node) */
  getUpstream(nodeId: string, edgeTypes?: EdgeType[]): DependencyInfo[] {
    const results: DependencyInfo[] = [];
    for (const edgeId of this.graph.inEdges.get(nodeId) ?? []) {
      const edge = this.graph.edges.get(edgeId)!;
      if (edgeTypes && !edgeTypes.includes(edge.type)) continue;
      const node = this.graph.nodes.get(edge.sourceId);
      if (node) results.push({ node, edge });
    }
    return results;
  }

  /** BFS: all transitive downstream dependencies */
  getTransitiveDownstream(nodeId: string, edgeTypes?: EdgeType[]): TopologyNode[] {
    return this.bfs(nodeId, 'downstream', edgeTypes);
  }

  /** BFS: all transitive upstream callers */
  getTransitiveUpstream(nodeId: string, edgeTypes?: EdgeType[]): TopologyNode[] {
    return this.bfs(nodeId, 'upstream', edgeTypes);
  }

  /** Get all direct dependencies of a service (calls + depends_on edges) */
  getServiceDependencies(serviceId: string): DependencyInfo[] {
    return this.getDownstream(serviceId, ['calls', 'depends_on']);
  }

  /** Get all services that depend on this service */
  getServiceDependents(serviceId: string): DependencyInfo[] {
    return this.getUpstream(serviceId, ['calls', 'depends_on']);
  }

  private bfs(
    startId: string,
    direction: 'downstream' | 'upstream',
    edgeTypes?: EdgeType[],
  ): TopologyNode[] {
    const visited = new Set<string>();
    const queue = [startId];
    const result: TopologyNode[] = [];
    visited.add(startId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors =
        direction === 'downstream'
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

  // — Serialization

  toJSON(): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
    return {
      nodes: [...this.graph.nodes.values()],
      edges: [...this.graph.edges.values()],
    };
  }

  loadJSON(data: { nodes: TopologyNode[]; edges: TopologyEdge[] }): void {
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

  clear(): void {
    this.graph = {
      nodes: new Map(),
      edges: new Map(),
      outEdges: new Map(),
      inEdges: new Map(),
    };
  }
}
