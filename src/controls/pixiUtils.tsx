import type * as PIXI from 'pixi.js';

export interface DragState {
  dragData: PIXI.InteractionData | null;
  handleDrag: (newPos: PIXI.Point) => void;
}

export const makeDraggable = (g: PIXI.Graphics, parent: DragState, stopPropagation?: boolean) => {
  g.interactive = true;
  g.on('pointerdown', (evt: any) => {
    console.log('setting drag data');
    parent.dragData = evt.data;
    if (stopPropagation) {
      evt.stopPropagation();
    }
  })
    .on('pointerup', () => {
      parent.dragData = null;
    })
    .on('pointerupoutside', () => {
      parent.dragData = null;
    })
    .on('pointermove', () => {
      if (!parent.dragData) {
        return;
      }

      const newPosition = parent.dragData.getLocalPosition(g.parent);
      parent.handleDrag(newPosition);
    });
};
