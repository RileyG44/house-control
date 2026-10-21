// A TV in the model, showing what the real one shows: dark when it is off, asleep or out of
// reach; lit with the app's logo on its brand colour when it is on, with a faint spill of
// that colour on the room. Changes cross-fade; turning on fades up from black.
import * as THREE from 'three';
import { appInfo, paintBackground, paintMark, SYSTEM } from '../tv/apps.js';

// Sharp enough for the close-up in front of the TV, where the screen fills the view.
const W = 1024;
const H = 576;
const GLOW = 1.05;    // the screen's emissive intensity when lit
const SPILL = 0.55;   // the coloured light it throws into the room
const FADE = 0.3;     // seconds for a cross-fade

export class TvUnit {
  /** `piece`: one of buildFurniture's userData.tvs. */
  constructor({ index, item, group, screen, box }, { anisotropy = 4 } = {}) {
    this.index = index;
    this.item = item;
    this.group = group;
    this.screen = screen;
    this.id = null;
    [this.w, this.h] = screen.userData.size;

    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, W, H);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = anisotropy;
    const m = screen.material;
    m.emissive = new THREE.Color('#ffffff');
    m.emissiveMap = this.texture;
    m.emissiveIntensity = 0;
    m.needsUpdate = true;

    // A small coloured light in front of the screen: the TV glows in the room.
    this.spill = new THREE.PointLight(0xffffff, 0, 2.6, 2);
    this.spill.position.set(screen.position.x, screen.position.y + this.h * 0.5, screen.position.z + 0.45);
    group.add(this.spill);

    // The whole TV and its cabinet is what a click or a tap finds.
    const size = box.getSize(new THREE.Vector3()).addScalar(0.04);
    this.hit = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshBasicMaterial());
    this.hit.geometry.computeBoundingBox();
    box.getCenter(this.hit.position);
    this.hit.visible = false;
    this.hit.userData = { kind: 'tv', id: null };
    group.add(this.hit);

    this.level = 0;       // how lit the screen is, 0..1
    this.goal = 0;
    this.shown = null;    // the picture on the screen (an app id), and the one fading out
    this.leaving = null;
    this.fade = 1;
    this.color = new THREE.Color('#000000');
    this.goalColor = new THREE.Color('#000000');
    this.hover = 0;
    this.hoverGoal = 0;
  }

  /** Which real TV this piece shows (null: none, it stays dark). */
  link(id) {
    if (this.id === id) return;
    this.id = id;
    this.hit.userData.id = id;
  }

  /** The TV's state from tv/client.js (or null); `instant` skips the fades. */
  apply(device, { instant = false } = {}) {
    const on = Boolean(this.id && device?.online && device.on);
    this.goal = on ? 1 : 0;
    if (on) {
      const app = device.app ? appInfo(device.app) : SYSTEM.home;
      const key = `${app.id}:${app.name}`;
      if (key !== this.shown) {
        // A new picture fades over the old one; from a dark screen it just fades up.
        this.leaving = this.level > 0.05 ? this.shownApp : null;
        this.shown = key;
        this.shownApp = app;
        this.fade = this.leaving ? 0 : 1;
        this.draw();
      }
      this.goalColor.set(app.glow);
    }
    if (instant) { this.level = this.goal; this.fade = 1; this.leaving = null; this.color.copy(this.goalColor); this.draw(); this.write(); }
  }

  draw() {
    const { ctx } = this;
    ctx.globalAlpha = 1;
    if (this.leaving) this.paint(this.leaving);
    if (this.shownApp) {
      ctx.globalAlpha = this.leaving ? this.fade : 1;
      this.paint(this.shownApp);
      ctx.globalAlpha = 1;
    }
    this.texture.needsUpdate = true;
  }

  paint(app) {
    paintBackground(this.ctx, app, W, H);
    paintMark(this.ctx, app, W / 2, H / 2, H * 0.78);
  }

  write() {
    const lit = this.level * (1 + this.hover * 0.18);
    this.screen.material.emissiveIntensity = lit * GLOW;
    this.spill.color.copy(this.color);
    this.spill.intensity = this.level * SPILL;
  }

  update(dt) {
    const before = this.level;
    // Up quickly (about 300 ms), down a little faster.
    const rate = this.goal > this.level ? 9 : 12;
    this.level += (this.goal - this.level) * (1 - Math.exp(-dt * rate));
    if (Math.abs(this.goal - this.level) < 0.003) this.level = this.goal;
    this.color.lerp(this.goalColor, 1 - Math.exp(-dt * 8));
    this.hover += (this.hoverGoal - this.hover) * (1 - Math.exp(-dt * 14));
    let fading = false;
    if (this.leaving) {
      this.fade = Math.min(1, this.fade + dt / FADE);
      if (this.fade >= 1) this.leaving = null;
      this.draw();
      fading = true;
    }
    this.write();
    return fading || this.level !== before || Math.abs(this.hoverGoal - this.hover) > 0.004;
  }

  /** The screen's middle and the way it faces (world space), and its size in metres. */
  face() {
    this.screen.updateWorldMatrix(true, false);
    const center = this.screen.localToWorld(new THREE.Vector3(0, this.h / 2 + 0.01, 0.006));
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(this.screen.matrixWorld);
    normal.y = 0;
    normal.normalize();
    return { center, normal, w: this.w, h: this.h };
  }

  /** The top middle of the screen, for the tooltip. */
  anchor(out) {
    return out.set(0, this.h + 0.08, 0).applyMatrix4(this.screen.matrixWorld);
  }

  dispose() {
    this.texture.dispose();
  }
}
