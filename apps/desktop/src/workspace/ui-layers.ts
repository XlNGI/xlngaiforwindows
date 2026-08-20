export const WORKSPACE_FLOATING_Z_BASE = 100;
export const MODAL_Z_INDEX = 1000;

export function workspaceFloatingZIndex(zOrder: number): number {
  return WORKSPACE_FLOATING_Z_BASE + zOrder;
}
