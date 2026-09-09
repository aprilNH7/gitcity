import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import type { Day } from './data';
import type { Theme } from './themes';

const CELL = 1;
const ROWS = 7;
// Empty cells between two districts in compare mode. Wide enough that the two
// skylines never overlap on screen, tight enough that both still fill the frame.
const GAP = 14;
const FOOTPRINT = 0.78;
const MIN_HEIGHT = 0.18;
const MAX_HEIGHT = 11;
const RISE_DURATION = 0.9;
const RISE_PAD = 0.2;
const HOVER_NONE = -1;

/** Clamp a value between a lower and upper bound. */
function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export interface HoverInfo {
  date: string;
  count: number;
  x: number;
  y: number;
  /** Which district the building belongs to. Empty for a single city. */
  label: string;
}

/** A screen space anchor for a district caption, in CSS pixels. */
export interface LabelPos {
  label: string;
  total: number;
  x: number;
  y: number;
  visible: boolean;
}

export interface District {
  label: string;
  days: Day[];
}

interface Building {
  col: number;
  row: number;
  zone: number;
  height: number;
  /** Colour bucket. GitHub's own level for a single city, a shared bucket when comparing. */
  shade: number;
  delay: number;
  day: Day;
}

/**
 * Renders a contribution graph as a city: one plot per day, height driven by
 * commit count, colour by GitHub's own 0-4 intensity level.
 */
export class City {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private clock = new THREE.Clock();

  private uniforms = { uTime: { value: 0 }, uGlow: { value: 1.2 } };
  private group = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private reflection: THREE.InstancedMesh | null = null;
  private ground: THREE.Mesh | null = null;
  private grid: THREE.GridHelper | null = null;
  private stars: THREE.Points | null = null;
  private motes: THREE.Points | null = null;
  private moteVel: Float32Array | null = null;

  private buildings: Building[] = [];
  private cols = 53;
  private zones: District[] = [];
  private zoneMeta: Array<{ top: number; total: number }> = [];
  /** Quarter turn used for two districts on a portrait screen. */
  private turned = false;
  private riseTime = 0;
  private rising = false;
  private theme: Theme;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(-10, -10);
  private pointerPx = { x: 0, y: 0 };
  private hoverHandler: ((info: HoverInfo | null) => void) | null = null;
  private labelHandler: ((items: LabelPos[]) => void) | null = null;
  private lastHover = HOVER_NONE;

  private disposed = false;

  constructor(private canvas: HTMLCanvasElement, theme: Theme) {
    this.theme = theme;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // Needed so "Save PNG" can read the framebuffer after a frame is drawn.
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 400);
    this.camera.position.set(-26, 22, 34);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.34;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 200;
    // Stop the camera dropping under the plaza, the reflection gives it away.
    this.controls.maxPolarAngle = Math.PI * 0.487;
    this.controls.target.set(0, 1.5, 0);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), theme.bloom, 0.5, 0.42);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.scene.add(this.group);
    this.buildLights();
    this.applyTheme(theme);
    this.resize();

    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('resize', this.resize);
  }

  onHover(handler: (info: HoverInfo | null) => void) {
    this.hoverHandler = handler;
  }

  /** Fired every frame while two districts are on screen, never for one. */
  onLabels(handler: (items: LabelPos[]) => void) {
    this.labelHandler = handler;
  }

  // ---------------------------------------------------------------- scene

  private buildLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(-18, 30, 18);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x88bbff, 0.5);
    rim.position.set(22, 12, -20);
    this.scene.add(rim);
  }

  private makeBuildingMaterial(transparent: boolean) {
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.34,
      metalness: 0.16,
      transparent,
      opacity: transparent ? 0.24 : 1,
      depthWrite: !transparent,
      side: transparent ? THREE.DoubleSide : THREE.FrontSide,
    });

    // Per-instance emissive. MeshStandardMaterial has no per-instance emissive
    // slot, so we reuse the instance colour, punch lit windows into the walls,
    // and add a light wave sweeping across the city on the X axis.
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.uniforms.uGlow = this.uniforms.uGlow;

      shader.vertexShader =
        'varying vec3 vWPos;\n' +
        shader.vertexShader.replace(
          '#include <project_vertex>',
          '#include <project_vertex>\n\tvWPos = (modelMatrix * instanceMatrix * vec4( transformed, 1.0 )).xyz;'
        );

      shader.fragmentShader =
        'varying vec3 vWPos;\nuniform float uTime;\nuniform float uGlow;\n' +
        shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           // Window grid. Rows come from world height, columns from whichever
           // horizontal axis faces the camera, so every wall is covered.
           float axis = abs( vNormal.x ) > 0.5 ? vWPos.z : vWPos.x;
           float rows = step( 0.52, fract( vWPos.y * 3.2 ) );
           float cols = step( 0.45, fract( axis * 5.0 ) );
           float sides = 1.0 - step( 0.7, abs( vNormal.y ) );
           float win = rows * cols * sides;

           float sweep = sin( uTime * 0.32 ) * 30.0;
           float pulse = 1.0 + 0.45 * exp( -pow( ( vWPos.x - sweep ) / 3.4, 2.0 ) );

           totalEmissiveRadiance = vColor * uGlow * ( 0.16 + 0.95 * win ) * pulse;`
        );
    };
    mat.customProgramCacheKey = () => (transparent ? 'gitcity-refl' : 'gitcity-solid');
    return mat;
  }

  private makeStars(theme: Theme) {
    const count = 1400;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Shell around the scene, biased above the horizon.
      const r = 90 + Math.random() * 80;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(1 - Math.random() * 1.15);
      pos[i * 3] = Math.sin(p) * Math.cos(t) * r;
      pos[i * 3 + 1] = Math.abs(Math.cos(p)) * r * 0.75 + 4;
      pos[i * 3 + 2] = Math.sin(p) * Math.sin(t) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: theme.starColor,
        size: 0.55,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      })
    );
  }

  private makeMotes(theme: Theme) {
    const count = 420;
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count);
    const half = (this.turned ? this.depth : this.cols) * CELL / 2 + 4;
    const halfD = (this.turned ? this.cols : this.depth) * CELL / 2 + 2;
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() * 2 - 1) * half;
      pos[i * 3 + 1] = Math.random() * 18;
      pos[i * 3 + 2] = (Math.random() * 2 - 1) * halfD;
      vel[i] = 0.25 + Math.random() * 0.9;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.moteVel = vel;
    return new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: new THREE.Color(theme.ramp[3]),
        size: 0.17,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
  }

  applyTheme(theme: Theme) {
    this.theme = theme;
    this.scene.background = new THREE.Color(theme.bg);
    this.scene.fog = new THREE.Fog(theme.fog, 46, 165);
    this.bloom.strength = theme.bloom;
    this.uniforms.uGlow.value = theme.glow;

    if (this.ground) {
      (this.ground.material as THREE.MeshBasicMaterial).color.setHex(theme.ground);
    }
    if (this.grid) {
      const m = this.grid.material as THREE.Material | THREE.Material[];
      const mats = Array.isArray(m) ? m : [m];
      for (const mm of mats) (mm as THREE.LineBasicMaterial).color.setHex(theme.grid);
    }
    if (this.stars) {
      (this.stars.material as THREE.PointsMaterial).color.setHex(theme.starColor);
    }
    if (this.motes) {
      (this.motes.material as THREE.PointsMaterial).color.setHex(theme.ramp[3]);
    }
    if (this.mesh) this.paint();
  }

  // ---------------------------------------------------------------- build

  build(days: Day[]) {
    this.assemble([{ label: '', days }]);
  }

  /**
   * Two cities in one scene, laid out front to back. Both districts share a
   * single height scale and a single colour scale, which is the whole point:
   * per city normalisation would make a 5 commit best day look identical to a
   * 500 commit one.
   */
  compare(a: District, b: District) {
    this.assemble([a, b]);
  }

  /**
   * True when two districts were turned a quarter and laid out left to right
   * for a portrait screen. Callers use it to caption them differently.
   */
  get sideBySide() {
    return this.turned;
  }

  private get depth() {
    const n = Math.max(1, this.zones.length);
    return n * ROWS + (n - 1) * GAP;
  }

  /** Local Z of the first row of a district. */
  private zoneZ(zone: number) {
    return zone * (ROWS + GAP) * CELL;
  }

  private assemble(districts: District[]) {
    this.clear();
    const filled = districts.filter((d) => d.days.length);
    if (!filled.length) return;

    this.zones = filled;
    const many = filled.length > 1;
    // A phone held upright has no room for two 53 week bands stacked in depth,
    // so the whole layout gets a quarter turn: the year runs down the long axis
    // and the two skylines sit left and right of each other.
    this.turned = many && this.camera.aspect < 1;

    // One scale across every district so the two skylines are comparable.
    const max = Math.max(1, ...filled.flatMap((d) => d.days.map((x) => x.count)));
    const norm = Math.log1p(max);

    this.buildings = [];
    filled.forEach((district, zone) => {
      const offset = new Date(district.days[0].date + 'T00:00:00Z').getUTCDay();
      for (let i = 0; i < district.days.length; i++) {
        const day = district.days[i];
        const idx = offset + i;
        const n = Math.log1p(day.count) / norm;
        this.buildings.push({
          col: Math.floor(idx / ROWS),
          row: idx % ROWS,
          zone,
          height: day.count === 0 ? MIN_HEIGHT : MIN_HEIGHT + n * (MAX_HEIGHT - MIN_HEIGHT),
          // GitHub's levels are bucketed per user, so they cannot be compared
          // across accounts. Rebucket against the shared max instead.
          shade: many
            ? day.count === 0 ? 0 : Math.min(4, Math.ceil((day.count / max) * 4))
            : day.level,
          delay: Math.floor(idx / ROWS) * 0.016 + (idx % ROWS) * 0.012 + zone * 0.1,
          day,
        });
      }
    });
    this.cols = Math.max(...this.buildings.map((b) => b.col)) + 1;
    this.zoneMeta = filled.map((district, zone) => ({
      top: Math.max(1, ...this.buildings.filter((b) => b.zone === zone).map((b) => b.height)),
      total: district.days.reduce((a, d) => a + d.count, 0),
    }));

    const geo = new THREE.BoxGeometry(FOOTPRINT, 1, FOOTPRINT);
    // Anchor at the base so scaling Y grows upward instead of both ways.
    geo.translate(0, 0.5, 0);

    this.mesh = new THREE.InstancedMesh(geo, this.makeBuildingMaterial(false), this.buildings.length);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;

    this.reflection = new THREE.InstancedMesh(geo, this.makeBuildingMaterial(true), this.buildings.length);
    this.reflection.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.reflection.frustumCulled = false;
    this.reflection.scale.y = -1;
    this.reflection.position.y = -0.01;
    this.reflection.renderOrder = 0;

    const w = this.cols * CELL;
    // Centre the layout on the origin. A quarter turn swaps which axis is
    // which, so the offsets swap with it.
    this.group.rotation.y = this.turned ? Math.PI / 2 : 0;
    this.group.position.set(
      this.turned ? -((this.depth - 1) * CELL) / 2 : -(w - CELL) / 2,
      0,
      this.turned ? ((this.cols - 1) * CELL) / 2 : -((this.depth - 1) * CELL) / 2
    );
    this.group.add(this.mesh, this.reflection);

    this.paint();
    this.writeMatrices(0);

    // Plaza. Semi transparent so the mirrored city reads through it.
    const groundGeo = new THREE.PlaneGeometry(200, 200);
    groundGeo.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(
      groundGeo,
      new THREE.MeshBasicMaterial({
        color: this.theme.ground,
        transparent: true,
        opacity: 0.84,
        depthWrite: false,
      })
    );
    this.ground.renderOrder = 1;
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(140, 70, this.theme.grid, this.theme.grid);
    (this.grid.material as THREE.LineBasicMaterial).transparent = true;
    (this.grid.material as THREE.LineBasicMaterial).opacity = 0.13;
    (this.grid.material as THREE.LineBasicMaterial).depthWrite = false;
    this.grid.position.y = 0.01;
    this.grid.renderOrder = 2;
    this.scene.add(this.grid);

    this.stars = this.makeStars(this.theme);
    this.scene.add(this.stars);

    this.motes = this.makeMotes(this.theme);
    this.scene.add(this.motes);

    this.riseTime = 0;
    this.rising = true;
    this.frameCamera();
  }

  private paint() {
    if (!this.mesh || !this.reflection) return;
    const c = new THREE.Color();
    for (let i = 0; i < this.buildings.length; i++) {
      c.setHex(this.theme.ramp[clamp(this.buildings[i].shade, 0, 4)]);
      this.mesh.setColorAt(i, c);
      this.reflection.setColorAt(i, c);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.reflection.instanceColor) this.reflection.instanceColor.needsUpdate = true;
  }

  /** t is 0..1 across the rise animation. */
  private writeMatrices(t: number) {
    if (!this.mesh || !this.reflection) return;
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i];
      const local = clamp((t - b.delay) / RISE_DURATION, 0, 1);
      const eased = local === 0 ? 0 : 1 - Math.pow(2, -9 * local); // easeOutExpo
      const h = Math.max(0.001, b.height * eased);
      m.makeScale(1, h, 1);
      m.setPosition(b.col * CELL, 0, this.zoneZ(b.zone) + b.row * CELL);
      this.mesh.setMatrixAt(i, m);
      this.reflection.setMatrixAt(i, m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.reflection.instanceMatrix.needsUpdate = true;
  }

  private frameCamera() {
    const many = this.zones.length > 1;
    const halfCols = (this.cols * CELL) / 2;
    const halfDepth = (this.depth * CELL) / 2;
    const halfW = this.turned ? halfDepth : halfCols;
    const halfD = this.turned ? halfCols : halfDepth;
    const topH = Math.max(1, ...this.buildings.map((b) => b.height));

    const target = new THREE.Vector3(0, topH * (many ? 0.3 : 0.42), 0);
    this.controls.target.copy(target);

    // Two districts are read straight on, so they stack as two clean bands
    // instead of shearing into each other. One city gets the livelier angle.
    const dir = this.turned
      ? new THREE.Vector3(0.06, 0.66, 0.75).normalize()
      : many
        ? new THREE.Vector3(-0.08, 0.6, 0.79).normalize()
        : new THREE.Vector3(-0.3, 0.42, 0.86).normalize();

    // Exact fit: project every corner of the city's bounding box into camera
    // space and take the distance that keeps all eight inside the frustum.
    // The approximate version cropped the ends at wide aspect ratios.
    const vFov = (this.camera.fov * Math.PI) / 180;
    const tanV = Math.tan(vFov / 2);
    const tanH = tanV * this.camera.aspect;

    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(dir, up).normalize();
    const camUp = new THREE.Vector3().crossVectors(right, dir).normalize();

    let dist = 0;
    const p = new THREE.Vector3();
    for (const sx of [-1, 1]) {
      for (const sy of [0, 1]) {
        for (const sz of [-1, 1]) {
          p.set(sx * halfW, sy * topH, sz * halfD).sub(target);
          const along = p.dot(dir);
          dist = Math.max(
            dist,
            along + Math.abs(p.dot(right)) / tanH,
            along + Math.abs(p.dot(camUp)) / tanV
          );
        }
      }
    }

    this.camera.position.copy(target).addScaledVector(dir, dist * 1.06);
    this.controls.update();
  }

  resetView() {
    this.frameCamera();
  }

  // ---------------------------------------------------------------- loop

  private onPointerMove = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.pointerPx = { x: e.clientX, y: e.clientY };
  };

  private onPointerLeave = () => {
    this.pointer.set(-10, -10);
    if (this.lastHover !== HOVER_NONE) {
      this.lastHover = HOVER_NONE;
      this.hoverHandler?.(null);
    }
  };

  private updateHover() {
    if (!this.mesh || !this.hoverHandler) return;
    if (this.pointer.x < -1 || this.pointer.x > 1) return;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    const id = hit && hit.instanceId !== undefined ? hit.instanceId : HOVER_NONE;
    if (id === this.lastHover) return;

    this.lastHover = id;
    if (id === HOVER_NONE) {
      this.hoverHandler(null);
    } else {
      const b = this.buildings[id];
      this.hoverHandler({
        date: b.day.date,
        count: b.day.count,
        x: this.pointerPx.x,
        y: this.pointerPx.y,
        label: this.zones[b.zone]?.label ?? '',
      });
    }
  }

  /**
   * Screen anchors for the district captions, hung off the left end of each
   * band so they never sit inside a skyline or drift into the other district.
   */
  private updateLabels() {
    // Turned side by side on a phone the captions would sit behind the panels,
    // and the table's own column order already says which city is which.
    if (!this.labelHandler || this.zones.length < 2 || this.turned) return;

    const r = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector3();

    this.labelHandler(
      this.zones.map((district, zone) => {
        const meta = this.zoneMeta[zone];

        // Stacked in depth the caption goes off the left end of its band: sat
        // above, the near one lands in the gap and reads as neither city's.
        v.set(-1.2 * CELL, Math.max(2.4, meta.top * 0.5), this.zoneZ(zone) + ((ROWS - 1) / 2) * CELL);
        this.group.localToWorld(v);
        v.project(this.camera);

        return {
          label: district.label,
          total: meta.total,
          x: (v.x * 0.5 + 0.5) * r.width + r.left,
          y: (-v.y * 0.5 + 0.5) * r.height + r.top,
          visible: v.z < 1,
        };
      })
    );
  }

  private tickMotes(dt: number) {
    if (!this.motes || !this.moteVel) return;
    const attr = this.motes.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < this.moteVel.length; i++) {
      arr[i * 3 + 1] += this.moteVel[i] * dt;
      if (arr[i * 3 + 1] > 20) arr[i * 3 + 1] = -1;
    }
    attr.needsUpdate = true;
  }

  start() {
    const loop = () => {
      if (this.disposed) return;
      requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      this.uniforms.uTime.value += dt;

      if (this.rising) {
        this.riseTime += dt;
        this.writeMatrices(this.riseTime);
        const last = this.buildings[this.buildings.length - 1];
        if (last && this.riseTime > last.delay + RISE_DURATION + RISE_PAD) this.rising = false;
      }

      if (this.stars) this.stars.rotation.y += dt * 0.006;
      this.tickMotes(dt);
      this.updateHover();
      this.controls.update();
      this.updateLabels();
      this.composer.render();
    };
    loop();
  }

  private resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
  };

  // ---------------------------------------------------------------- export

  snapshotPNG(): string {
    this.composer.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** Solid, watertight-enough boxes on a base plate, ready to slice. */
  exportSTL(): Blob {
    const parts: THREE.BufferGeometry[] = [];
    const w = this.cols * CELL;
    const d = this.depth * CELL;

    const plate = new THREE.BoxGeometry(w + 2, 0.6, d + 2);
    plate.translate(0, -0.3, 0);
    parts.push(plate);

    for (const b of this.buildings) {
      if (b.day.count === 0) continue;
      const g = new THREE.BoxGeometry(FOOTPRINT, b.height, FOOTPRINT);
      g.translate(
        b.col * CELL - w / 2 + CELL / 2,
        b.height / 2,
        this.zoneZ(b.zone) + b.row * CELL - d / 2 + CELL / 2
      );
      parts.push(g);
    }

    const merged = BufferGeometryUtils.mergeGeometries(parts, false);
    const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial());
    const data = new STLExporter().parse(mesh, { binary: true }) as unknown as DataView;
    for (const p of parts) p.dispose();
    merged.dispose();
    return new Blob([data], { type: 'model/stl' });
  }

  // ---------------------------------------------------------------- teardown

  private clear() {
    for (const obj of [this.mesh, this.reflection, this.ground, this.grid, this.stars, this.motes]) {
      if (!obj) continue;
      obj.removeFromParent();
      const anyObj = obj as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
      anyObj.geometry?.dispose();
      const mat = anyObj.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
    this.mesh = this.reflection = null;
    this.ground = null;
    this.grid = null;
    this.stars = this.motes = null;
    this.moteVel = null;
    this.buildings = [];
    this.zones = [];
    this.zoneMeta = [];
    this.lastHover = HOVER_NONE;
  }

  dispose() {
    this.disposed = true;
    this.clear();
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('resize', this.resize);
  }
}
