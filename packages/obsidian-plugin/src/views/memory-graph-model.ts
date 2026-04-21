import type { VaultNote } from '@interwebalchemy/engram-core';
import {
  baseName,
  pathToConnectionRef,
  readConnectionRefs,
  readFrontmatterString,
  readTags,
} from './memory-view-helpers';

export const NODE_WIDTH = 216;
export const NODE_HEIGHT = 118;
export const PADDING = 56;
const MAX_TAG_EDGES = 90;
const HALF = 2;
const PHYLLOTAXIS_THREE = 3;
const PHYLLOTAXIS_FIVE = 5;
const GOLDEN_ANGLE = Math.PI * (PHYLLOTAXIS_THREE - Math.sqrt(PHYLLOTAXIS_FIVE));
const FORCE_NODE_LIMIT = 220;
const FORCE_ITERATIONS = 180;
const INITIAL_SPREAD = 230;
const REPULSION_STRENGTH = 16_000;
const SPRING_STRENGTH = 0.035;
const SPRING_LENGTH_MULTIPLIER = 1.45;
const CENTER_PULL = 0.002;
const DAMPING = 0.84;
const MAX_STEP = 28;

export interface Point {
  x: number;
  y: number;
}

export interface GraphEdge {
  kind: 'manual' | 'thread' | 'tag';
  sourcePath: string;
  targetPath: string;
}

interface BuildEdgesState {
  edges: GraphEdge[];
  manualPairs: Set<string>;
  seen: Set<string>;
}

export function buildPathByRef(notes: VaultNote[]): Map<string, string> {
  const map = new Map<string, string>();
  notes.forEach((note) => {
    map.set(note.path, note.path);
    map.set(pathToConnectionRef(note.path), note.path);
  });
  return map;
}

export function buildManualConnections(notes: VaultNote[], pathByRef: Map<string, string>): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  notes.forEach((note) => {
    map.set(note.path, new Set<string>());
  });

  notes.forEach((note) => {
    const sourceConnections = map.get(note.path);
    if (sourceConnections === undefined) {
      return;
    }
    readConnectionRefs(note).forEach((ref) => {
      const targetPath = pathByRef.get(ref);
      if (targetPath === undefined || targetPath === note.path) {
        return;
      }
      sourceConnections.add(targetPath);
    });
  });

  map.forEach((targets, source) => {
    targets.forEach((target) => {
      map.get(target)?.add(source);
    });
  });
  return map;
}

export function buildEdges(notes: VaultNote[], manualConnections: Map<string, Set<string>>): GraphEdge[] {
  const state: BuildEdgesState = {
    edges: [],
    manualPairs: new Set<string>(),
    seen: new Set<string>(),
  };

  buildManualEdges(manualConnections).forEach((edge) => {
    addUniqueEdge(state, edge);
  });

  buildThreadEdges(notes, state.manualPairs).forEach((edge) => {
    addUniqueEdge(state, edge);
  });

  buildTagEdges(notes, state.manualPairs).forEach((edge) => {
    addUniqueEdge(state, edge);
  });

  return state.edges;
}

function buildManualEdges(manualConnections: Map<string, Set<string>>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  manualConnections.forEach((targets, sourcePath) => {
    targets.forEach((targetPath) => {
      edges.push({ kind: 'manual', sourcePath, targetPath });
    });
  });
  return edges;
}

function buildThreadEdges(notes: VaultNote[], manualPairs: Set<string>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const groups = new Map<string, string[]>();

  notes.forEach((note) => {
    const threadId = readFrontmatterString(note.frontmatter.thread);
    if (threadId.length === 0) {
      return;
    }
    const existing = groups.get(threadId);
    if (existing === undefined) {
      groups.set(threadId, [note.path]);
      return;
    }
    existing.push(note.path);
  });

  groups.forEach((paths) => {
    if (paths.length < HALF) {
      return;
    }
    const [hub, ...rest] = paths;
    rest.forEach((candidate) => {
      if (manualPairs.has(pairKey(hub, candidate))) {
        return;
      }
      edges.push({ kind: 'thread', sourcePath: hub, targetPath: candidate });
    });
  });

  return edges;
}

function buildTagEdges(notes: VaultNote[], manualPairs: Set<string>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const groups = new Map<string, string[]>();

  notes.forEach((note) => {
    readTags(note).forEach((tag) => {
      const existing = groups.get(tag);
      if (existing === undefined) {
        groups.set(tag, [note.path]);
        return;
      }
      existing.push(note.path);
    });
  });

  let tagEdgeCount = 0;
  for (const paths of groups.values()) {
    if (paths.length < HALF || tagEdgeCount >= MAX_TAG_EDGES) {
      continue;
    }
    const sorted = [...paths].sort((left, right) => baseName(left).localeCompare(baseName(right)));
    for (let index = 1; index < sorted.length && tagEdgeCount < MAX_TAG_EDGES; index += 1) {
      const [sourcePath, targetPath] = [sorted[index - 1], sorted[index]];
      if (manualPairs.has(pairKey(sourcePath, targetPath))) {
        continue;
      }
      edges.push({ kind: 'tag', sourcePath, targetPath });
      tagEdgeCount += 1;
    }
  }

  return edges;
}

function addUniqueEdge(state: BuildEdgesState, edge: GraphEdge): void {
  if (edge.sourcePath === edge.targetPath) {
    return;
  }
  const pair = pairKey(edge.sourcePath, edge.targetPath);
  const key = `${edge.kind}:${pair}`;
  if (state.seen.has(key)) {
    return;
  }
  state.seen.add(key);
  const [sourcePath, targetPath] = pair.split('|');
  state.edges.push({ kind: edge.kind, sourcePath, targetPath });
  if (edge.kind === 'manual') {
    state.manualPairs.add(pair);
  }
}

function pairKey(left: string, right: string): string {
  return [left, right].sort((a, b) => a.localeCompare(b)).join('|');
}

export function buildInitialPositions(notes: VaultNote[], edges: GraphEdge[]): Map<string, Point> {
  const degree = buildDegreeByPath(edges);
  const sortedNotes = [...notes].sort((left, right) => compareByDegreeThenName(left, right, degree));
  const positions = seedPhyllotaxis(sortedNotes);
  if (sortedNotes.length <= FORCE_NODE_LIMIT && edges.length > 0) {
    applyForceLayout(positions, edges);
  }
  return normalizePositions(positions);
}

function compareByDegreeThenName(
  left: VaultNote,
  right: VaultNote,
  degree: Map<string, number>,
): number {
  const leftDegree = degree.get(left.path) ?? 0;
  const rightDegree = degree.get(right.path) ?? 0;
  if (rightDegree !== leftDegree) {
    return rightDegree - leftDegree;
  }
  return baseName(left.path).localeCompare(baseName(right.path));
}

export function buildDegreeByPath(edges: GraphEdge[]): Map<string, number> {
  const degree = new Map<string, number>();
  edges.forEach((edge) => {
    degree.set(edge.sourcePath, (degree.get(edge.sourcePath) ?? 0) + 1);
    degree.set(edge.targetPath, (degree.get(edge.targetPath) ?? 0) + 1);
  });
  return degree;
}

export function edgeKey(edge: GraphEdge): string {
  return `${edge.kind}:${pairKey(edge.sourcePath, edge.targetPath)}`;
}

export function normalizeTag(value: string): string {
  return value.trim().replace(/^#+/u, '').toLowerCase();
}

function seedPhyllotaxis(notes: VaultNote[]): Map<string, Point> {
  const positions = new Map<string, Point>();
  notes.forEach((note, index) => {
    const radius = INITIAL_SPREAD * Math.sqrt(index + 1);
    const angle = index * GOLDEN_ANGLE;
    positions.set(note.path, {
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
    });
  });
  return positions;
}

function applyForceLayout(positions: Map<string, Point>, edges: GraphEdge[]): void {
  const paths = Array.from(positions.keys());
  const { length: count } = paths;
  const indexByPath = new Map<string, number>(paths.map((path, index) => [path, index]));
  const points = paths.map((path) => {
    const point = positions.get(path) ?? { x: 0, y: 0 };
    return { x: point.x, y: point.y };
  });
  const velocity = paths.map(() => ({ x: 0, y: 0 }));
  const forces = paths.map(() => ({ x: 0, y: 0 }));
  const springLength = INITIAL_SPREAD * SPRING_LENGTH_MULTIPLIER;

  for (let iteration = 0; iteration < FORCE_ITERATIONS; iteration += 1) {
    for (let index = 0; index < count; index += 1) {
      forces[index] = { x: 0, y: 0 };
    }

    for (let left = 0; left < count; left += 1) {
      for (let right = left + 1; right < count; right += 1) {
        const dx = points[right].x - points[left].x;
        const dy = points[right].y - points[left].y;
        const distanceSquared = Math.max((dx * dx) + (dy * dy), 1);
        const distance = Math.sqrt(distanceSquared);
        const force = REPULSION_STRENGTH / distanceSquared;
        const ux = dx / distance;
        const uy = dy / distance;
        forces[left].x -= ux * force;
        forces[left].y -= uy * force;
        forces[right].x += ux * force;
        forces[right].y += uy * force;
      }
    }

    edges.forEach((edge) => {
      const sourceIndex = indexByPath.get(edge.sourcePath);
      const targetIndex = indexByPath.get(edge.targetPath);
      if (sourceIndex === undefined || targetIndex === undefined) {
        return;
      }
      const dx = points[targetIndex].x - points[sourceIndex].x;
      const dy = points[targetIndex].y - points[sourceIndex].y;
      const distance = Math.max(Math.sqrt((dx * dx) + (dy * dy)), 1);
      const ux = dx / distance;
      const uy = dy / distance;
      const force = (distance - springLength) * SPRING_STRENGTH;
      forces[sourceIndex].x += ux * force;
      forces[sourceIndex].y += uy * force;
      forces[targetIndex].x -= ux * force;
      forces[targetIndex].y -= uy * force;
    });

    for (let index = 0; index < count; index += 1) {
      forces[index].x += -points[index].x * CENTER_PULL;
      forces[index].y += -points[index].y * CENTER_PULL;
      velocity[index].x = (velocity[index].x + forces[index].x) * DAMPING;
      velocity[index].y = (velocity[index].y + forces[index].y) * DAMPING;

      const displacement = Math.sqrt((velocity[index].x * velocity[index].x) + (velocity[index].y * velocity[index].y));
      if (displacement > MAX_STEP) {
        const scale = MAX_STEP / displacement;
        velocity[index].x *= scale;
        velocity[index].y *= scale;
      }

      points[index].x += velocity[index].x;
      points[index].y += velocity[index].y;
    }
  }

  paths.forEach((path, index) => {
    positions.set(path, points[index]);
  });
}

function normalizePositions(positions: Map<string, Point>): Map<string, Point> {
  const points = Array.from(positions.values());
  if (points.length === 0) {
    return positions;
  }

  let [minX, minY] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];

  points.forEach((point) => {
    const { x, y } = point;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  });

  const normalized = new Map<string, Point>();
  positions.forEach((point, path) => {
    normalized.set(path, {
      x: point.x - minX + PADDING,
      y: point.y - minY + PADDING,
    });
  });
  return normalized;
}
