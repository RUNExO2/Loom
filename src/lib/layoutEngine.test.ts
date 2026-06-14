import { describe, it, expect } from "vitest";
import { collides, compact, moveElement, resizeElement, GRID_COLS } from "./layoutEngine";
import { DashboardWidget } from "../ipc/items";

const createWidget = (id: string, x: number, y: number, w: number, h: number): DashboardWidget => ({
  id,
  workspace_id: "ws_1",
  widget_type: "stats",
  x,
  y,
  w,
  h,
  hidden: false,
});

describe("Dashboard Layout Engine (Phase 5 Validation)", () => {
  describe("1. Collision Validation", () => {
    it("detects basic overlap correctly", () => {
      const a = createWidget("a", 0, 0, 4, 2);
      const b = createWidget("b", 2, 0, 4, 2);
      expect(collides(a, b)).toBe(true);
    });

    it("allows non-overlapping adjacent widgets", () => {
      const a = createWidget("a", 0, 0, 4, 2);
      const b = createWidget("b", 4, 0, 4, 2);
      expect(collides(a, b)).toBe(false);
    });

    it("auto-corrects forced overlap via push-down (Gravity)", () => {
      // Widget A is placed directly on top of Widget B
      const layout = [
        createWidget("b", 0, 0, 4, 2),
        createWidget("a", 0, 0, 4, 2), // moved directly onto b
      ];
      // We prioritize 'a' because it is the moved item
      const compacted = compact(layout, layout[1]);
      
      // 'a' should stay at y=0, 'b' should be pushed down to y=2
      const aResult = compacted.find(w => w.id === "a");
      const bResult = compacted.find(w => w.id === "b");
      
      expect(aResult?.y).toBe(0);
      expect(bResult?.y).toBe(2);
      expect(collides(aResult!, bResult!)).toBe(false);
    });
  });

  describe("2. Drag Validation", () => {
    it("moves widget and resolves collisions without overlap", () => {
      const layout = [
        createWidget("a", 0, 0, 4, 2),
        createWidget("b", 0, 2, 4, 2),
        createWidget("c", 4, 0, 4, 2),
      ];

      // Drag 'b' up to y=0, x=0 (directly onto 'a')
      const result = moveElement(layout, "b", 0, 0);

      const a = result.find(w => w.id === "a");
      const b = result.find(w => w.id === "b");

      // 'b' should take priority at (0, 0)
      expect(b?.x).toBe(0);
      expect(b?.y).toBe(0);

      // 'a' should be pushed down to y=2
      expect(a?.x).toBe(0);
      expect(a?.y).toBe(2);
    });

    it("respects grid bounds during drag", () => {
      const layout = [createWidget("a", 0, 0, 4, 2)];
      // Attempt to drag out of bounds right
      const result = moveElement(layout, "a", 15, 0);
      expect(result[0].x).toBe(GRID_COLS - 4); // Max x is 8
    });
  });

  describe("3. Resize Validation", () => {
    it("resizes horizontally and pushes overlapping widgets out of the way", () => {
      const layout = [
        createWidget("a", 0, 0, 4, 2),
        createWidget("b", 4, 0, 4, 2), // adjacent
      ];

      // Resize 'a' to width 6, which will overlap with 'b'
      const result = resizeElement(layout, "a", 6, 2);

      const a = result.find(w => w.id === "a");
      const b = result.find(w => w.id === "b");

      expect(a?.w).toBe(6);
      expect(a?.y).toBe(0);

      // 'b' should be pushed down to y=2 because 'a' took its space
      expect(b?.y).toBe(2);
      expect(b?.x).toBe(4);
    });

    it("resizes vertically and pushes overlapping widgets out of the way", () => {
      const layout = [
        createWidget("a", 0, 0, 4, 2),
        createWidget("b", 0, 2, 4, 2), // below
      ];

      // Resize 'a' to height 4
      const result = resizeElement(layout, "a", 4, 4);

      const a = result.find(w => w.id === "a");
      const b = result.find(w => w.id === "b");

      expect(a?.h).toBe(4);
      expect(a?.y).toBe(0);

      // 'b' should be pushed down to y=4
      expect(b?.y).toBe(4);
    });

    it("respects grid bounds during resize", () => {
      const layout = [createWidget("a", 10, 0, 2, 2)];
      // Attempt to resize out of bounds right
      const result = resizeElement(layout, "a", 10, 2);
      expect(result[0].w).toBe(2); // Max w is 2 at x=10
    });
  });

  describe("4. String Injection Immunity Validation", () => {
    it("prevents SQLite string concatenation bugs", () => {
      // Simulate SQLite returning strings for integers
      const badLayout: any[] = [
        { id: "a", workspace_id: "ws_1", widget_type: "stats", x: "0", y: "0", w: "4", h: "2", hidden: false },
        { id: "b", workspace_id: "ws_1", widget_type: "stats", x: "0", y: "2", w: "4", h: "2", hidden: false },
      ];

      // Drag 'b' to y=0
      const result = moveElement(badLayout as DashboardWidget[], "b", 0, 0);

      const a = result.find(w => w.id === "a");
      const b = result.find(w => w.id === "b");

      // Number coercion ensures 'a' is pushed to y=2 (not "02" or something wild)
      expect(a?.y).toBe(2);
      expect(b?.y).toBe(0);
      expect(typeof a?.y).toBe("number");
    });
  });
});
