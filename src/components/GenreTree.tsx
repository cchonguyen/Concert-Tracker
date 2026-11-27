import React from 'react';
import type { GenreTreeNode, GenreTreeRoot } from '../services/genreInsights';

interface GenreTreeProps {
  roots: GenreTreeRoot[];
  onOpenArtistsWithGenre: (filterValue: string) => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const TreeBranch: React.FC<{
  nodes: GenreTreeNode[];
  onOpenArtistsWithGenre: (filterValue: string) => void;
}> = ({ nodes, onOpenArtistsWithGenre }) => {
  if (nodes.length === 0) return null;
  return (
    <ul className="space-y-1 border-l border-line pl-4">
      {nodes.map((node) => {
        const filterVal =
          node.level === 'family' ? `f:${node.name}` : node.children.length > 0 ? `u:${node.key}` : `s:${node.key}`;
        return (
          <li key={node.key} className="space-y-1">
            {node.seen ? (
              <button
                type="button"
                onClick={() => onOpenArtistsWithGenre(filterVal)}
                className="flex min-h-11 w-full items-baseline justify-between gap-2 rounded-control px-1.5 py-1 text-left text-sm font-medium text-text hover:bg-surface-1 hover:text-accent sm:min-h-9"
              >
                <span className="truncate">{node.name}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                  {plural(node.sets, 'set')}
                </span>
              </button>
            ) : (
              <div className="flex min-h-11 items-baseline justify-between gap-2 px-1.5 py-1 text-sm text-text-faint sm:min-h-9">
                <span className="truncate">{node.name}</span>
                <span className="shrink-0 font-mono text-xs">not yet</span>
              </div>
            )}
            {node.children.length > 0 && (
              <TreeBranch nodes={node.children} onOpenArtistsWithGenre={onOpenArtistsWithGenre} />
            )}
          </li>
        );
      })}
    </ul>
  );
};

export const GenreTree: React.FC<GenreTreeProps> = ({ roots, onOpenArtistsWithGenre }) => {
  return (
    <div className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-2">
        {roots.map((root) => (
          <div
            key={root.key}
            className="space-y-2.5 rounded-control border border-line bg-surface-2 p-3.5"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-text">
                {root.name}: {root.seenBranches} of {plural(root.totalBranches, 'branch', 'branches')} seen
              </h3>
              {root.sets > 0 && (
                <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                  {plural(root.sets, 'set')}
                </span>
              )}
            </div>
            <TreeBranch nodes={root.children} onOpenArtistsWithGenre={onOpenArtistsWithGenre} />
          </div>
        ))}
      </div>
      <p className="text-[11px] text-text-faint">
        Counts any set where the act has that genre or one under it.
      </p>
    </div>
  );
};
