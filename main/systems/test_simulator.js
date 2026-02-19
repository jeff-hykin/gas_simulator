import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createRobot } from "./simulator.js";

// Mock canvas system for testing
function createMockCanvasSystem() {
    const world = [];
    return {
        addToWorld: (item) => world.push(item),
        getWorld: () => world,
        render: () => {},
        setSize: () => {},
    };
}

// Mock map system for testing
function createMockMapSystem() {
    return {
        mapData: {
            gasNodes: [],
            obstacles: [],
            routes: [],
            markers: [],
        },
        element: document.createElement('div'),
    };
}

Deno.test("robot creation with defaults", () => {
    const robot = createRobot();
    assertEquals(robot.x, 0);
    assertEquals(robot.y, 0);
    assertEquals(robot.angle, 0);
    assertEquals(robot.w, 30);
    assertEquals(robot.h, 20);
});

Deno.test("robot creation with custom values", () => {
    const robot = createRobot({ x: 10, y: 20, angle: 45, w: 50, h: 40 });
    assertEquals(robot.x, 10);
    assertEquals(robot.y, 20);
    assertEquals(robot.angle, 45);
    assertEquals(robot.w, 50);
    assertEquals(robot.h, 40);
});
