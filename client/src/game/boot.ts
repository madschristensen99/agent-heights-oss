import Phaser from "phaser";
import { CHAR_VARIANTS } from "../../../shared/types";
import { CHAR_FRAME_W, CHAR_FRAME_H, CHAR_FRAMES_PER_ROW } from "./chargen";
import { getEssentialTextureSteps, getDeferredTextureSteps, registerThemeCreatures } from "./textures";
import { loadTextures as loadTexturesFromCache, saveTextures as saveTexturesToCache } from "./texture-cache";
import type { Dir } from "./agent";
import { onAuthChange, isAuthEnabled, type AuthState } from "../auth";
import { Store } from "../store";
import {
  AI_CHAR_TEXTURES,
  AI_HAIR_STYLES, AI_HAIR_DIRS, AI_HAIR_POSES, hairFrameKey,
  AI_BEARD_STYLES, beardFrameKey,
  AI_SHIRT_STYLES, shirtFrameKey,
  AI_PANTS_STYLES, pantsFrameKey,
  AI_ACCESSORY_STYLES, accessoryFrameKey,
  AI_HEAD_FEATURE_STYLES, headFeatureFrameKey,
  AI_TILE_TEXTURES, AI_OBJECT_TEXTURES,
} from "./ai-tiles";
import { SS_FACTOR } from "./world";
import * as loadingOverlay from "./loading-overlay";
import { setCharTextureProvider, setCharComponentProvider } from "./chargen";
import type { CharTextureProvider, CharComponentProvider } from "../../../shared/char-draw";
import "./furniture-alley"; // alley furniture drawing functions (registered in scene.ts)
import "./furniture-hawaii"; // hawaii furniture drawing functions (registered in scene.ts)
import "./furniture-south"; // old south furniture drawing functions (registered in scene.ts)
import { ALLEY_CREATURES, ALLEY_FRIENDLIES, ALLEY_BEASTS } from "./creatures-alley";
import { HAWAII_CREATURES, HAWAII_FRIENDLIES, HAWAII_BEASTS } from "./creatures-hawaii";
import { SOUTH_CREATURES, SOUTH_FRIENDLIES, SOUTH_BEASTS } from "./creatures-south";

// Register per-world creature designs so textures are generated for each theme
registerThemeCreatures("erics-alley", ALLEY_CREATURES, ALLEY_FRIENDLIES, ALLEY_BEASTS);
registerThemeCreatures("hawaii", HAWAII_CREATURES, HAWAII_FRIENDLIES, HAWAII_BEASTS);
registerThemeCreatures("old-south", SOUTH_CREATURES, SOUTH_FRIENDLIES, SOUTH_BEASTS);

/**
 * Boot scene — shows a loading bar while assets load, then generates all
 * procedural textures and animations before starting the main OfficeScene.
 * Texture generation is spread across frames so the progress bar moves
 * visibly as each category is generated.
 */
export class BootScene extends Phaser.Scene {

  constructor() {
    super("boot");
  }

  preload(): void {
    const v = "?v=9x";
    this.load.tilemapTiledJSON("map-classic", `assets/maps/office.json${v}`);
    this.load.tilemapTiledJSON("map-agentHeights", `assets/maps/agentHeights.json${v}`);
    this.load.image("tiles-classic", `assets/tilesets/office.png${v}`);
    this.load.image("tiles-agentHeights", `assets/tilesets/agentHeights.png${v}`);
    for (let i = 0; i < CHAR_VARIANTS; i++) {
      this.load.spritesheet(`char-${i}`, `assets/characters/char-${i}.png${v}`, {
        frameWidth: CHAR_FRAME_W,
        frameHeight: CHAR_FRAME_H,
      });
    }
    this.load.spritesheet("char-office-manager", `assets/characters/char-office-manager.png${v}`, {
      frameWidth: CHAR_FRAME_W,
      frameHeight: CHAR_FRAME_H,
    });
    this.load.spritesheet("char-hermes", `assets/characters/char-hermes.png${v}`, {
      frameWidth: CHAR_FRAME_W,
      frameHeight: CHAR_FRAME_H,
    });
    this.load.spritesheet("bubble", "assets/sprites/bubble.png", {
      frameWidth: 64,
      frameHeight: 64,
    });
    this.load.spritesheet("world-tiles", "assets/tilesets/world.png", {
      frameWidth: 64,
      frameHeight: 64,
    });

    // World theme tilemaps are lazy-loaded on demand when a user enters a world.
    // See loadWorldTilemap() and loadCreature3DAssets().

    // AI texture atlases — always loaded unconditionally.
    const atlasVer = "?v=277";
    this.load.image("ai-tiles-atlas", `assets/atlases/ai-tiles-atlas.webp${atlasVer}`);
    this.load.json("ai-tiles-atlas-meta", `assets/atlases/ai-tiles-atlas.json${atlasVer}`);
    this.load.image("ai-sprites-atlas", `assets/atlases/ai-sprites-atlas.webp${atlasVer}`);
    this.load.json("ai-sprites-atlas-meta", `assets/atlases/ai-sprites-atlas.json${atlasVer}`);
    this.load.image("ai-hair-atlas", `assets/atlases/ai-hair-atlas.webp${atlasVer}`);
    this.load.json("ai-hair-atlas-meta", `assets/atlases/ai-hair-atlas.json${atlasVer}`);
    this.load.image("ai-beard-atlas", `assets/atlases/ai-beard-atlas.webp${atlasVer}`);
    this.load.json("ai-beard-atlas-meta", `assets/atlases/ai-beard-atlas.json${atlasVer}`);
    this.load.image("ai-shirt-atlas", `assets/atlases/ai-shirt-atlas.webp${atlasVer}`);
    this.load.json("ai-shirt-atlas-meta", `assets/atlases/ai-shirt-atlas.json${atlasVer}`);
    this.load.image("ai-pants-atlas", `assets/atlases/ai-pants-atlas.webp${atlasVer}`);
    this.load.json("ai-pants-atlas-meta", `assets/atlases/ai-pants-atlas.json${atlasVer}`);
    this.load.image("ai-accessory-atlas", `assets/atlases/ai-accessory-atlas.webp${atlasVer}`);
    this.load.json("ai-accessory-atlas-meta", `assets/atlases/ai-accessory-atlas.json${atlasVer}`);
    this.load.image("ai-headFeature-atlas", `assets/atlases/ai-headFeature-atlas.webp${atlasVer}`);
    this.load.json("ai-headFeature-atlas-meta", `assets/atlases/ai-headFeature-atlas.json${atlasVer}`);

    // 3D creature spritesheets (6.4MB) are lazy-loaded on demand when
    // a user enters a world. See loadCreature3DAssets().

    this.load.on("progress", (value: number) => {
      loadingOverlay.setProgress(0.4 * value, "Loading assets…");
    });

    this.load.on("loaderror", (file: Phaser.Loader.File) => {
      if (file.key === "tiles-theme" || file.key === "map-theme") {
        console.warn(`[boot] ${file.key} not found — will use procedural fallback`);
        this.textures.remove(file.key);
        return;
      }
      console.warn("[Asset Load Error]", file.key, file.url);
    });

  }

  /** Creature 3D spritesheet keys that can be lazy-loaded. */
  static readonly CREATURE_3D_KEYS = [
    "creature-slime", "creature-wolf", "creature-skeleton", "creature-imp",
    "creature-wraith", "creature-fire-elemental",
    "beast-groveheart", "beast-stone-colossus", "beast-ash-wyrm",
    "beast-void-leviathan", "beast-infernal-sovereign",
    "friendly-unicorn", "friendly-fairy-bunny", "friendly-baby-dragon", "friendly-crystal-fox",
  ];

  /** Lazy-load 3D creature spritesheets. Returns a promise that resolves when all are loaded. */
  static loadCreature3DAssets(scene: Phaser.Scene): Promise<void> {
    const ver = "?v=3d5";
    const keys = BootScene.CREATURE_3D_KEYS;
    const missing = keys.filter((k) => !scene.textures.exists(k));
    if (missing.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let loaded = 0;
      const total = missing.length;
      for (const key of missing) {
        const file = key.replace(/-/g, "_");
        scene.load.spritesheet(key, `assets/ai/creatures3d/${file}.png${ver}`, {
          frameWidth: 128,
          frameHeight: 128,
        });
      }
      scene.load.on("loaderror", function onErr(file: Phaser.Loader.File) {
        if (file.key.startsWith("creature-") || file.key.startsWith("beast-") || file.key.startsWith("friendly-")) {
          console.warn(`[3D Sprite] ${file.key} not found — using procedural fallback`);
          scene.textures.remove(file.key);
          loaded++;
          if (loaded >= total) { scene.load.off("loaderror", onErr); resolve(); }
        }
      });
      scene.load.on("filecomplete", function onFile(fileKey: string) {
        if (missing.includes(fileKey)) {
          loaded++;
          if (loaded >= total) { scene.load.off("filecomplete", onFile); resolve(); }
        }
      });
      scene.load.start();
    });
  }

  /** Lazy-load a world theme tilemap. Returns a promise that resolves when loaded. */
  static loadWorldTilemap(scene: Phaser.Scene, themeId: string): Promise<void> {
    const key = `map-${themeId}`;
    if (scene.cache.json.exists(key)) return Promise.resolve();
    const v = "?v=9x";
    return new Promise((resolve, reject) => {
      scene.load.tilemapTiledJSON(key, `assets/maps/${themeId}.json${v}`);
      scene.load.once("loaderror", (file: Phaser.Loader.File) => {
        if (file.key === key) reject(new Error(`Failed to load tilemap ${themeId}`));
      });
      scene.load.once("filecomplete", (fileKey: string) => {
        if (fileKey === key) resolve();
      });
      scene.load.start();
    });
  }

  create(): void {

    // Only unpack AI atlases if they were loaded.
    if (this.textures.exists("ai-tiles-atlas")) {
      // Unpack tile + sprite atlases into individual Phaser textures.
      // Hair atlas is NOT unpacked — we extract ImageData directly from it
      // to avoid creating 360 GPU textures that are never rendered by Phaser.
      this.unpackAtlas("ai-tiles-atlas", "ai-tiles-atlas-meta");
      this.unpackAtlas("ai-sprites-atlas", "ai-sprites-atlas-meta");

      // Free atlas source textures after unpacking — saves ~128MB of GPU memory.
      // The individual sub-textures are already extracted; the atlas source is no longer needed.
      this.textures.remove("ai-tiles-atlas");
      this.textures.remove("ai-sprites-atlas");
    }

    // Pre-scale AI tile textures to the target SS size so renderChunk doesn't
    // create intermediate canvases per tile. At SS=4 (desktop), source is 256px
    // and target is 256px — no pre-scaling needed. At SS=1 (mobile), source is
    // 256px and target is 64px — pre-scale once here instead of 1024 times per chunk.
    if (SS_FACTOR < 4) {
      const targetPx = 64 * SS_FACTOR; // TILE_PX * SS
      const allTileKeys = new Set<string>();
      for (const keys of Object.values(AI_TILE_TEXTURES)) for (const k of keys) allTileKeys.add(k);
      for (const k of Object.values(AI_OBJECT_TEXTURES)) allTileKeys.add(k);
      for (const texKey of allTileKeys) {
        if (!this.textures.exists(texKey)) continue;
        const tex = this.textures.get(texKey);
        const src = tex.getSourceImage() as HTMLImageElement;
        if (src.width <= targetPx) continue; // already small enough
        const scaledKey = `${texKey}-ss${SS_FACTOR}`;
        if (this.textures.exists(scaledKey)) continue;
        // Step-down scale through intermediate sizes for quality
        let curW = src.width;
        let curH = src.height;
        let curCanvas: HTMLCanvasElement | undefined;
        while (curW > targetPx * 2 || curH > targetPx * 2) {
          const nextW = Math.max(targetPx, Math.floor(curW / 2));
          const nextH = Math.max(targetPx, Math.floor(curH / 2));
          const next = document.createElement("canvas");
          next.width = nextW;
          next.height = nextH;
          const nctx = next.getContext("2d")!;
          nctx.imageSmoothingEnabled = true;
          nctx.imageSmoothingQuality = "high";
          if (curCanvas) {
            nctx.drawImage(curCanvas, 0, 0, curW, curH, 0, 0, nextW, nextH);
          } else {
            nctx.drawImage(src, 0, 0, curW, curH, 0, 0, nextW, nextH);
          }
          curCanvas = next;
          curW = nextW;
          curH = nextH;
        }
        // Final scale to targetPx
        const final = document.createElement("canvas");
        final.width = targetPx;
        final.height = targetPx;
        const fctx = final.getContext("2d")!;
        fctx.imageSmoothingEnabled = true;
        fctx.imageSmoothingQuality = "high";
        if (curCanvas) {
          fctx.drawImage(curCanvas, 0, 0, curW, curH, 0, 0, targetPx, targetPx);
        } else {
          fctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, targetPx, targetPx);
        }
        this.textures.addImage(scaledKey, final as unknown as HTMLImageElement);
      }
    }

    // Extract ImageData from loaded AI char texture patches for character generation
    const provider: CharTextureProvider = {};
    for (const [field, texKey] of Object.entries(AI_CHAR_TEXTURES)) {
      if (this.textures.exists(texKey)) {
        const tex = this.textures.get(texKey);
        const src = tex.getSourceImage() as HTMLImageElement;
        const canvas = document.createElement("canvas");
        canvas.width = src.width;
        canvas.height = src.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(src, 0, 0);
        provider[field as keyof CharTextureProvider] = ctx.getImageData(0, 0, src.width, src.height);
      }
    }
    if (Object.keys(provider).length > 0) {
      setCharTextureProvider(provider);
    }

    // Extract ImageData from AI component atlases directly — no individual Phaser textures needed.
    // This avoids creating hundreds of GPU textures just to read pixel data once.
    const compProvider: CharComponentProvider = { hair: {}, beard: {}, shirt: {}, pants: {}, accessory: {}, headFeature: {} };

    // Helper: extract all frames for a component type from its atlas
    const extractComponentAtlas = (
      atlasKey: string,
      metaKey: string,
      styles: readonly string[],
      frameKeyFn: (style: string, dir: string, pose: number) => string,
      target: Record<string, ImageData[]>,
    ): void => {
      const meta = this.cache.json.get(metaKey) as
        | { frames: Record<string, { x: number; y: number; w: number; h: number }> }
        | undefined;
      if (!this.textures.exists(atlasKey) || !meta?.frames) return;
      const atlasImg = this.textures.get(atlasKey).getSourceImage() as CanvasImageSource;
      for (const style of styles) {
        const frames: ImageData[] = [];
        let allLoaded = true;
        for (const dir of AI_HAIR_DIRS) {
          for (let pose = 0; pose < AI_HAIR_POSES; pose++) {
            const key = frameKeyFn(style, dir, pose);
            const frame = meta.frames[key];
            if (!frame) { allLoaded = false; break; }
            const canvas = document.createElement("canvas");
            canvas.width = frame.w;
            canvas.height = frame.h;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(atlasImg, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
            frames.push(ctx.getImageData(0, 0, frame.w, frame.h));
          }
          if (!allLoaded) break;
        }
        if (allLoaded && frames.length === AI_HAIR_DIRS.length * AI_HAIR_POSES) {
          target[style] = frames;
        }
      }
      // Free the atlas source texture — ImageData is already extracted.
      this.textures.remove(atlasKey);
    };

    extractComponentAtlas("ai-hair-atlas", "ai-hair-atlas-meta", AI_HAIR_STYLES, hairFrameKey, compProvider.hair!);
    extractComponentAtlas("ai-shirt-atlas", "ai-shirt-atlas-meta", AI_SHIRT_STYLES, shirtFrameKey, compProvider.shirt!);
    extractComponentAtlas("ai-pants-atlas", "ai-pants-atlas-meta", AI_PANTS_STYLES, pantsFrameKey, compProvider.pants!);

    // Defer non-critical component extraction (beard, accessory, headFeature)
    // to after the game starts — these are rarely needed immediately and
    // each extractComponentAtlas call does many canvas + getImageData operations.
    const deferredProvider: CharComponentProvider = { beard: {}, accessory: {}, headFeature: {} };
    const deferredExtract = () => {
      extractComponentAtlas("ai-beard-atlas", "ai-beard-atlas-meta", AI_BEARD_STYLES, beardFrameKey, deferredProvider.beard!);
      extractComponentAtlas("ai-accessory-atlas", "ai-accessory-atlas-meta", AI_ACCESSORY_STYLES, accessoryFrameKey, deferredProvider.accessory!);
      extractComponentAtlas("ai-headFeature-atlas", "ai-headFeature-atlas-meta", AI_HEAD_FEATURE_STYLES, headFeatureFrameKey, deferredProvider.headFeature!);
      // Merge into the main provider
      const merged = { ...compProvider, ...deferredProvider } as CharComponentProvider;
      setCharComponentProvider(merged);
    };
    // Run after the game has started — atlas sources persist in the global
    // TextureManager so extraction works even after BootScene shuts down.
    setTimeout(deferredExtract, 2000);

    const hasAny =
      (compProvider.hair && Object.keys(compProvider.hair).length > 0) ||
      (compProvider.beard && Object.keys(compProvider.beard).length > 0) ||
      (compProvider.shirt && Object.keys(compProvider.shirt).length > 0) ||
      (compProvider.pants && Object.keys(compProvider.pants).length > 0) ||
      (compProvider.accessory && Object.keys(compProvider.accessory).length > 0) ||
      (compProvider.headFeature && Object.keys(compProvider.headFeature).length > 0);
    if (hasAny) {
      setCharComponentProvider(compProvider);
    }

    // Try loading procedural textures from IndexedDB cache first.
    // On cache hit, skip the 2–5s texture generation step entirely.
    loadingOverlay.setSegment(0.4, 0.7);
    void loadTexturesFromCache(this.textures).then((cacheHit) => {
      if (cacheHit) {
        console.log(`[boot] textures loaded from IndexedDB cache at ${performance.now().toFixed(0)}ms`);
        // Still need to create animations (they reference texture frames)
        this.createAnimations();
        loadingOverlay.updateProgress(1, "Ready!");
        // Save is not needed — cache is already valid. Schedule deferred steps.
        setTimeout(() => {
          const deferred = getDeferredTextureSteps(this);
          for (const step of deferred) {
            try { step.fn(); } catch (err) { console.warn(`[boot] deferred texture step "${step.name}" failed:`, err); }
          }
          // Create animations that depend on deferred textures (e.g. fountain-anim).
          this.createDeferredAnimations();
          console.log(`[boot] deferred texture steps done at ${performance.now().toFixed(0)}ms`);
        }, 3000);
        startOfficeFromBoot();
        return;
      }

      // Cache miss — generate textures as normal.
      generateTexturesAndStart();
    });

    // --- Helper: start the office scene (shared by cache hit and miss paths) ---
    const startOfficeFromBoot = () => {
      const store = this.game.registry.get("store") as Store | undefined;
      let officeStarted = false;
      let connectTimer: ReturnType<typeof setInterval> | null = null;

      const startOffice = () => {
        if (officeStarted) return;
        if (this.scene.isActive("office")) return;
        officeStarted = true;
        if (connectTimer) { clearInterval(connectTimer); connectTimer = null; }
        console.log(`[boot] starting OfficeScene at ${performance.now().toFixed(0)}ms`);
        this.scene.start("office");
      };

      // Start the animated bar immediately — covers the auth resolution gap
      // AND the WebSocket connection gap in one continuous animation.
      loadingOverlay.setSegment(0.7, 0.85);
      let connectPhase = 0;
      const labels = [
        "Connecting to server…",
        "Authenticating…",
        "Loading office data…",
        "Almost ready…",
      ];
      connectTimer = setInterval(() => {
        connectPhase = Math.min(connectPhase + 0.04, 0.95);
        const labelIdx = Math.min(Math.floor(connectPhase * labels.length), labels.length - 1);
        loadingOverlay.updateProgress(connectPhase, labels[labelIdx]);
      }, 200);

      // If initialDataReady is already true (fast reconnect), start immediately.
      if (store?.initialDataReady) {
        loadingOverlay.updateProgress(1, "Starting office…");
        startOffice();
        return;
      }

      // Register for initial data callback
      store?.onInitialData(() => {
        loadingOverlay.updateProgress(1, "Starting office…");
        startOffice();
      });

      // Also listen for auth state changes to handle edge cases
      if (isAuthEnabled) {
        onAuthChange((state: AuthState) => {
          if (state.loading) return;
          console.log(`[boot] auth state: session=${!!state.session} initialDataReady=${store?.initialDataReady} at ${performance.now().toFixed(0)}ms`);
          if (!state.session) {
            // No session — show login overlay, stop waiting
            if (connectTimer) { clearInterval(connectTimer); connectTimer = null; }
          }
        });
      }

      // Safety timeout — start office after 15s regardless
      setTimeout(() => startOffice(), 15000);
    };

    // --- Helper: generate textures from scratch, save to cache, then start office ---
    const generateTexturesAndStart = () => {
      // Get essential texture generation steps + animation step.
      // Deferred steps (Tennis, World objects, Emote icons) run after the game starts.
      const texSteps = getEssentialTextureSteps(this);
      const totalSteps = texSteps.length + 1; // +1 for animations

      // Process steps in batches so the bar visibly progresses.
      // Heavy steps (Creatures, Beasts, Friendly) run individually;
      // light steps (Effects, Glows, Items, Interior walls) batch into one frame.
      const heavyNames = new Set(["Creatures", "Beasts", "Friendly creatures"]);
      const heavySteps = texSteps.filter((s) => heavyNames.has(s.name));
      const lightSteps = texSteps.filter((s) => !heavyNames.has(s.name));
      const allSteps: Array<{ name: string; fn: () => void }> = [
        ...heavySteps,
        { name: "Effects & items", fn: () => { for (const s of lightSteps) s.fn(); } },
        { name: "Animations", fn: () => this.createAnimations() },
      ];
      let stepIndex = 0;

      const processNextStep = () => {
        if (stepIndex >= allSteps.length) {
          loadingOverlay.updateProgress(1, "Ready!");
          console.log(`[boot] texture steps done at ${performance.now().toFixed(0)}ms`);

          // Save generated textures to IndexedDB cache for next visit.
          void saveTexturesToCache(this.textures);

          // Schedule deferred texture steps (Tennis, World objects, Emote icons)
          // to run after the game starts — these aren't needed for the initial office view.
          setTimeout(() => {
            const deferred = getDeferredTextureSteps(this);
            for (const step of deferred) {
              try { step.fn(); } catch (err) { console.warn(`[boot] deferred texture step "${step.name}" failed:`, err); }
            }
            // Create animations that depend on deferred textures (e.g. fountain-anim).
            this.createDeferredAnimations();
            console.log(`[boot] deferred texture steps done at ${performance.now().toFixed(0)}ms`);
          }, 3000);

          startOfficeFromBoot();
          return;
        }

        // Run up to 2 steps per frame to reduce frame-gap overhead.
        const batchSize = stepIndex < heavySteps.length ? 2 : 1;
        const step = allSteps[stepIndex];
        const progress = stepIndex / totalSteps;
        loadingOverlay.updateProgress(progress, `Generating ${step.name}…`);

        // Run the step on the next frame so the bar update renders first
        this.time.delayedCall(0, () => {
          for (let b = 0; b < batchSize && stepIndex < allSteps.length; b++) {
            const s = allSteps[stepIndex];
            s.fn();
            stepIndex++;
          }
          // Update bar to show this batch completed
          loadingOverlay.updateProgress(stepIndex / totalSteps, `Done: ${allSteps[stepIndex - 1].name}`);
          // Schedule next step on the following frame
          this.time.delayedCall(0, processNextStep);
        });
      };

      // Start processing on the next frame so "Generating…" text renders first
      this.time.delayedCall(0, processNextStep);
    };
  }

  /** Unpack a texture atlas into individual Phaser image textures.
   *  Uses addImage for power-of-two textures (enables WebGL mipmaps for
   *  sharp detail at 4:1 minification). Uses createCanvas for NPOT textures
   *  (e.g. 64×96 character pieces) to avoid GL_INVALID_OPERATION mipmap errors. */
  private unpackAtlas(atlasKey: string, metaKey: string): void {
    if (!this.textures.exists(atlasKey)) return;
    const meta = this.cache.json.get(metaKey) as
      | { frames: Record<string, { x: number; y: number; w: number; h: number }> }
      | undefined;
    if (!meta?.frames) return;
    const atlasImage = this.textures.get(atlasKey).getSourceImage() as CanvasImageSource;
    for (const [texKey, frame] of Object.entries(meta.frames)) {
      if (this.textures.exists(texKey)) continue;
      const off = document.createElement("canvas");
      off.width = frame.w;
      off.height = frame.h;
      const ctx = off.getContext("2d")!;
      ctx.drawImage(atlasImage, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
      const isPOT = (frame.w & (frame.w - 1)) === 0 && (frame.h & (frame.h - 1)) === 0;
      if (isPOT) {
        this.textures.addImage(texKey, off as unknown as HTMLImageElement);
      } else {
        const ct = this.textures.createCanvas(texKey, frame.w, frame.h);
        if (ct) {
          const cctx = ct.getContext();
          cctx.drawImage(off, 0, 0);
          ct.refresh();
        }
      }
    }
  }

  private createAnimations(): void {
    // --- creature animations ---
    const creatureNames = ["slime", "wolf", "skeleton", "imp", "wraith", "fire-elemental"];
    for (const name of creatureNames) {
      const key = `creature-${name}`;
      if (this.anims.exists(`${key}-idle`)) continue;
      this.anims.create({
        key: `${key}-idle`,
        frames: this.anims.generateFrameNumbers(key, { frames: [0, 1, 0, 2] }),
        frameRate: 3,
        repeat: -1,
      });
      this.anims.create({
        key: `${key}-walk`,
        frames: this.anims.generateFrameNumbers(key, { frames: [1, 2, 1, 2] }),
        frameRate: 8,
        repeat: -1,
      });
      this.anims.create({
        key: `${key}-attack`,
        frames: this.anims.generateFrameNumbers(key, { frames: [3, 0] }),
        frameRate: 6,
        repeat: 0,
      });
    }

    // --- beast animations ---
    const beastNames = ["groveheart", "stone-colossus", "ash-wyrm", "void-leviathan", "infernal-sovereign"];
    for (const name of beastNames) {
      const key = `beast-${name}`;
      if (this.anims.exists(`${key}-idle`)) continue;
      this.anims.create({
        key: `${key}-idle`,
        frames: this.anims.generateFrameNumbers(key, { frames: [0, 1, 0, 2] }),
        frameRate: 2,
        repeat: -1,
      });
      this.anims.create({
        key: `${key}-move`,
        frames: this.anims.generateFrameNumbers(key, { frames: [1, 2, 1, 2] }),
        frameRate: 5,
        repeat: -1,
      });
      this.anims.create({
        key: `${key}-attack`,
        frames: this.anims.generateFrameNumbers(key, { frames: [3, 0] }),
        frameRate: 4,
        repeat: 0,
      });
    }

    // --- friendly creature animations ---
    const friendlyNames = ["unicorn", "fairy-bunny", "baby-dragon", "crystal-fox"];
    for (const name of friendlyNames) {
      const key = `friendly-${name}`;
      if (this.anims.exists(`${key}-idle`)) continue;
      this.anims.create({
        key: `${key}-idle`,
        frames: this.anims.generateFrameNumbers(key, { frames: [0, 1, 0, 2] }),
        frameRate: 3,
        repeat: -1,
      });
      this.anims.create({
        key: `${key}-walk`,
        frames: this.anims.generateFrameNumbers(key, { frames: [1, 2, 1, 2] }),
        frameRate: 6,
        repeat: -1,
      });
      this.anims.create({
        key: `${key}-hop`,
        frames: this.anims.generateFrameNumbers(key, { frames: [3, 1, 0] }),
        frameRate: 5,
        repeat: 0,
      });
    }

    // --- character sheet animations ---
    const sheets = [...Array.from({ length: CHAR_VARIANTS }, (_, i) => `char-${i}`), "char-office-manager", "char-hermes"];
    const dirs: Dir[] = ["down", "left", "right", "up"];
    for (const key of sheets) {
      if (this.anims.exists(`${key}-work`)) continue;
      dirs.forEach((dir, row) => {
        const base = row * CHAR_FRAMES_PER_ROW;
        this.anims.create({
          key: `${key}-walk-${dir}`,
          frames: this.anims.generateFrameNumbers(key, {
            frames: [base, base + 1, base + 2, base + 3, base + 4, base + 5],
          }),
          frameRate: 10,
          repeat: -1,
        });
        const breathFrames = Array(24).fill(base + 6);
        breathFrames.push(base + 7);
        breathFrames.push(base + 6);
        this.anims.create({
          key: `${key}-idle-${dir}`,
          frames: this.anims.generateFrameNumbers(key, {
            frames: breathFrames,
          }),
          frameRate: 10,
          repeat: -1,
          repeatDelay: Math.random() * 2,
        });
      });
      this.anims.create({
        key: `${key}-work`,
        frames: this.anims.generateFrameNumbers(key, { frames: [6, 7] }),
        frameRate: 2.5,
        repeat: -1,
      });
    }

    // --- water animation ---
    if (!this.anims.exists("water-anim")) {
      this.anims.create({
        key: "water-anim",
        frames: this.anims.generateFrameNumbers("world-tiles", { frames: [21, 22, 23] }),
        frameRate: 4,
        repeat: -1,
      });
    }

    // --- fountain animation ---
    // Created in createDeferredAnimations() after fountain-sheet is generated.
  }

  /** Create animations that depend on deferred texture steps. */
  private createDeferredAnimations(): void {
    if (!this.anims.exists("fountain-anim") && this.textures.exists("fountain-sheet")) {
      this.anims.create({
        key: "fountain-anim",
        frames: this.anims.generateFrameNumbers("fountain-sheet", { frames: [0, 1, 2, 3] }),
        frameRate: 6,
        repeat: -1,
      });
    }
  }
}
