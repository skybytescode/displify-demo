import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { IframeMessage, IframeHealthStatus, LayoutState } from '../models/iframe-message.model';

/**
 * Heartbeat health record for a single iframe.
 */
interface IframeHealthRecord {
  /** Current health status. */
  status: IframeHealthStatus;
  /** Number of consecutive missed PINGs (no PONG received). */
  missedPings: number;
  /** Timestamp of the last PONG received. */
  lastPong: number;
}

/**
 * Message Broker Service
 *
 * Central hub for all iframe ↔ shell communication.
 *  1. Holds references to registered iframe elements.
 *  2. Listens to `window.message`, validates origin, then ROUTES
 *     each message to the correct handler.
 *  3. Emits visual-bus events so the dashboard can animate data flow.
 *  4. Manages crash / recovery lifecycle with status tracking.
 *  5. Heartbeat system — PINGs each iframe every 5 s. If 2 consecutive
 *     PINGs go unanswered the iframe is marked offline and auto-recovered.
 */
@Injectable({ providedIn: 'root' })
export class PostMessageService implements OnDestroy {

  // ── Public reactive streams ───────────────────

  /** Raw stream – every validated message. */
  readonly messages$ = new Subject<IframeMessage>();

  /** Layout state managed by the broker (single source of truth). */
  readonly layoutChanged$ = new Subject<LayoutState>();

  /**
   * Visual Bus — emits the SOURCE iframe id whenever a message
   * is received, so the dashboard can flash the neon border.
   */
  readonly messagePulse$ = new Subject<{ from: string; to: string }>();

  /**
   * Crash / Recovery status.
   * Emits `{ id, status }` so the dashboard can drive the status dots.
   *   'healthy' = green · 'crashed' = red · 'recovering' = amber
   */
  readonly appStatus$ = new Subject<{ id: string; status: 'healthy' | 'crashed' | 'recovering' }>();

  /**
   * Heartbeat health status per iframe.
   * The key is the iframe id (e.g. 'KPI_APP'), the value is the health status.
   * Dashboard subscribes to this to render the System Health panel.
   */
  readonly iframeHealth$ = new BehaviorSubject<Map<string, IframeHealthRecord>>(new Map());

  // ── Iframe registry ───────────────────────────
  private iframeRegistry = new Map<string, HTMLIFrameElement>();

  /** Per-iframe heartbeat tracking. */
  private healthMap = new Map<string, IframeHealthRecord>();

  /** Interval handle for the heartbeat timer. */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  /** Heartbeat PING frequency in milliseconds. */
  private readonly PING_INTERVAL_MS = 5_000;

  /** Number of missed PONGs before marking an iframe as offline. */
  private readonly MAX_MISSED_PINGS = 4;

  private readonly allowedOrigins: string[] = [
    window.location.origin,
    'http://localhost:4200',
    'http://localhost:4201',
    'http://localhost:4202',
  ];

  private readonly messageHandler = this.onMessage.bind(this);

  constructor(private readonly zone: NgZone) {
    window.addEventListener('message', this.messageHandler);
    this.startHeartbeat();
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.messageHandler);
    this.stopHeartbeat();
    this.messages$.complete();
    this.layoutChanged$.complete();
    this.messagePulse$.complete();
    this.appStatus$.complete();
    this.iframeHealth$.complete();
    this.iframeRegistry.clear();
    this.healthMap.clear();
  }

  // ──────────────────────────────────────────────
  //  Iframe registration
  // ──────────────────────────────────────────────

  registerIframe(id: string, iframe: HTMLIFrameElement): void {
    this.iframeRegistry.set(id, iframe);

    // Initialise health record.
    this.healthMap.set(id, {
      status: 'online',
      missedPings: 0,
      lastPong: Date.now(),
    });

    this.emitHealth();
    this.appStatus$.next({ id, status: 'healthy' });
    console.log(`[Broker] Registered iframe: ${id}`);
  }

  unregisterIframe(id: string): void {
    this.iframeRegistry.delete(id);
    this.healthMap.delete(id);
    this.emitHealth();
  }

  // ──────────────────────────────────────────────
  //  Outbound: send a message INTO an iframe
  // ──────────────────────────────────────────────

  sendMessageTo(
    iframeId: string,
    message: IframeMessage,
    targetOrigin: string = '*',
  ): void {
    const iframe = this.iframeRegistry.get(iframeId);
    if (!iframe?.contentWindow) {
      console.warn(`[Broker] Cannot send – iframe "${iframeId}" not available.`);
      return;
    }
    iframe.contentWindow.postMessage(message, targetOrigin);
  }

  sendMessage(
    iframe: HTMLIFrameElement,
    message: IframeMessage,
    targetOrigin: string = '*',
  ): void {
    iframe.contentWindow?.postMessage(message, targetOrigin);
  }

  // ──────────────────────────────────────────────
  //  Fail Simulation: restart a micro-app
  // ──────────────────────────────────────────────

  restartApp(iframeId: string): void {
    const iframe = this.iframeRegistry.get(iframeId);
    if (!iframe) {
      console.warn(`[Broker] Cannot restart – iframe "${iframeId}" not registered.`);
      return;
    }

    console.log(`[Broker] Restarting micro-app: ${iframeId}`);

    // Mark as recovering — the (load) handler will flip back to healthy/online.
    this.appStatus$.next({ id: iframeId, status: 'recovering' });

    const record = this.healthMap.get(iframeId);
    if (record) {
      record.status = 'recovering';
      record.missedPings = 0;
      this.emitHealth();
    }

    // Force a full reload by re-setting the src attribute.
    // eslint-disable-next-line no-self-assign
    iframe.src = iframe.src;
  }

  // ──────────────────────────────────────────────
  //  Kill App — send KILL message to an iframe
  // ──────────────────────────────────────────────

  killApp(iframeId: string): void {
    console.warn(`[Broker] Sending KILL to ${iframeId}`);
    this.sendMessageTo(iframeId, {
      type: 'KILL',
      target: iframeId as IframeMessage['target'],
      payload: { reason: 'Manual kill via Shell' },
    });
  }

  // ──────────────────────────────────────────────
  //  Heartbeat System — PING / PONG
  // ──────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.zone.run(() => this.tick());
    }, this.PING_INTERVAL_MS);
    console.log(`[Broker] Heartbeat started (every ${this.PING_INTERVAL_MS / 1000}s)`);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Called every PING_INTERVAL_MS.
   *  1. For each registered iframe, increment missedPings.
   *  2. If missedPings >= MAX_MISSED_PINGS → mark offline + auto-recover.
   *  3. Send a PING to every registered iframe.
   */
  private tick(): void {
    this.healthMap.forEach((record, id) => {
      // Skip iframes already recovering – they're being reloaded.
      if (record.status === 'recovering') {
        return;
      }

      // Increment missed PINGs (a PONG will reset this to 0).
      record.missedPings++;

      if (record.missedPings >= this.MAX_MISSED_PINGS && record.status !== 'offline') {
        // Skip if the browser tab is hidden — throttled timers cause false positives.
        if (document.hidden) {
          record.missedPings = 0;
          return;
        }

        // ── Iframe is unresponsive ──
        record.status = 'offline';
        console.error(`[Broker] 💀 ${id} missed ${record.missedPings} PINGs — marking OFFLINE`);

        this.appStatus$.next({ id, status: 'crashed' });

        // Auto-recover after a short delay.
        setTimeout(() => this.recoverIframe(id), 1_500);
      }

      this.emitHealth();
    });

    // Send PING to every registered iframe.
    this.iframeRegistry.forEach((iframe, id) => {
      const record = this.healthMap.get(id);
      if (record && record.status !== 'recovering') {
        this.sendMessageTo(id, {
          type: 'PING',
          target: id as IframeMessage['target'],
          payload: { ts: Date.now() },
        });
      }
    });
  }

  /**
   * Auto-recovery: reload a dead iframe.
   */
  private recoverIframe(id: string): void {
    const record = this.healthMap.get(id);
    if (!record || record.status === 'online') {
      return; // already came back to life
    }

    console.log(`[Broker] 🔄 Auto-recovering ${id}…`);
    this.restartApp(id);
  }

  /**
   * Handle an incoming PONG from an iframe.
   */
  private handlePong(iframeId: string): void {
    const record = this.healthMap.get(iframeId);
    if (!record) return;

    record.missedPings = 0;
    record.lastPong = Date.now();

    if (record.status === 'offline' || record.status === 'recovering') {
      record.status = 'online';
      this.appStatus$.next({ id: iframeId, status: 'healthy' });
    }

    this.emitHealth();
  }

  /** Push the latest health snapshot to subscribers. */
  private emitHealth(): void {
    this.iframeHealth$.next(new Map(this.healthMap));
  }

  // ──────────────────────────────────────────────
  //  Inbound: handle + ROUTE messages FROM iframes
  // ──────────────────────────────────────────────

  private onMessage(event: MessageEvent): void {
    if (!this.isOriginAllowed(event.origin)) {
      console.warn(`[Broker] Blocked message from untrusted origin: ${event.origin}`);
      return;
    }

    const data = event.data as IframeMessage;

    if (!data || typeof data.type !== 'string' || typeof data.target !== 'string') {
      return;
    }

    this.zone.run(() => {
      // Handle PONG silently (don't push to messages$ to avoid noise).
      if (data.type === 'PONG') {
        const senderId = this.identifySender(event.source as Window);
        if (senderId) {
          this.handlePong(senderId);
        }
        return;
      }

      this.messages$.next(data);

      if (data.target === 'SHELL') {
        this.routeShellMessage(data);
      }
    });
  }

  /**
   * Identify which registered iframe sent the message
   * by matching the event.source window.
   */
  private identifySender(sourceWindow: Window): string | null {
    for (const [id, iframe] of this.iframeRegistry.entries()) {
      if (iframe.contentWindow === sourceWindow) {
        return id;
      }
    }
    return null;
  }

  private routeShellMessage(msg: IframeMessage): void {
    switch (msg.type) {

      case 'KPI_SELECTED':
        // First click: highlight + forward data to AI, but stay in overview.
        this.messagePulse$.next({ from: 'KPI_APP', to: 'AI_APP' });
        console.log('[Broker] KPI_SELECTED → forwarding to AI (no layout change)', msg.payload);

        this.sendMessageTo('AI_APP', {
          type: 'KPI_SELECTED',
          target: 'AI_APP',
          payload: msg.payload,
        });
        break;

      case 'KPI_FOCUSED':
        // Second click on the same card: switch layout to focus.
        this.messagePulse$.next({ from: 'KPI_APP', to: 'AI_APP' });
        this.layoutChanged$.next('focus');
        console.log('[Broker] KPI_FOCUSED → layout → focus', msg.payload);

        this.sendMessageTo('AI_APP', {
          type: 'KPI_SELECTED',
          target: 'AI_APP',
          payload: msg.payload,
        });
        break;

      case 'CRASH_SIMULATION': {
        const crashedApp = (msg.payload as { app?: string })?.app;
        console.error(`[Broker] CRASH_SIMULATION from ${crashedApp}`, msg.payload);

        if (crashedApp) {
          // 1. Immediately mark as crashed (red dot).
          this.appStatus$.next({ id: crashedApp, status: 'crashed' });

          const record = this.healthMap.get(crashedApp);
          if (record) {
            record.status = 'offline';
            record.missedPings = this.MAX_MISSED_PINGS;
            this.emitHealth();
          }

          // 2. After 1s, begin recovery (reload iframe).
          setTimeout(() => this.restartApp(crashedApp), 1000);
        }
        break;
      }

      case 'DATA_UPDATE':
        console.log('[Broker] DATA_UPDATE from micro-app', msg.payload);
        break;

      default:
        console.warn('[Broker] Unrecognised message type:', msg);
    }
  }

  private isOriginAllowed(origin: string): boolean {
    return this.allowedOrigins.includes(origin);
  }
}
