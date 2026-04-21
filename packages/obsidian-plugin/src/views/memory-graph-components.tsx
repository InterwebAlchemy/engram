import React, { useState } from 'react';
import {
  Handle,
  Position,
  type NodeProps,
} from 'reactflow';
import {
  MEMORY_STATE_OPTIONS,
  capitalize,
} from './memory-view-helpers';
import { normalizeTag } from './memory-graph-model';

export interface MemoryNodeData {
  canEdit: boolean;
  linkCount: number;
  onOpenNote: (path: string) => void;
  onStateChange: (path: string, nextState: string) => Promise<void> | void;
  onTagsChange: (path: string, nextTags: string[]) => Promise<void> | void;
  path: string;
  state: string;
  tags: string[];
  threadLabel: string;
  title: string;
  typeLabel: string;
}

export const nodeTypes = {
  memory: MemoryNode,
};

function MemoryNode(props: NodeProps<MemoryNodeData>): React.JSX.Element {
  const { data } = props;
  return (
    <div className="engram-memory-graph-node">
      <Handle
        id={`${data.path}:left`}
        position={Position.Left}
        type="target"
      />
      <Handle
        id={`${data.path}:right`}
        position={Position.Right}
        type="source"
      />
      <div className="engram-memory-graph-node-title">{data.title}</div>
      {data.typeLabel.length > 0 ? (
        <div className="engram-memory-graph-node-type">{data.typeLabel}</div>
      ) : null}
    </div>
  );
}

interface MemoryDetailsDrawerProps {
  data: MemoryNodeData;
  onClose: () => void;
}

export function MemoryDetailsDrawer(props: MemoryDetailsDrawerProps): React.JSX.Element {
  const { data, onClose } = props;
  const [tagInput, setTagInput] = useState<string>('');

  const submitTag = (): void => {
    const normalized = normalizeTag(tagInput);
    if (normalized.length === 0 || data.tags.includes(normalized) || !data.canEdit) {
      return;
    }
    runAsync(data.onTagsChange(
      data.path,
      [...data.tags, normalized].sort((left, right) => left.localeCompare(right)),
    ));
    setTagInput('');
  };

  return (
    <aside className="engram-memory-graph-drawer" role="complementary">
      <header className="engram-memory-graph-drawer-header">
        <div className="engram-memory-graph-drawer-title">{data.title}</div>
        <button
          aria-label="Close details"
          className="engram-memory-graph-drawer-close"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </header>
      <div className="engram-memory-graph-drawer-body">
        {data.typeLabel.length > 0 ? (
          <div className="engram-memory-graph-node-type">{data.typeLabel}</div>
        ) : null}
        <div className="engram-memory-graph-node-chips">
          <span className="engram-memory-node-chip">{data.threadLabel}</span>
          <span className="engram-memory-node-chip">{`${String(data.tags.length)} tags`}</span>
          <span className="engram-memory-node-chip">{`${String(data.linkCount)} links`}</span>
        </div>
        <div className="engram-memory-graph-drawer-section">
          <label className="engram-memory-graph-drawer-label">State</label>
          <select
            className="engram-memory-state-select"
            disabled={!data.canEdit}
            onChange={(event) => {
              runAsync(data.onStateChange(data.path, event.currentTarget.value));
            }}
            value={data.state}
          >
            {MEMORY_STATE_OPTIONS.map((state) => (
              <option key={state} value={state}>{capitalize(state)}</option>
            ))}
          </select>
        </div>
        <div className="engram-memory-graph-drawer-section">
          <label className="engram-memory-graph-drawer-label">Tags</label>
          {data.tags.length === 0 ? (
            <div className="engram-memory-graph-empty-inline">No tags</div>
          ) : (
            <div className="engram-memory-graph-pill-list">
              {data.tags.map((tag) => (
                <div className="engram-memory-graph-pill" key={tag}>
                  <span>{`#${tag}`}</span>
                  <button
                    disabled={!data.canEdit}
                    onClick={() => {
                      runAsync(data.onTagsChange(
                        data.path,
                        data.tags.filter((value) => value !== tag),
                      ));
                    }}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="engram-memory-graph-inline-editor">
            <input
              className="engram-memory-search"
              disabled={!data.canEdit}
              onChange={(event) => {
                setTagInput(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitTag();
                }
              }}
              placeholder="Add tag"
              type="text"
              value={tagInput}
            />
            <button
              className="engram-memory-graph-action-btn"
              disabled={!data.canEdit}
              onClick={submitTag}
              type="button"
            >
              Add
            </button>
          </div>
        </div>
        <button
          className="engram-memory-graph-drawer-open"
          onClick={() => { data.onOpenNote(data.path); }}
          type="button"
        >
          Open in Obsidian
        </button>
      </div>
    </aside>
  );
}

function runAsync(result: Promise<void> | void): void {
  void Promise.resolve(result);
}
