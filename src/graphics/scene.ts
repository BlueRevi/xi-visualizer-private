import * as THREE from "three";

export function setupBaseScene(): THREE.Scene {
  // Background
  const scene = new THREE.Scene();
  scene.scale.set(1, -1, -1); // FFXI mesh is flipped on the Y and Z axis
  scene.background = new THREE.Color(0x333333); // <- fixed (6 hex digits)

  // Gridlines
  const grid = new THREE.GridHelper(2000, 200, 0xAAAAAA, 0xAAAAAA);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material & { opacity: number }).opacity = 0.2;
  scene.add(grid);

  // LIGHTS
  const hemiLight = new THREE.HemisphereLight(0xFFFFFF, 0xFFFFFF, 1);
  hemiLight.position.set(300, 1000, 300);
  scene.add(hemiLight);

  // --- DEBUG EXPORT: expose scene (read-only) ---
  Object.defineProperty(globalThis as any, "scene", {
    value: scene,
    writable: false,
  });
  console.log("[xi-visualizer] Exposed scene from setupBaseScene()");

  return scene;
}