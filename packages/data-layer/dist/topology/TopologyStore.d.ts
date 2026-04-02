import type { Service } from '@agentic-obs/common';
import type { TopologyNode, TopologyEdge, NodeType, EdgeType, DependencyInfo } from './types.js';
export declare class TopologyStore {
  private graph;
  addNode(params: Omit<TopologyNode, 'id'> & {
    id?: string;
  }): TopologyNode;
  addServiceNode(service: Service): TopologyNode;
  getNode(id: string): TopologyNode | undefined;
  findNodeByName(name: string): TopologyNode | undefined;
  findNodeByServiceId(serviceId: string): TopologyNode | undefined;
  /**
   * Fuzzy-match a partial name/id against all nodes.
   * Priority: (1) name/id starts-with partial, (2) name/id includes partial,
   * (3) partial starts-with name/id, (4) partial includes name/id.
   */
  findNodeByPartialName(partial: string): TopologyNode | undefined;
  listNodes(type?: NodeType): TopologyNode[];
  removeNode(id: string): boolean;
  addEdge(params: Omit<TopologyEdge, 'id'> & {
    id?: string;
  }): TopologyEdge;
  getEdge(id: string): TopologyEdge | undefined;
  listEdges(type?: EdgeType): TopologyEdge[];
  removeEdge(id: string): boolean;
  /** Direct downstream dependencies (nodes this node calls/depends on) */
  getDownstream(nodeId: string, edgeTypes?: EdgeType[]): DependencyInfo[];
  /** Direct upstream callers (nodes that call/depend on this node) */
  getUpstream(nodeId: string, edgeTypes?: EdgeType[]): DependencyInfo[];
  /** BFS: all transitive downstream dependencies */
  getTransitiveDownstream(nodeId: string, edgeTypes?: EdgeType[]): TopologyNode[];
  /** BFS: all transitive upstream callers */
  getTransitiveUpstream(nodeId: string, edgeTypes?: EdgeType[]): TopologyNode[];
  /** Get all direct dependencies of a service (calls + depends_on edges) */
  getServiceDependencies(serviceId: string): DependencyInfo[];
  /** Get all services that depend on this service */
  getServiceDependents(serviceId: string): DependencyInfo[];
  private bfs;
  toJSON(): {
    nodes: TopologyNode[];
    edges: TopologyEdge[];
  };
  loadJSON(data: {
    nodes: TopologyNode[];
    edges: TopologyEdge[];
  }): void;
  clear(): void;
}
//# sourceMappingURL=TopologyStore.d.ts.map
