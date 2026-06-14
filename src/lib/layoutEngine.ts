import { DashboardWidget } from "../ipc/items";

export const GRID_COLS = 12;

export function collides(a: DashboardWidget, b: DashboardWidget): boolean {
  if (a.id === b.id) return false;
  
  // Ensure types are numbers (safety against SQLite string persistence)
  const ax = Number(a.x), ay = Number(a.y), aw = Number(a.w), ah = Number(a.h);
  const bx = Number(b.x), by = Number(b.y), bw = Number(b.w), bh = Number(b.h);

  if (ax + aw <= bx) return false;
  if (ax >= bx + bw) return false;
  if (ay + ah <= by) return false;
  if (ay >= by + bh) return false;
  return true;
}

export function compact(layout: DashboardWidget[], movedItem?: DashboardWidget): DashboardWidget[] {
  // Sort by Y, prioritizing the moved item to keep its target position, then by X
  const sorted = [...layout].sort((a, b) => {
    const ay = Number(a.y), by = Number(b.y);
    const ax = Number(a.x), bx = Number(b.x);
    if (ay === by) {
      if (movedItem && a.id === movedItem.id) return -1;
      if (movedItem && b.id === movedItem.id) return 1;
      return ax - bx;
    }
    return ay - by;
  });

  const res: DashboardWidget[] = [];
  for (const l of sorted) {
    let y = Number(l.y);
    
    // 1. Gravity push-down: push item down until it clears any placed items
    while (res.some(c => collides(c, { ...l, y }))) {
      y++;
    }

    // 2. Float up: try to float it upwards as much as possible
    while (y > 0) {
      const test = { ...l, y: y - 1 };
      if (res.some(c => collides(c, test))) {
        break; // collides, can't move up further
      }
      y--;
    }
    
    res.push({ 
      ...l, 
      x: Number(l.x),
      y, 
      w: Number(l.w),
      h: Number(l.h)
    });
  }
  return res;
}

export function moveElement(
  layout: DashboardWidget[],
  id: string,
  x: number,
  y: number
): DashboardWidget[] {
  const res = [...layout];
  const idx = res.findIndex(w => w.id === id);
  if (idx < 0) return layout;

  res[idx] = {
    ...res[idx],
    x: Math.max(0, Math.min(x, GRID_COLS - Number(res[idx].w))),
    y: Math.max(0, y)
  };

  return compact(res, res[idx]);
}

export function resizeElement(
  layout: DashboardWidget[],
  id: string,
  w: number,
  h: number
): DashboardWidget[] {
  const res = [...layout];
  const idx = res.findIndex(w => w.id === id);
  if (idx < 0) return layout;

  const newW = Math.max(1, Math.min(w, GRID_COLS - Number(res[idx].x)));
  const newH = Math.max(1, h);

  res[idx] = { ...res[idx], w: newW, h: newH };

  return compact(res, res[idx]);
}
