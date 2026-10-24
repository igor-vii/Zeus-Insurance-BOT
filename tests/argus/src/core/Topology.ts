/**
 * Topology — как участники связаны.
 * 
 * Правило topology declaration:
 * 1. Edges, которые являются targets of faults, ОБЯЗАНЫ быть объявлены явно.
 * 2. Edges, которые являются observation sources, ОБЯЗАНЫ быть объявлены явно.
 * 3. Остальные edges МОГУТ быть объявлены, но не обязаны.
 */
export interface Topology {
  edges: TopologyEdge[];
}

export interface TopologyEdge {
  from: string;    // participantId
  to: string;      // participantId
  kind: string;    // описание канала: 'request', 'forward', 'response', ...
}
