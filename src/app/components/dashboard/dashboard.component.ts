import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Subscription } from 'rxjs';
import {
  trigger,
  state,
  style,
  transition,
  animate,
  group,
  query,
  animateChild,
} from '@angular/animations';

import { PostMessageService } from '../../services/post-message.service';
import { IframeHealthStatus, LayoutState } from '../../models/iframe-message.model';

// ─────────────────────────────────────────────
//  Animation definitions
// ─────────────────────────────────────────────

/**
 * Layout Morphing animation.
 * Uses a flex-based approach so the KPI panel expands while
 * the AI panel slides out to the right with a stagger feel.
 */
const layoutAnimation = trigger('layoutMorph', [
  state('overview', style({
    // KPI 70% | AI 30%  (expressed as flex on children via CSS)
  })),
  state('focus', style({
    // KPI 100% | AI 0%
  })),
  transition('overview => focus', [
    group([
      query('.kpi-panel', [
        animate('400ms ease-in-out', style({ flex: '1 1 100%' })),
      ], { optional: true }),
      query('.ai-panel', [
        animate('400ms 80ms ease-in-out', style({
          flex: '0 0 0%',
          opacity: 0,
          transform: 'translateX(60px)',
        })),
      ], { optional: true }),
    ]),
  ]),
  transition('focus => overview', [
    group([
      query('.kpi-panel', [
        animate('350ms ease-in-out', style({ flex: '1 1 70%' })),
      ], { optional: true }),
      query('.ai-panel', [
        style({ transform: 'translateX(60px)', opacity: 0 }),
        animate('350ms 60ms ease-out', style({
          flex: '1 1 30%',
          opacity: 1,
          transform: 'translateX(0)',
        })),
      ], { optional: true }),
    ]),
  ]),
]);

/**
 * Neon-pulse animation for the Visual Bus.
 * Applied to individual panels when data flows through them.
 */
const neonPulse = trigger('neonPulse', [
  state('idle', style({ boxShadow: '0 0 0 0 transparent' })),
  state('active', style({ boxShadow: '0 0 12px 2px rgba(99, 102, 241, 0.7)' })),
  transition('idle => active', animate('150ms ease-in')),
  transition('active => idle', animate('400ms ease-out')),
]);

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
  animations: [layoutAnimation, neonPulse],
})
export class DashboardComponent implements OnInit, OnDestroy {

  // ── Layout state ──────────────────────────────
  currentLayout: LayoutState = 'overview';

  // ── Sanitized iframe URLs ─────────────────────
  kpiAppUrl!: SafeResourceUrl;
  aiAppUrl!: SafeResourceUrl;

  // ── Iframe readiness flags ────────────────────
  kpiIframeReady = false;
  aiIframeReady = false;

  // ── Visual Bus — neon pulse states ────────────
  kpiPulse: 'idle' | 'active' = 'idle';
  aiPulse:  'idle' | 'active' = 'idle';

  // ── Crash Recovery — status dots ──────────────
  kpiStatus: 'healthy' | 'crashed' | 'recovering' = 'healthy';
  aiStatus:  'healthy' | 'crashed' | 'recovering' = 'healthy';

  // ── Heartbeat Health ──────────────────────────
  kpiHealth: IframeHealthStatus = 'online';
  aiHealth:  IframeHealthStatus = 'online';
  kpiMissedPings = 0;
  aiMissedPings  = 0;

  // ── Iframe element references ─────────────────
  @ViewChild('kpiIframe', { static: false }) kpiIframeRef!: ElementRef<HTMLIFrameElement>;
  @ViewChild('aiIframe', { static: false })  aiIframeRef!: ElementRef<HTMLIFrameElement>;

  private subscriptions: Subscription[] = [];

  constructor(
    private readonly sanitizer: DomSanitizer,
    private readonly postMessageService: PostMessageService,
    private readonly zone: NgZone,
  ) {}

  // ─────────────────────────────────────────────
  //  Lifecycle
  // ─────────────────────────────────────────────

  ngOnInit(): void {
    this.kpiAppUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
      'assets/kpi-app.html',
    );
    this.aiAppUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
      'assets/ai-app.html',
    );

    // Layout changes from the broker.
    this.subscriptions.push(
      this.postMessageService.layoutChanged$.subscribe((layout) => {
        this.zone.run(() => {
          this.currentLayout = layout;
        });
      }),
    );

    // Visual Bus — flash neon borders on data transfer.
    this.subscriptions.push(
      this.postMessageService.messagePulse$.subscribe(({ from, to }) => {
        this.zone.run(() => this.flashNeonPulse(from, to));
      }),
    );

    // Crash Recovery — status dot updates.
    this.subscriptions.push(
      this.postMessageService.appStatus$.subscribe(({ id, status }) => {
        this.zone.run(() => {
          if (id === 'KPI_APP') { this.kpiStatus = status; }
          if (id === 'AI_APP')  { this.aiStatus = status; }
        });
      }),
    );

    // Heartbeat — health status updates for System Health dashboard.
    this.subscriptions.push(
      this.postMessageService.iframeHealth$.subscribe((healthMap) => {
        this.zone.run(() => {
          const kpi = healthMap.get('KPI_APP');
          const ai  = healthMap.get('AI_APP');
          if (kpi) { this.kpiHealth = kpi.status; this.kpiMissedPings = kpi.missedPings; }
          if (ai)  { this.aiHealth  = ai.status;  this.aiMissedPings  = ai.missedPings; }
        });
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((s) => s.unsubscribe());
    this.postMessageService.unregisterIframe('KPI_APP');
    this.postMessageService.unregisterIframe('AI_APP');
  }

  // ─────────────────────────────────────────────
  //  Iframe onload handlers
  // ─────────────────────────────────────────────

  onKpiIframeLoad(): void {
    this.kpiIframeReady = true;
    this.kpiStatus = 'healthy';

    this.postMessageService.registerIframe(
      'KPI_APP',
      this.kpiIframeRef.nativeElement,
    );

    this.postMessageService.sendMessageTo('KPI_APP', {
      type: 'DATA_UPDATE',
      target: 'KPI_APP',
      payload: { shellReady: true },
    });
  }

  onAiIframeLoad(): void {
    this.aiIframeReady = true;
    this.aiStatus = 'healthy';

    this.postMessageService.registerIframe(
      'AI_APP',
      this.aiIframeRef.nativeElement,
    );

    this.postMessageService.sendMessageTo('AI_APP', {
      type: 'DATA_UPDATE',
      target: 'AI_APP',
      payload: { shellReady: true },
    });
  }

  // ─────────────────────────────────────────────
  //  Layout helpers
  // ─────────────────────────────────────────────

  resetLayout(): void {
    this.currentLayout = 'overview';
  }

  // ─────────────────────────────────────────────
  //  Visual Bus — neon border flash
  // ─────────────────────────────────────────────

  private flashNeonPulse(from: string, to: string): void {
    // Flash the source panel first, then the destination.
    if (from === 'KPI_APP') { this.kpiPulse = 'active'; }
    if (from === 'AI_APP')  { this.aiPulse  = 'active'; }

    setTimeout(() => {
      if (to === 'AI_APP')  { this.aiPulse  = 'active'; }
      if (to === 'KPI_APP') { this.kpiPulse = 'active'; }
    }, 200);

    // Reset both after the full animation cycle.
    setTimeout(() => {
      this.zone.run(() => {
        this.kpiPulse = 'idle';
        this.aiPulse  = 'idle';
      });
    }, 700);
  }

  // ─────────────────────────────────────────────
  //  Fail Simulation – delegate to broker
  // ─────────────────────────────────────────────

  restartApp(iframeId: string): void {
    if (iframeId === 'KPI_APP') { this.kpiIframeReady = false; this.kpiStatus = 'crashed'; }
    if (iframeId === 'AI_APP')  { this.aiIframeReady = false;  this.aiStatus = 'crashed'; }

    // The broker will flip status to 'recovering' then (load) → 'healthy'.
    setTimeout(() => this.postMessageService.restartApp(iframeId), 1000);
  }

  // ─────────────────────────────────────────────
  //  Kill App — sends KILL message to an iframe
  // ─────────────────────────────────────────────

  killApp(iframeId: string): void {
    this.postMessageService.killApp(iframeId);
  }
}
