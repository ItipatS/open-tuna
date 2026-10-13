// Scene view gizmos: the camera path (blue line), camera keys (blue balls; grey when locked) and their
// look targets (orange), the shot camera's frustum, and a move gizmo on the selected (unlocked) camera
// key. Click a ball to select its key, right-click it for its options. Only visible in the Scene view.
import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const N = 400; // path samples

export class SceneGizmos {
  constructor(ed) {
    const { scene, camera, renderer, controls, story } = ed.app;
    this.ed = ed;
    this.mode = 'pos'; // what the move gizmo edits: the key's camera position or its look target
    this.layerMode = 'move'; // 3D model layers: 'move' | 'rotate'
    this.version = -1;
    const g = this.group = new THREE.Group();
    g.visible = false;
    scene.add(g);
    const over = (m) => Object.assign(m, { transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });

    const pathGeo = new THREE.BufferGeometry();
    pathGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    this.path = new THREE.Line(pathGeo, over(new THREE.LineBasicNodeMaterial({ color: 0x4fb8ff, opacity: 0.85 })));
    this.lookGeo = new THREE.BufferGeometry();
    this.lookLines = new THREE.LineSegments(this.lookGeo, over(new THREE.LineBasicNodeMaterial({ color: 0xffb35c, opacity: 0.45 })));
    for (const o of [this.path, this.lookLines]) { o.frustumCulled = false; o.renderOrder = 60; g.add(o); }

    this.ball = new THREE.SphereGeometry(0.5, 16, 12);
    this.matKey = over(new THREE.MeshBasicNodeMaterial({ color: 0x4fb8ff }));
    this.matLook = over(new THREE.MeshBasicNodeMaterial({ color: 0xffb35c, opacity: 0.8 }));
    this.matSel = over(new THREE.MeshBasicNodeMaterial({ color: 0xffffff }));
    this.matLocked = over(new THREE.MeshBasicNodeMaterial({ color: 0x7d8a99, opacity: 0.8 }));
    this.matPath = over(new THREE.MeshBasicNodeMaterial({ color: 0xb4ff5a }));
    // creature paths: one line per path track (pooled), waypoint balls share the marker pool
    this.pathLineMat = over(new THREE.LineBasicNodeMaterial({ color: 0xb4ff5a, opacity: 0.95 }));
    this.pathLines = [];
    this.markers = [];

    // a short stand-in for the shot camera (its real far plane is 9 km)
    this.frustumCam = new THREE.PerspectiveCamera(50, 1, 0.6, 7);
    this.frustumCam.matrixAutoUpdate = false;
    this.frustum = new THREE.CameraHelper(this.frustumCam);
    over(this.frustum.material);
    this.frustum.renderOrder = 61;
    g.add(this.frustum);

    // move gizmo on a proxy object; writes back into the selected key
    this.proxy = new THREE.Object3D();
    scene.add(this.proxy);
    const tc = this.tc = new TransformControls(camera, renderer.domElement);
    tc.setSize(0.9);
    this.tcHelper = tc.getHelper();
    this.tcHelper.renderOrder = 70;
    scene.add(this.tcHelper);
    tc.addEventListener('dragging-changed', (e) => {
      controls.enabled = !e.value && ed.sceneView;
      const tg = this.target();
      // a 3D layer: edit its key at the playhead (created from the current state when it's animated)
      if (e.value && tg?.layer) this.dragKey = tg.key ?? ed.lt.keyAt(tg.layer);
      if (!e.value) { this.dragKey = null; ed.commit(); }
    });
    tc.addEventListener('objectChange', () => {
      const tg = this.target(), p = this.proxy.position.toArray().map((v) => +v.toFixed(3));
      if (tg?.cam) (this.mode === 'look' ? tg.key.look : tg.key.pos).splice(0, 3, ...p);
      else if (tg?.path) tg.key.pos = p;
      else if (tg?.layer && this.dragKey) {
        if (this.tc.mode === 'rotate') { const r = this.proxy.rotation, g = THREE.MathUtils.radToDeg; this.dragKey.rot = [g(r.x), g(r.y), g(r.z)].map((v) => +v.toFixed(1)); }
        else this.dragKey.pos = p;
      }
      else return;
      ed.changed();
    });

    // click a ball to select its key; right-click (without dragging) for its options
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    let down = null;
    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerup', (e) => {
      if (!down || !ed.sceneView || tc.dragging || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(this.markers.filter((m) => m.visible), false)[0]
        ?? ray.intersectObjects(ed.app.layers.group.children.filter((m) => m.visible), true)[0]; // models: any of their meshes
      if (!hit) return;
      const lid = hit.object.userData.layerId;
      if (lid) {
        const lt = ed.tl.layers().find((q) => q.id === lid);
        if (e.button === 2) ed.contextMenu(e.clientX, e.clientY, { kind: 'layer', track: lt });
        else ed.select({ kind: 'track', track: lt });
        return;
      }
      const { key, look, pathTrack } = hit.object.userData, track = pathTrack ?? ed.tl.ofType('camera');
      this.mode = look ? 'look' : 'pos';
      if (e.button === 2) ed.contextMenu(e.clientX, e.clientY, { kind: 'key', track, item: key });
      else ed.select({ kind: 'key', track, item: key });
    });
  }

  selKey() {
    const s = this.ed.sel;
    return s?.kind === 'key' && s.track.type === 'camera' ? s.item : null;
  }

  // what the move gizmo edits: a camera key, a path waypoint, or a 3D layer (a specific key, or its key at the playhead)
  target() {
    const s = this.ed.sel;
    if (s?.kind === 'key' && s.track.type === 'camera') return { cam: true, key: s.item };
    if (s?.kind === 'key' && s.track.type === 'path') return { path: true, key: s.item };
    if (s?.track?.type === 'layer' && s.track.space === 'world') return { layer: s.track, key: s.kind === 'key' ? s.item : null };
    return null;
  }

  rebuild() {
    const { tl } = this.ed, t = tl.ofType('camera');
    this.version = tl.version;
    const keys = t?.keys ?? [];
    // path
    const a = this.path.geometry.attributes.position, k = { pos: [0, 0, 0], look: [0, 0, 0] };
    for (let i = 0; i < N; i++) {
      if (tl.camera((i / (N - 1)) * tl.duration, k)) a.setXYZ(i, ...k.pos);
    }
    a.needsUpdate = true;
    // look lines
    const segs = new Float32Array(keys.length * 6);
    keys.forEach((key, i) => { segs.set(key.pos, i * 6); segs.set(key.look, i * 6 + 3); });
    this.lookGeo.setAttribute('position', new THREE.BufferAttribute(segs, 3));
    // path lines
    const paths = tl.paths();
    while (this.pathLines.length < paths.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      const l = new THREE.Line(g, this.pathLineMat);
      l.frustumCulled = false;
      l.renderOrder = 60;
      this.group.add(l);
      this.pathLines.push(l);
    }
    const pk = { pos: [0, 0, 0], ahead: [0, 0, 0] };
    this.pathLines.forEach((l, i) => {
      const pt = paths[i];
      l.visible = !!pt;
      if (!pt) return;
      const a = l.geometry.attributes.position, t0 = pt.keys[0].t, t1 = pt.keys.at(-1).t;
      for (let j = 0; j < N; j++) { tl.path(pt, t0 + ((t1 - t0) * j) / (N - 1), pk); a.setXYZ(j, ...pk.pos); }
      a.needsUpdate = true;
    });
    const pathKeys = paths.flatMap((pt) => pt.keys.map((key) => ({ key, pt })));
    // markers (pooled): camera keys (pos + look) then path waypoints
    while (this.markers.length < keys.length * 2 + pathKeys.length) {
      const m = new THREE.Mesh(this.ball, this.matKey);
      m.renderOrder = 62;
      m.frustumCulled = false;
      this.group.add(m);
      this.markers.push(m);
    }
    this.markers.forEach((m, i) => {
      if (i >= keys.length * 2) {
        const pk2 = pathKeys[i - keys.length * 2];
        m.visible = !!pk2;
        if (!pk2) return;
        m.userData = { key: pk2.key, pathTrack: pk2.pt };
        m.position.fromArray(pk2.key.pos);
        return;
      }
      const key = keys[i >> 1], look = i % 2 === 1;
      m.visible = !!key;
      if (!key) return;
      m.userData = { key, look };
      m.position.fromArray(look ? key.look : key.pos);
    });
  }

  update() {
    const ed = this.ed, on = ed.sceneView;
    this.group.visible = on;
    if (!on) { if (this.tc.object) this.tc.detach(); this.tcHelper.visible = false; return; }
    if (this.version !== ed.tl.version) this.rebuild();
    const sel = this.selKey();
    for (const m of this.markers) {
      if (!m.visible) continue;
      const s = m.userData.key === sel;
      const pt = m.userData.pathTrack;
      const lk = m.userData.key.locked || (pt ? pt.locked : ed.tl.ofType('camera')?.locked);
      const selP = pt && ed.sel?.item === m.userData.key;
      m.material = selP || (s && (m.userData.look ? this.mode === 'look' : this.mode === 'pos')) ? this.matSel : lk ? this.matLocked : pt ? this.matPath : m.userData.look ? this.matLook : this.matKey;
      // keep balls a constant size on screen
      const d = m.position.distanceTo(ed.app.camera.position);
      m.scale.setScalar(Math.max(0.15, d * 0.012) * (m.userData.look ? 0.7 : 1) * (s ? 1.3 : 1));
    }
    const sc = this.ed.story.cam, fc = this.frustumCam;
    if (fc.fov !== sc.fov || fc.aspect !== sc.aspect) { fc.fov = sc.fov; fc.aspect = sc.aspect; fc.updateProjectionMatrix(); }
    fc.matrixWorld.copy(sc.matrixWorld);
    this.frustum.update();
    const tg = this.target();
    if (tg && !ed.isLocked(ed.sel)) {
      if (!this.tc.dragging) {
        const ks = tg.layer && (tg.key ?? ed.app.layers.state(tg.layer, ed.time));
        this.proxy.position.fromArray(tg.cam ? (this.mode === 'look' ? tg.key.look : tg.key.pos) : tg.path ? tg.key.pos : ks.pos);
        const rot = tg.layer?.kind === 'model' ? ks.rot ?? [0, 0, 0] : [0, 0, 0], d = THREE.MathUtils.degToRad;
        this.proxy.rotation.set(d(rot[0]), d(rot[1]), d(rot[2]), 'YXZ');
        this.tc.setMode(tg.layer?.kind === 'model' && this.layerMode === 'rotate' ? 'rotate' : 'translate');
      }
      if (this.tc.object !== this.proxy) this.tc.attach(this.proxy);
      this.tcHelper.visible = true;
    } else if (this.tc.object) { this.tc.detach(); this.tcHelper.visible = false; }
  }
}
