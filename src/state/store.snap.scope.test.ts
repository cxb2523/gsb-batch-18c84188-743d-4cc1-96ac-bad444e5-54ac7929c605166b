import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from './store';
import type { CanvasStore } from './store';
import type { Node } from '../types';

function resetStore() {
  useCanvasStore.setState({
    camera: { zoom: 1, offsetX: 0, offsetY: 0 },
    nodes: {},
    selected: {},
    visualGroups: {},
    selectedVisualGroupId: null,
    innerEditNodeId: null,
    guides: [],
    activeGuideId: null,
    alignmentGuides: [],
    snapOffset: null,
    snapLockX: null,
    snapLockY: null,
    alignSnapEnabled: true,
    alignSnapTolerancePx: 8,
    historyPast: [],
    historyFuture: [],
    historyBatch: null,
    centerAddIndex: 0,
  } as Partial<CanvasStore>);
}

const node = (id: string, x: number, y: number, parentId?: string | null): Node =>
  ({ id, x, y, width: 50, height: 50, parentId: parentId ?? null }) as Node;

describe('Alignment snapping scope during inner-edit', () => {
  beforeEach(() => resetStore());

  it('snaps to other members of the visual group being edited', () => {
    const s0 = useCanvasStore.getState();
    s0.addNode(node('a', 100, 100));
    s0.addNode(node('b', 108, 300));
    useCanvasStore.setState({
      visualGroups: { g1: { id: 'g1', members: ['a', 'b'] } },
      selectedVisualGroupId: 'g1',
    } as Partial<CanvasStore>);

    const s = useCanvasStore.getState();
    s.selectOnly('a');
    s.enterInnerEdit('a');
    s.beginHistory();
    s.moveSelectedBy(5, 0);

    const after = useCanvasStore.getState();
    // b's left edge (108) attracts a: dx=5 + corr=3
    expect(after.nodes['a']).toMatchObject({ x: 108, y: 100 });
    expect(after.snapOffset).toEqual({ dx: 3, dy: 0 });
  });

  it('ignores nodes outside the inner-edit scope even when within tolerance', () => {
    const s0 = useCanvasStore.getState();
    s0.addNode(node('a', 100, 100));
    // Far away in the hierarchy and not part of any visual group
    s0.addNode(node('outside', 108, 500));

    const s = useCanvasStore.getState();
    s.selectOnly('a');
    s.enterInnerEdit('a');
    s.beginHistory();
    s.moveSelectedBy(5, 0);

    const after = useCanvasStore.getState();
    expect(after.nodes['a']).toMatchObject({ x: 105, y: 100 });
    expect(after.snapOffset).toBeNull();
    expect(after.alignmentGuides).toEqual([]);
    expect(after.snapLockX).toBeNull();
  });

  it('snaps to nodes in the same parent/child hierarchy subtree while inner-editing', () => {
    const s0 = useCanvasStore.getState();
    s0.addNode(node('p', 0, 0));
    s0.addNode(node('child', 100, 100, 'p'));
    s0.addNode(node('sibling', 108, 200, 'p'));
    s0.addNode(node('unrelated', 108, 600));

    const s = useCanvasStore.getState();
    s.selectOnly('child');
    s.enterInnerEdit('child');
    s.beginHistory();
    s.moveSelectedBy(5, 0);

    const after = useCanvasStore.getState();
    expect(after.nodes['child']).toMatchObject({ x: 108, y: 100 });
    expect(after.snapOffset).toEqual({ dx: 3, dy: 0 });
  });

  it('restores full-canvas snapping after exiting inner edit', () => {
    const s0 = useCanvasStore.getState();
    s0.addNode(node('a', 100, 100));
    s0.addNode(node('outside', 108, 500));

    let s = useCanvasStore.getState();
    s.selectOnly('a');
    s.enterInnerEdit('a');
    s.beginHistory();
    s.moveSelectedBy(5, 0);
    s.endHistory();
    // In-scope snapping ignored the outside node
    expect(useCanvasStore.getState().nodes['a']).toMatchObject({ x: 105 });

    // Move back without a gesture batch (programmatic move, no snapping)
    useCanvasStore.getState().moveSelectedBy(-5, 0);
    expect(useCanvasStore.getState().nodes['a']).toMatchObject({ x: 100 });

    s = useCanvasStore.getState();
    s.exitInnerEdit();
    s.beginHistory();
    s.moveSelectedBy(5, 0);

    const after = useCanvasStore.getState();
    expect(after.nodes['a']).toMatchObject({ x: 108, y: 100 });
    expect(after.snapOffset).toEqual({ dx: 3, dy: 0 });
  });

  it('keeps guides as snap targets both inside and outside inner edit', () => {
    const s0 = useCanvasStore.getState();
    s0.addNode(node('a', 100, 100));
    s0.addGuide('x', 108);

    let s = useCanvasStore.getState();
    s.selectOnly('a');
    s.enterInnerEdit('a');
    s.beginHistory();
    s.moveSelectedBy(5, 0);

    let after = useCanvasStore.getState();
    expect(after.nodes['a']).toMatchObject({ x: 108 });
    expect(after.snapOffset).toEqual({ dx: 3, dy: 0 });
    expect(after.alignmentGuides.some((g) => g.axis === 'x' && g.at === 108)).toBe(true);

    // Reset position and leave inner-edit mode
    s = useCanvasStore.getState();
    s.endHistory();
    s.moveSelectedBy(-8, 0);
    s.exitInnerEdit();
    expect(useCanvasStore.getState().nodes['a']).toMatchObject({ x: 100 });

    s = useCanvasStore.getState();
    s.beginHistory();
    s.moveSelectedBy(5, 0);

    after = useCanvasStore.getState();
    expect(after.nodes['a']).toMatchObject({ x: 108 });
    expect(after.snapOffset).toEqual({ dx: 3, dy: 0 });
  });

  it('normal (non-inner-edit) drags still reference all static nodes', () => {
    const s0 = useCanvasStore.getState();
    s0.addNode(node('a', 100, 100));
    s0.addNode(node('outside', 108, 500));

    const s = useCanvasStore.getState();
    s.selectOnly('a');
    s.beginHistory();
    s.moveSelectedBy(5, 0);

    const after = useCanvasStore.getState();
    expect(after.nodes['a']).toMatchObject({ x: 108 });
    expect(after.snapOffset).toEqual({ dx: 3, dy: 0 });
  });
});
