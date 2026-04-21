import React, { type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import ReactFlow, {
  Background,
  ConnectionMode,
  Controls,
  MiniMap,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from 'reactflow';
import type { VaultNote } from '@interwebalchemy/engram-core';
import {
  baseName,
  capitalize,
  readFrontmatterString,
  readTags,
  resolveMemoryState,
} from './memory-view-helpers';
import {
  buildDegreeByPath,
  buildEdges,
  buildInitialPositions,
  buildManualConnections,
  buildPathByRef,
  NODE_HEIGHT,
  NODE_WIDTH,
  PADDING,
  type GraphEdge,
} from './memory-graph-model';
import {
  MemoryDetailsDrawer,
  nodeTypes,
  type MemoryNodeData,
} from './memory-graph-components';

interface RenderExploreGraphOptions {
  initialSelectedPath?: string | null;
  notes: VaultNote[];
  onConnect: (sourcePath: string, targetPath: string) => Promise<void> | void;
  onDisconnect: (sourcePath: string, targetPath: string) => Promise<void> | void;
  onOpenNote: (path: string) => void;
  onSelectedPathChange?: (path: string | null) => void;
  onStateChange: (path: string, nextState: string) => Promise<void> | void;
  onTagsChange: (path: string, nextTags: string[]) => Promise<void> | void;
  parent: HTMLElement;
  updatingPaths: Set<string>;
}

interface FlowEdgeData {
  kind: GraphEdge['kind'];
}

const LAYOUT_SIGNATURE_SEPARATOR = '|';
const OVERLAP_ITERATIONS = 90;
const OVERLAP_PADDING = 28;
const MIN_SEPARATION_SCALE = 1.2;
const JITTER = 0.5;
const HALF = 2;
const MIN_NODE_COUNT = 2;
const SOFT_SEPARATION_PUSH = 0.08;

export function renderExploreGraph(options: RenderExploreGraphOptions): () => void {
  const host = options.parent.createDiv({ cls: 'engram-memory-graph-host' });
  const root = createRoot(host);
  root.render(<MemoryExploreGraph {...options} />);
  return () => {
    root.unmount();
    host.remove();
  };
}

function MemoryExploreGraph(props: RenderExploreGraphOptions): JSX.Element {
  const {
    initialSelectedPath,
    notes,
    onConnect,
    onDisconnect,
    onOpenNote,
    onSelectedPathChange,
    onStateChange,
    onTagsChange,
    updatingPaths,
  } = props;
  const { canvasEdges, canvasNodes } = buildInitialFlow({
    notes,
    onOpenNote,
    onStateChange,
    onTagsChange,
    updatingPaths,
  });
  const [nodes, setNodes] = React.useState<Array<Node<MemoryNodeData>>>(canvasNodes);
  const [edges, setEdges] = React.useState<Array<Edge<FlowEdgeData>>>(canvasEdges);
  const [selectedPath, setSelectedPath] = React.useState<string | null>(
    initialSelectedPath ?? null,
  );
  const layoutSignature = React.useMemo(
    () => notes.map((note) => note.path).join(LAYOUT_SIGNATURE_SEPARATOR),
    [notes],
  );
  const hasAppliedMeasuredLayout = React.useRef<boolean>(false);

  React.useEffect(() => {
    hasAppliedMeasuredLayout.current = false;
  }, [layoutSignature]);

  const selectedData = React.useMemo<MemoryNodeData | null>(() => {
    if (selectedPath === null) {
      return null;
    }
    return nodes.find((node) => node.id === selectedPath)?.data ?? null;
  }, [nodes, selectedPath]);

  const updateSelectedPath = (next: string | null): void => {
    setSelectedPath(next);
    onSelectedPathChange?.(next);
  };

  const onNodeChanges = (changes: NodeChange[]): void => {
    setNodes((current) => {
      const updated = applyNodeChanges(changes, current);
      if (hasAppliedMeasuredLayout.current || !hasMeasuredNodeDimensions(updated)) {
        return updated;
      }
      hasAppliedMeasuredLayout.current = true;
      return spreadNodesByMeasuredSize(updated);
    });
  };

  const onFlowConnect = (connection: Connection): void => {
    const normalized = normalizeConnection(connection);
    if (normalized === null || manualEdgeExists(edges, normalized)) {
      return;
    }
    const [sourcePath, targetPath] = normalized;
    setEdges((current) => [...current, createManualFlowEdge(sourcePath, targetPath)]);
    runAsync(onConnect(sourcePath, targetPath));
  };

  const onEdgeClick = (
    event: React.MouseEvent,
    edge: Edge<FlowEdgeData>,
  ): void => {
    if (edge.data?.kind !== 'manual') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const [sourcePath, targetPath] = normalizePair(edge.source, edge.target);
    setEdges((current) => removeManualEdge(current, sourcePath, targetPath));
    runAsync(onDisconnect(sourcePath, targetPath));
  };

  return (
    <div className="engram-memory-graph-shell">
      <div className="engram-memory-graph-viewport">
        <div className="engram-memory-graph-flow">
          <ReactFlow
            connectionMode={ConnectionMode.Loose}
            edges={edges}
            fitView={true}
            fitViewOptions={{ maxZoom: 1.15, padding: 0.24 }}
            nodeTypes={nodeTypes}
            nodes={nodes}
            nodesDraggable={true}
            onConnect={onFlowConnect}
            onEdgeClick={onEdgeClick}
            onNodeClick={(_, node) => { updateSelectedPath(node.id); }}
            onNodesChange={onNodeChanges}
            onPaneClick={() => { updateSelectedPath(null); }}
            panOnDrag={true}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--background-modifier-border)" gap={20} size={1} />
            <MiniMap className="engram-memory-graph-minimap" pannable={true} zoomable={true} />
            <Controls className="engram-memory-graph-controls" />
          </ReactFlow>
        </div>
        {selectedData === null ? null : (
          <MemoryDetailsDrawer
            data={selectedData}
            onClose={() => { updateSelectedPath(null); }}
          />
        )}
      </div>
    </div>
  );
}

interface BuildInitialFlowOptions {
  notes: VaultNote[];
  onOpenNote: (path: string) => void;
  onStateChange: (path: string, nextState: string) => Promise<void> | void;
  onTagsChange: (path: string, nextTags: string[]) => Promise<void> | void;
  updatingPaths: Set<string>;
}

function buildInitialFlow(options: BuildInitialFlowOptions): {
  canvasEdges: Array<Edge<FlowEdgeData>>;
  canvasNodes: Array<Node<MemoryNodeData>>;
} {
  const {
    notes,
    onOpenNote,
    onStateChange,
    onTagsChange,
    updatingPaths,
  } = options;
  const pathByRef = buildPathByRef(notes);
  const manualConnections = buildManualConnections(notes, pathByRef);
  const graphEdges = buildEdges(notes, manualConnections);
  const degreeByPath = buildDegreeByPath(graphEdges);
  const positions = buildInitialPositions(notes, graphEdges);

  const canvasNodes = notes.map((note) => {
    const position = positions.get(note.path) ?? { x: 0, y: 0 };
    const state = resolveMemoryState(note);
    const threadValue = readFrontmatterString(note.frontmatter.thread);
    const typeValue = readFrontmatterString(note.frontmatter.type).toLowerCase();
    const isArchived = typeValue === 'archive';
    return {
      className: `engram-memory-graph-flow-node is-${state}${isArchived ? ' is-archived' : ''}`,
      data: {
        canEdit: !updatingPaths.has(note.path),
        linkCount: degreeByPath.get(note.path) ?? 0,
        onOpenNote,
        onStateChange,
        onTagsChange,
        path: note.path,
        state,
        tags: readTags(note),
        threadLabel: threadValue.length > 0 ? `Thread ${threadValue}` : 'No thread',
        title: baseName(note.path),
        typeLabel: capitalize(note.frontmatter.type),
      },
      id: note.path,
      position: {
        x: position.x,
        y: position.y,
      },
      type: 'memory',
    } satisfies Node<MemoryNodeData>;
  });
  return {
    canvasEdges: graphEdges.map((edge) => createFlowEdge(edge)),
    canvasNodes,
  };
}

function createFlowEdge(edge: GraphEdge): Edge<FlowEdgeData> {
  const [sourcePath, targetPath] = normalizePair(edge.sourcePath, edge.targetPath);
  return {
    className: `engram-memory-graph-edge is-${edge.kind}`,
    data: { kind: edge.kind },
    id: `${edge.kind}:${sourcePath}|${targetPath}`,
    source: sourcePath,
    target: targetPath,
  };
}

function createManualFlowEdge(sourcePath: string, targetPath: string): Edge<FlowEdgeData> {
  return createFlowEdge({ kind: 'manual', sourcePath, targetPath });
}

function normalizeConnection(connection: Connection): [string, string] | null {
  const { source, target } = connection;
  if (source === null || target === null || source === target) {
    return null;
  }
  return normalizePair(source, target);
}

function normalizePair(left: string, right: string): [string, string] {
  return left.localeCompare(right) <= 0 ? [left, right] : [right, left];
}

function manualEdgeExists(edges: Array<Edge<FlowEdgeData>>, pair: [string, string]): boolean {
  const [sourcePath, targetPath] = pair;
  return edges.some((edge) =>
    edge.data?.kind === 'manual' && edge.source === sourcePath && edge.target === targetPath,
  );
}

function removeManualEdge(
  edges: Array<Edge<FlowEdgeData>>,
  sourcePath: string,
  targetPath: string,
): Array<Edge<FlowEdgeData>> {
  return edges.filter((edge) =>
    edge.data?.kind !== 'manual'
    || edge.source !== sourcePath
    || edge.target !== targetPath,
  );
}

function runAsync(result: Promise<void> | void): void {
  void Promise.resolve(result);
}

function spreadNodesByMeasuredSize(nodes: Array<Node<MemoryNodeData>>): Array<Node<MemoryNodeData>> {
  if (nodes.length < MIN_NODE_COUNT) {
    return nodes;
  }

  const nextNodes = cloneNodes(nodes);

  for (let iteration = 0; iteration < OVERLAP_ITERATIONS; iteration += 1) {
    if (!runOverlapIteration(nextNodes)) {
      break;
    }
  }

  return normalizeNodePositions(nextNodes);
}

function normalizeNodePositions(nodes: Array<Node<MemoryNodeData>>): Array<Node<MemoryNodeData>> {
  const minX = nodes.reduce((smallest, node) => Math.min(smallest, node.position.x), Number.POSITIVE_INFINITY);
  const minY = nodes.reduce((smallest, node) => Math.min(smallest, node.position.y), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return nodes;
  }

  return nodes.map((node) => ({
    ...node,
    position: {
      x: node.position.x - minX + PADDING,
      y: node.position.y - minY + PADDING,
    },
  }));
}

function cloneNodes(nodes: Array<Node<MemoryNodeData>>): Array<Node<MemoryNodeData>> {
  return nodes.map((node) => ({
    ...node,
    position: {
      x: node.position.x,
      y: node.position.y,
    },
  }));
}

function runOverlapIteration(nodes: Array<Node<MemoryNodeData>>): boolean {
  let moved = false;
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const [leftNode, rightNode] = [nodes[leftIndex], nodes[rightIndex]];
      const adjustment = separateNodePair(leftNode, rightNode, leftIndex, rightIndex);
      if (adjustment === null) {
        continue;
      }
      leftNode.position.x += adjustment.leftDx;
      leftNode.position.y += adjustment.leftDy;
      rightNode.position.x += adjustment.rightDx;
      rightNode.position.y += adjustment.rightDy;
      moved = true;
    }
  }
  return moved;
}

function separateNodePair(
  leftNode: Node<MemoryNodeData>,
  rightNode: Node<MemoryNodeData>,
  leftIndex: number,
  rightIndex: number,
): PairAdjustment | null {
  const pair = measurePair(leftNode, rightNode);
  const { minDeltaX, minDeltaY, deltaX, deltaY } = pair;
  const overlapX = minDeltaX - Math.abs(deltaX);
  const overlapY = minDeltaY - Math.abs(deltaY);

  if (overlapX > 0 && overlapY > 0) {
    return resolveHardOverlap({
      deltaX,
      deltaY,
      leftIndex,
      overlapX,
      overlapY,
      rightIndex,
    });
  }
  return resolveSoftSeparation(pair);
}

function measurePair(
  leftNode: Node<MemoryNodeData>,
  rightNode: Node<MemoryNodeData>,
): {
  deltaX: number;
  deltaY: number;
  minDeltaX: number;
  minDeltaY: number;
} {
  const leftWidth = leftNode.width ?? NODE_WIDTH;
  const rightWidth = rightNode.width ?? NODE_WIDTH;
  const leftHeight = leftNode.height ?? NODE_HEIGHT;
  const rightHeight = rightNode.height ?? NODE_HEIGHT;
  const leftCenterX = leftNode.position.x + (leftWidth / HALF);
  const leftCenterY = leftNode.position.y + (leftHeight / HALF);
  const rightCenterX = rightNode.position.x + (rightWidth / HALF);
  const rightCenterY = rightNode.position.y + (rightHeight / HALF);

  return {
    deltaX: rightCenterX - leftCenterX,
    deltaY: rightCenterY - leftCenterY,
    minDeltaX: ((leftWidth + rightWidth) / HALF) + OVERLAP_PADDING,
    minDeltaY: ((leftHeight + rightHeight) / HALF) + OVERLAP_PADDING,
  };
}

function resolveHardOverlap(
  options: {
    deltaX: number;
    deltaY: number;
    leftIndex: number;
    overlapX: number;
    overlapY: number;
    rightIndex: number;
  },
): PairAdjustment {
  const {
    deltaX,
    deltaY,
    leftIndex,
    overlapX,
    overlapY,
    rightIndex,
  } = options;
  if (overlapX < overlapY) {
    const direction = deltaX === 0 ? (leftIndex % HALF === 0 ? -1 : 1) : Math.sign(deltaX);
    const shiftX = (overlapX / HALF) + JITTER;
    return {
      leftDx: -direction * shiftX,
      leftDy: 0,
      rightDx: direction * shiftX,
      rightDy: 0,
    };
  }

  const direction = deltaY === 0 ? (rightIndex % HALF === 0 ? -1 : 1) : Math.sign(deltaY);
  const shiftY = (overlapY / HALF) + JITTER;
  return {
    leftDx: 0,
    leftDy: -direction * shiftY,
    rightDx: 0,
    rightDy: direction * shiftY,
  };
}

function resolveSoftSeparation(
  pair: { deltaX: number; deltaY: number; minDeltaX: number; minDeltaY: number },
): PairAdjustment | null {
  const { deltaX, deltaY, minDeltaX, minDeltaY } = pair;
  const distance = Math.sqrt((deltaX * deltaX) + (deltaY * deltaY));
  const minDistance = Math.max(minDeltaX, minDeltaY) * MIN_SEPARATION_SCALE;
  if (distance >= minDistance || distance === 0) {
    return null;
  }

  const directionX = deltaX / distance;
  const directionY = deltaY / distance;
  const push = (minDistance - distance) * SOFT_SEPARATION_PUSH;
  return {
    leftDx: -directionX * push,
    leftDy: -directionY * push,
    rightDx: directionX * push,
    rightDy: directionY * push,
  };
}

interface PairAdjustment {
  leftDx: number;
  leftDy: number;
  rightDx: number;
  rightDy: number;
}

function hasMeasuredNodeDimensions(nodes: Array<Node<MemoryNodeData>>): boolean {
  return nodes.some((node) => (node.width ?? 0) > 0 && (node.height ?? 0) > 0);
}
