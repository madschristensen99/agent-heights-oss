/**
 * Full-screen / large modal overlay for viewing presenter video streams
 * and projector iframe content at a larger size.
 *
 * For video: re-parents the existing <video> element (stream stays attached,
 * no reconnection). On close, moves it back to its original wrap div.
 *
 * For iframes: creates a new iframe with adjusted params (e.g., YouTube
 * controls enabled) since re-parenting iframes reloads their content.
 */

export interface PresenterTab {
  key: string;
  name: string;
  type: "screen" | "webcam";
  video: HTMLVideoElement;
  wrap: HTMLDivElement;
}

export class ExpandedView {
  private backdrop: HTMLDivElement | null = null;
  private container: HTMLDivElement | null = null;
  private contentArea: HTMLDivElement | null = null;
  private titleBar: HTMLDivElement | null = null;
  private tabBar: HTMLDivElement | null = null;

  /** Currently displayed mode */
  private mode: "video" | "iframe" | null = null;

  /** Video mode: the original wrap div to return the video to */
  private originalWrap: HTMLDivElement | null = null;
  /** Video mode: the video element currently in the modal */
  private currentVideo: HTMLVideoElement | null = null;
  /** Video mode: all available presenter tabs */
  private tabs: PresenterTab[] = [];
  /** Video mode: active tab key */
  private activeTabKey: string | null = null;

  /** Iframe mode: the iframe currently in the modal */
  private modalIframe: HTMLIFrameElement | null = null;
  /** Iframe mode: the original projector iframe to un-hide on close */
  private originalIframe: HTMLIFrameElement | null = null;

  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  /** Called when the expanded view is closed (for scene to refresh overlays). */
  onClose: (() => void) | null = null;

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  get expandedTabKey(): string | null {
    return this.mode === "video" ? this.activeTabKey : null;
  }

  /**
   * Show a presenter video stream in the expanded modal.
   * Re-parents the video element from its projector wrap into the modal.
   */
  showVideo(tabs: PresenterTab[], activeKey: string): void {
    if (tabs.length === 0) return;
    this.close(); // close any existing view first

    this.mode = "video";
    this.tabs = tabs;
    this.activeTabKey = activeKey;

    this.buildShell();

    // Title bar
    this.updateTitle();

    // Tab bar (only if multiple presenters)
    if (tabs.length > 1) {
      this.buildTabBar();
    }

    // Content area
    this.contentArea = document.createElement("div");
    this.contentArea.className = "ev-content";
    this.container!.appendChild(this.contentArea);

    this.switchToTab(activeKey);

    // Controls
    this.buildVideoControls();

    this.attachKeyHandler();
  }

  /**
   * Show iframe content in the expanded modal.
   * Creates a new iframe — does not re-parent the original.
   */
  showIframe(
    url: string,
    title: string,
    options: {
      isYouTube?: boolean;
      sandbox?: string;
      allow?: string;
      originalIframe?: HTMLIFrameElement | null;
    } = {},
  ): void {
    this.close();

    this.mode = "iframe";
    this.originalIframe = options.originalIframe ?? null;

    // Hide the original projector iframe while expanded
    if (this.originalIframe) {
      this.originalIframe.style.display = "none";
    }

    this.buildShell();

    // Title
    if (this.titleBar) {
      const titleEl = this.titleBar.querySelector(".ev-title") as HTMLSpanElement;
      if (titleEl) titleEl.textContent = title;
    }

    // Content area with iframe
    this.contentArea = document.createElement("div");
    this.contentArea.className = "ev-content";
    this.container!.appendChild(this.contentArea);

    this.modalIframe = document.createElement("iframe");
    this.modalIframe.style.cssText =
      "width:100%;height:100%;border:none;display:block;border-radius:0 0 8px 8px;";
    this.modalIframe.setAttribute("frameborder", "0");
    this.modalIframe.allow = options.allow ?? "autoplay; encrypted-media; fullscreen";
    if (options.sandbox) {
      this.modalIframe.setAttribute("sandbox", options.sandbox);
    }

    // For YouTube, enable controls
    let finalUrl = url;
    if (options.isYouTube && url.includes("youtube.com/embed/")) {
      // Replace control-disabling params with viewer-friendly ones
      finalUrl = url
        .replace("controls=0", "controls=1")
        .replace("modestbranding=1", "modestbranding=1")
        .replace("showinfo=0", "showinfo=0")
        .replace("iv_load_policy=3", "iv_load_policy=1");
      // Add rel=1 for related videos, keep autoplay
      if (!finalUrl.includes("rel=")) finalUrl += "&rel=1";
    }

    this.modalIframe.src = finalUrl;
    this.contentArea.appendChild(this.modalIframe);

    // Controls
    this.buildIframeControls(url);

    this.attachKeyHandler();
  }

  /** Switch the active video tab in the modal. */
  switchToTab(key: string): void {
    if (this.mode !== "video") return;
    const tab = this.tabs.find(t => t.key === key);
    if (!tab || !this.contentArea) return;

    // Return previous video to its wrap
    if (this.currentVideo && this.originalWrap) {
      this.originalWrap.appendChild(this.currentVideo);
      this.currentVideo.style.position = "absolute";
    }

    // Move new video into modal
    this.activeTabKey = key;
    this.currentVideo = tab.video;
    this.originalWrap = tab.wrap;

    // Hide the original wrap (video is now in modal)
    tab.wrap.style.display = "none";

    // Style video for modal
    tab.video.style.position = "static";
    tab.video.style.width = "100%";
    tab.video.style.height = "100%";
    tab.video.style.objectFit = tab.type === "screen" ? "contain" : "cover";
    tab.video.style.outline = "none";

    // Clear content area and add video
    this.contentArea.innerHTML = "";
    this.contentArea.appendChild(tab.video);

    // Update tab bar active states
    this.updateTabBar();
    this.updateTitle();
  }

  /** Close the expanded view and restore elements. */
  close(): void {
    if (this.mode === "video" && this.currentVideo && this.originalWrap) {
      // Return video to its original wrap
      this.currentVideo.style.position = "absolute";
      this.currentVideo.style.top = "0";
      this.currentVideo.style.left = "0";
      this.currentVideo.style.width = "100%";
      this.currentVideo.style.height = "100%";
      this.originalWrap.appendChild(this.currentVideo);
      this.originalWrap.style.display = "block";
    }

    if (this.mode === "iframe" && this.originalIframe) {
      // Restore the original projector iframe
      this.originalIframe.style.display = "block";
    }

    this.mode = null;
    this.currentVideo = null;
    this.originalWrap = null;
    this.tabs = [];
    this.activeTabKey = null;
    this.modalIframe = null;
    this.originalIframe = null;

    this.detachKeyHandler();

    this.onClose?.();
    this.onClose = null;

    if (this.backdrop) {
      this.backdrop.remove();
      this.backdrop = null;
    }
    this.container = null;
    this.contentArea = null;
    this.titleBar = null;
    this.tabBar = null;
  }

  destroy(): void {
    this.close();
  }

  // ── Private builders ──

  private buildShell(): void {
    this.backdrop = document.createElement("div");
    this.backdrop.className = "ev-backdrop";

    this.container = document.createElement("div");
    this.container.className = "ev-container";

    // Title bar
    this.titleBar = document.createElement("div");
    this.titleBar.className = "ev-title-bar";

    const titleEl = document.createElement("span");
    titleEl.className = "ev-title";
    titleEl.textContent = "";

    const spacer = document.createElement("div");
    spacer.style.flex = "1";

    const closeBtn = document.createElement("button");
    closeBtn.className = "ev-btn ev-close-btn";
    closeBtn.textContent = "✕";
    closeBtn.title = "Close (Esc)";
    closeBtn.onclick = () => this.close();

    this.titleBar.appendChild(titleEl);
    this.titleBar.appendChild(spacer);
    this.titleBar.appendChild(closeBtn);

    this.container.appendChild(this.titleBar);
    this.backdrop.appendChild(this.container);
    document.body.appendChild(this.backdrop);

    // Click backdrop to close
    this.backdrop.onclick = (e) => {
      if (e.target === this.backdrop) this.close();
    };
  }

  private updateTitle(): void {
    if (!this.titleBar) return;
    const titleEl = this.titleBar.querySelector(".ev-title") as HTMLSpanElement;
    if (!titleEl) return;

    if (this.mode === "video") {
      const tab = this.tabs.find(t => t.key === this.activeTabKey);
      if (tab) {
        const icon = tab.type === "screen" ? "🖥" : "📷";
        titleEl.textContent = `${icon} ${tab.name}`;
      }
    }
  }

  private buildTabBar(): void {
    if (!this.container || this.tabs.length <= 1) return;

    this.tabBar = document.createElement("div");
    this.tabBar.className = "ev-tab-bar";

    for (const tab of this.tabs) {
      const btn = document.createElement("button");
      btn.className = "ev-tab-btn";
      btn.dataset.key = tab.key;
      const icon = tab.type === "screen" ? "🖥" : "📷";
      btn.textContent = `${icon} ${tab.name}`;
      btn.onclick = () => this.switchToTab(tab.key);
      this.tabBar!.appendChild(btn);
    }

    this.container.appendChild(this.tabBar);
    this.updateTabBar();
  }

  private updateTabBar(): void {
    if (!this.tabBar) return;
    this.tabBar.querySelectorAll<HTMLButtonElement>(".ev-tab-btn").forEach(btn => {
      const isActive = btn.dataset.key === this.activeTabKey;
      btn.classList.toggle("active", isActive);
    });
  }

  private buildVideoControls(): void {
    if (!this.container) return;
    const controls = document.createElement("div");
    controls.className = "ev-controls";

    // Mute toggle
    const muteBtn = document.createElement("button");
    muteBtn.className = "ev-btn";
    muteBtn.textContent = "🔊";
    muteBtn.title = "Mute / Unmute";
    muteBtn.onclick = () => {
      if (this.currentVideo) {
        this.currentVideo.muted = !this.currentVideo.muted;
        muteBtn.textContent = this.currentVideo.muted ? "🔇" : "🔊";
      }
    };
    controls.appendChild(muteBtn);

    // Fullscreen toggle
    const fsBtn = document.createElement("button");
    fsBtn.className = "ev-btn";
    fsBtn.textContent = "⛶";
    fsBtn.title = "Fullscreen (F)";
    fsBtn.onclick = () => this.toggleFullscreen();
    controls.appendChild(fsBtn);

    this.container.appendChild(controls);
  }

  private buildIframeControls(originalUrl: string): void {
    if (!this.container) return;
    const controls = document.createElement("div");
    controls.className = "ev-controls";

    // Open in new tab
    const openBtn = document.createElement("button");
    openBtn.className = "ev-btn";
    openBtn.textContent = "↗ Open in new tab";
    openBtn.title = "Open original URL in a new tab";
    openBtn.onclick = () => {
      // For YouTube embed URLs, convert to watch URL
      let watchUrl = originalUrl;
      const embedMatch = originalUrl.match(/youtube\.com\/embed\/([\w-]+)/);
      if (embedMatch) {
        watchUrl = `https://www.youtube.com/watch?v=${embedMatch[1]}`;
      }
      window.open(watchUrl, "_blank", "noopener,noreferrer");
    };
    controls.appendChild(openBtn);

    // Fullscreen
    const fsBtn = document.createElement("button");
    fsBtn.className = "ev-btn";
    fsBtn.textContent = "⛶";
    fsBtn.title = "Fullscreen (F)";
    fsBtn.onclick = () => this.toggleFullscreen();
    controls.appendChild(fsBtn);

    this.container.appendChild(controls);
  }

  private toggleFullscreen(): void {
    if (!this.container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      this.container.requestFullscreen().catch(() => {});
    }
  }

  private attachKeyHandler(): void {
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        this.toggleFullscreen();
      }
    };
    window.addEventListener("keydown", this.keyHandler);
  }

  private detachKeyHandler(): void {
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
  }
}
