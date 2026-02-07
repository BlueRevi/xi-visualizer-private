import CameraControls from "camera-controls";
import * as holdEvent from "hold-event";
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls";

export function adjustCameraAspect(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
}

export function fitCameraToContents(camera: THREE.PerspectiveCamera, controls: MapControls, objectIter: (fn: (obj: THREE.Object3D) => any) => any) {
  const box = new THREE.Box3();
  let matrix = new THREE.Matrix4();
  let vec = new THREE.Vector3();

  // Loop through all children in the scene
  objectIter(object => {
    if (object instanceof THREE.InstancedMesh) {
      // Compute mesh bounding box
      for (let i = 0; i < object.count; i++) {
        matrix.fromArray(object.instanceMatrix.array, i * 16);
        vec.setFromMatrixPosition(matrix);

        // Correct for flipped Z-axis and Y-axis of FFXI
        vec.z = -vec.z;
        vec.y = -vec.y;
        box.expandByPoint(vec);
      }
    } else if (object instanceof THREE.Object3D) {
      box.expandByObject(object);
    }
  });

  const center = new THREE.Vector3();
  const size = new THREE.Vector3();

  box.getCenter(center);
  box.getSize(size);

  if (size.length() == 0) {
    return;
  }

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);

  let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
  cameraZ *= 1.1

  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);

  const newPosition = new THREE.Vector3().copy(center).addScaledVector(direction, -cameraZ);

  camera.position.copy(newPosition);

  controls.target.copy(center);
  controls.update();
}

export function addMapControls(camera: THREE.Camera, element?: HTMLElement) {
  return new MapControls(camera, element);
}

export function addCustomCameraControls(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, element?: HTMLElement) {
  CameraControls.install({ THREE: THREE });
  const controls = new CameraControls(camera, element);
  // Flips left and right mouse buttons
  controls.draggingSmoothTime = 0;
  controls.mouseButtons = {
    left: CameraControls.ACTION.TRUCK,
    right: CameraControls.ACTION.ROTATE,
    middle: CameraControls.ACTION.DOLLY,
    wheel: CameraControls.ACTION.DOLLY,
  };

  const baseSpeed = 0.05;
  const shiftSpeed = baseSpeed * 3;
  let currentSpeed = baseSpeed;

  window.addEventListener("keydown", ev => {
    if (ev.code == "ShiftLeft" || ev.code == "ShiftRight") {
      currentSpeed = shiftSpeed;
    }
  });
  window.addEventListener("keyup", ev => {
    if (ev.code == "ShiftLeft" || ev.code == "ShiftRight") {
      currentSpeed = baseSpeed;
    }
  });

  const wKey = new holdEvent.KeyboardKeyHold("KeyW", 16.666);
  const aKey = new holdEvent.KeyboardKeyHold("KeyA", 16.666);
  const sKey = new holdEvent.KeyboardKeyHold("KeyS", 16.666);
  const dKey = new holdEvent.KeyboardKeyHold("KeyD", 16.666);
  aKey.addEventListener("holding", function (event) {
    controls.truck(-1 * currentSpeed * event!.deltaTime, 0, false);
  });
  dKey.addEventListener("holding", function (event) {
    controls.truck(currentSpeed * event!.deltaTime, 0, false);
  });
  wKey.addEventListener("holding", function (event) {
    controls.forward(currentSpeed * event!.deltaTime, false);
  });
  sKey.addEventListener("holding", function (event) {
    controls.forward(-1 * currentSpeed * event!.deltaTime, false);
  });

  const leftKey = new holdEvent.KeyboardKeyHold("ArrowLeft", 100);
  const rightKey = new holdEvent.KeyboardKeyHold("ArrowRight", 100);
  const upKey = new holdEvent.KeyboardKeyHold("ArrowUp", 100);
  const downKey = new holdEvent.KeyboardKeyHold("ArrowDown", 100);
  leftKey.addEventListener("holding", function (event) {
    controls.rotate(
      -0.1 * THREE.MathUtils.DEG2RAD * event!.deltaTime,
      0,
      true,
    );
  });
  rightKey.addEventListener("holding", function (event) {
    controls.rotate(
      0.1 * THREE.MathUtils.DEG2RAD * event!.deltaTime,
      0,
      true,
    );
  });
  upKey.addEventListener("holding", function (event) {
    controls.rotate(
      0,
      -0.05 * THREE.MathUtils.DEG2RAD * event!.deltaTime,
      true,
    );
  });
  downKey.addEventListener("holding", function (event) {
    controls.rotate(
      0,
      0.05 * THREE.MathUtils.DEG2RAD * event!.deltaTime,
      true,
    );
  });

  return controls;
}

// --- DEBUG EXPORT FOR OVERLAYS (read-only) ---
// This file imports THREE, so we can safely expose it now.
// scene/camera/renderer are not available in this file; those must be exported
// where they are actually created (see Section B).
Object.defineProperty(globalThis as any, "THREE", {
  value: THREE,
  writable: false,
});
console.log("[xi-visualizer] Exposed THREE from camera utils");
``
