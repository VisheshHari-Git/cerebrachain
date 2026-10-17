import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Color, Group, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { BrainMode } from './Hero';

// Deterministic illustration derived from the Stitch particle ellipsoid.
// This geometry is not a medical mesh, scan, prediction, or trained model.
function createBrain() {
  let seed = 84721;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const positions = new Float32Array(2800 * 3);
  const colors = new Float32Array(positions.length);
  const purple = new Color('#8b5cf6'), cyan = new Color('#00e5ff'), green = new Color('#00e6a8');
  for (let i = 0; i < positions.length; i += 3) {
    const theta = random() * Math.PI * 2, phi = Math.acos(2 * random() - 1);
    const r = 4.2 + Math.sin(theta * 3) * Math.cos(phi * 2) * 0.8 + random() * 0.4;
    let x = r * 1.08 * Math.sin(phi) * Math.cos(theta) + (Math.sin(theta) > 0 ? 0.35 : -0.35);
    let y = r * 0.88 * Math.cos(phi), z = r * 1.35 * Math.sin(phi) * Math.sin(theta);
    const sulcus = Math.sin(x * 2.2) * Math.cos(y * 2.2) * Math.sin(z * 2);
    x += sulcus * 0.35; y += sulcus * 0.28; z += sulcus * 0.32;
    positions.set([x, y, z], i);
    const c = random() < 0.15 ? green : (x > 0 ? cyan.clone().lerp(purple, random() * 0.4) : purple.clone().lerp(cyan, random() * 0.35));
    colors.set([c.r, c.g, c.b], i);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const fibers = new Float32Array(210 * 6);
  for (let i = 0; i < 210; i++) {
    const a = Math.floor(random() * 2800) * 3, b = Math.floor(random() * 2800) * 3;
    fibers.set(positions.slice(a, a + 3), i * 6); fibers.set(positions.slice(b, b + 3), i * 6 + 3);
  }
  const lines = new BufferGeometry(); lines.setAttribute('position', new BufferAttribute(fibers, 3));
  return { geometry, lines };
}

function Scene({ mode, reducedMotion, command }: { mode: BrainMode; reducedMotion: boolean; command: { kind: string; sequence: number } }) {
  const { camera, gl, invalidate } = useThree();
  const controls = useRef<OrbitControls | null>(null);
  const group = useRef<Group>(null);
  const { geometry, lines } = useMemo(createBrain, []);
  const sprite = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, '#ffffff'); gradient.addColorStop(0.2, '#ffffffbb'); gradient.addColorStop(1, '#ffffff00');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 32, 32);
    return new CanvasTexture(canvas);
  }, []);
  useEffect(() => {
    const orbit = new OrbitControls(camera, gl.domElement);
    orbit.enableDamping = false; orbit.enablePan = false; orbit.minDistance = 11; orbit.maxDistance = 34;
    orbit.rotateSpeed = 0.55; orbit.zoomSpeed = 0.65;
    const onChange = () => invalidate();
    orbit.addEventListener('change', onChange);
    controls.current = orbit;
    return () => { orbit.removeEventListener('change', onChange); orbit.dispose(); controls.current = null; };
  }, [camera, gl, invalidate]);
  useEffect(() => {
    if (command.kind === 'in' || command.kind === 'out') {
      camera.position.multiplyScalar(command.kind === 'in' ? 0.9 : 1.1);
      camera.position.clampLength(11, 34);
    } else if (command.kind === 'rotate') camera.position.applyAxisAngle(new Vector3(0, 1, 0), 0.25);
    controls.current?.update(); invalidate();
  }, [command, camera, invalidate]);
  useFrame((_, delta) => {
    if (group.current && !reducedMotion) group.current.rotation.y += Math.min(delta, 0.1) * 0.08;
  });
  return <group ref={group} rotation={[0.1, -0.35, 0]}>
    <points geometry={geometry}><pointsMaterial size={mode === 'weights' ? 0.28 : 0.2} map={sprite} vertexColors transparent opacity={0.9} blending={AdditiveBlending} depthWrite={false} /></points>
    <lineSegments geometry={lines} visible={mode !== 'tumor'}><lineBasicMaterial color={mode === 'weights' ? '#a4ffd6' : '#00e5ff'} transparent opacity={0.12} /></lineSegments>
    {mode === 'tumor' && <group position={[1.8, 0.6, 1.4]}><mesh><sphereGeometry args={[1.1, 20, 20]} /><meshBasicMaterial color="#ff5252" wireframe transparent opacity={0.7} /></mesh><mesh><sphereGeometry args={[1.3, 16, 16]} /><meshBasicMaterial color="#ffb547" transparent opacity={0.1} depthWrite={false} /></mesh></group>}
    <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -4.7, 0]}><torusGeometry args={[6.3, 0.012, 6, 100]} /><meshBasicMaterial color="#00e5ff" transparent opacity={0.4} /></mesh>
  </group>;
}

export default function BrainCanvas(props: { mode: BrainMode; reducedMotion: boolean; command: { kind: string; sequence: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className="brain-canvas" role="img" aria-label={`Interactive illustrative brain: ${props.mode}. Use drag, pinch, or the camera buttons.`}>
    <Canvas camera={{ position: [0, 0, 21], fov: 45 }} dpr={[1, 1.5]} frameloop={visible && !props.reducedMotion ? 'always' : 'demand'} gl={{ antialias: true, alpha: true }} fallback={<p className="brain-loading">WebGL unavailable · Brain illustration requires WebGL</p>}><Scene {...props} /></Canvas>
  </div>;
}
