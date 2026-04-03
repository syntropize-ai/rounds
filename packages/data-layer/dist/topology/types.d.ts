import type { Service } from '@agentic-obs/common';
export type NodeType = 'service' | 'endpoint' | 'pod' | 'host' | 'deployment' | 'job';
export type EdgeType = 'calls' | 'depends_on' | 'deployed_by' | 'owned_by';
export interface TopologyNode {
    id: string;
    type: NodeType;
    name: string;
    metadata: Record<string, string>;
    tags: string[];
    service?: Service;
}
export interface TopologyEdge {
    id: string;
    type: EdgeType;
    sourceId: string;
    targetId: string;
    metadata?: Record<string, string>;
    /**
     * When true, this edge was added manually and will not be overwritten
     * by automatic topology discovery (e.g. trace-derived edges).
     */
    manual?: boolean;
}
export interface TopologyGraph {
    nodes: Map<string, TopologyNode>;
    edges: Map<string, TopologyEdge>;
    /** adjacency list: sourceId -> Set of edgeIds */
    outEdges: Map<string, Set<string>>;
    /** reverse adjacency: targetId -> Set of edgeIds */
    inEdges: Map<string, Set<string>>;
}
export interface DependencyInfo {
    node: TopologyNode;
    edge: TopologyEdge;
}
//# sourceMappingURL=types.d.ts.map