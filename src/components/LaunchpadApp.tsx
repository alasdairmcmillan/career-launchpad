'use client';

import {
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Clock,
  Heart,
  Info,
  Play,
  Search,
  Share2,
  Sparkles,
  Volume2,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  type CSSProperties,
  type ComponentType,
  type RefObject,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { GumletPlayer, type GumletPlayerHandle } from '@gumlet/react-embed-player';

import {
  applyContentFilters,
  formatDuration,
  getContentBySlug,
  getRelatedContent,
  getVideoSource,
  itemMatchesFilters,
  type VideoSource,
  shuffleContentForVisit,
} from '@/lib/content';
import { sanitizeSearchQuery, trackEvent } from '@/lib/analytics';
import { normalizeKnownCategory } from '@/lib/launchpad-content-normalize';
import type { CategorySlug, ContentFilters, ContentFormat, LaunchpadCategory, LaunchpadContent } from '@/types';

import { BrowseDrawer } from '@/components/BrowseDrawer';

const LearnMorePanel = dynamic(
  () => import('@/components/LearnMorePanel').then((mod) => mod.LearnMorePanel),
  { ssr: false }
);

const LIKED_KEY = 'career-launchpad-liked-content';
const LEGACY_SAVED_KEY = 'career-launchpad-saved-content';
export const FEED_ONBOARDING_SEEN_KEY = 'career-launchpad-feed-onboarding-seen';
// null = never re-show once dismissed; set to a millisecond duration (e.g. 30 days) to re-show after expiry
export const FEED_ONBOARDING_TTL_MS: number | null = null;
const NAVY = '#22224C';
const BLUE = '#0092FF';
const FEED_TRANSITION_MS = 280;
const FEED_NAV_LOCK_MS = 320;
const RAIL_FEEDBACK_MS = 1800;
const SHARED_LINK_ONBOARDING_DELAY_MS = 2500;
const BRAND_MARK_SRC = '/launchpad-logo.svg';
function isGumletAudioRecoveryEnabled(): boolean {
  return process.env.NEXT_PUBLIC_LAUNCHPAD_GUMLET_AUDIO_RECOVERY !== 'false';
}

type AutoplayMode = 'audible' | 'muted-fallback';
type FeedDirection = 'next' | 'prev';
type FeedMediaVariant = 'mobile' | 'desktop-immersive';
type InitialPanel = 'info' | null;
type RailFeedbackAction = 'share' | 'info';
type RailFeedback = { action: RailFeedbackAction; contentId: string };
type GumletAudioState = { contentId: string; muted: boolean; volume: number };
type GumletAudioRecovery = GumletAudioState;

type IconCmp = ComponentType<{
  size?: number;
  className?: string;
  strokeWidth?: number;
  style?: CSSProperties;
  fill?: string;
}>;

function BrandMark({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'block',
        backgroundImage: `url(${BRAND_MARK_SRC})`,
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        backgroundSize: 'contain',
      }}
    />
  );
}

function LearnMoreCta({
  format,
  variant,
  onClick,
}: {
  format: ContentFormat;
  variant: 'mobile' | 'desktop';
  onClick: () => void;
}) {
  const isMobileVariant = variant === 'mobile';
  const isArticle = format === 'article';
  const label = isArticle ? 'Read it' : 'Learn More';

  return (
    <div
      className="learn-more-cta"
      style={{
        position: isMobileVariant ? 'absolute' : 'static',
        left: isMobileVariant ? '50%' : undefined,
        bottom: isMobileVariant ? 'calc(22px + env(safe-area-inset-bottom))' : undefined,
        transform: isMobileVariant ? 'translateX(-50%)' : undefined,
        zIndex: isMobileVariant ? 8 : undefined,
        width: isMobileVariant ? 'min(60vw, 280px)' : 'fit-content',
        minWidth: isMobileVariant ? 220 : undefined,
      }}
    >
      <button
        type="button"
        className="learn-more-cta__button"
        data-testid="learn-more-primary-cta"
        data-variant={variant}
        onClick={onClick}
        style={{
          width: '100%',
          height: isMobileVariant ? 56 : 58,
          borderRadius: 'var(--radius-xl, 16px)',
          fontSize: isMobileVariant ? 15 : 16,
          fontWeight: 800,
          padding: isMobileVariant ? undefined : '0 24px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          letterSpacing: 0,
        }}
      >
        {label} <ArrowUpRight size={isMobileVariant ? 16 : 18} />
      </button>
    </div>
  );
}

type FeedPlayerInstance = {
  playVideo?: () => void;
  pauseVideo?: () => void;
  mute?: () => void;
  unMute?: () => void;
  setVolume?: (volume: number) => void;
  getMuted?: () => Promise<boolean>;
  getVolume?: () => Promise<number>;
  destroy?: () => void;
};

type YouTubePlayerInstance = {
  playVideo: () => void;
  pauseVideo?: () => void;
  mute: () => void;
  unMute?: () => void;
  destroy: () => void;
};

type YouTubeNamespace = {
  PlayerState: { PLAYING: number; PAUSED: number; ENDED: number };
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, number>;
      events: {
        onReady?: () => void;
        onStateChange?: (event: { data: number }) => void;
        onAutoplayBlocked?: () => void;
      };
    }
  ) => YouTubePlayerInstance;
};

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }

  interface Navigator {
    getAutoplayPolicy?: (target: 'mediaelement') => 'allowed' | 'allowed-muted' | 'disallowed';
  }
}

const CATEGORY_BLOCK_BG: Record<CategorySlug, string> = {
  'emerging-careers': BLUE,
  'on-the-job': NAVY,
  'life-skills': BLUE,
  mindsets: NAVY,
  'how-i-got-here': BLUE,
  'problems-to-solve': NAVY,
  'post-secondary': NAVY,
  'skilled-trades': NAVY,
};

const FORMAT_ICON: Record<ContentFormat, IconCmp> = {
  video: Play,
  article: BookOpen,
};

const FORMAT_LABEL: Record<ContentFormat, string> = {
  video: 'Video',
  article: 'Article',
};

function readSavedIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = window.localStorage.getItem(LIKED_KEY) ?? window.localStorage.getItem(LEGACY_SAVED_KEY);
    return stored ? (JSON.parse(stored) as string[]) : [];
  } catch {
    return [];
  }
}

function writeSavedIds(ids: string[]) {
  window.localStorage.setItem(LIKED_KEY, JSON.stringify(ids));
}

// Future timestamps (e.g. after a clock rollback) deliberately count as seen.
export function isFeedOnboardingSeen(raw: string | null, now: number, ttlMs: number | null): boolean {
  if (!raw) return false;
  const seenAt = Number(raw);
  if (!Number.isFinite(seenAt) || seenAt <= 0) return false;
  if (ttlMs === null) return true;
  return now - seenAt < ttlMs;
}

function hasSeenFeedOnboarding(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return isFeedOnboardingSeen(
      window.localStorage.getItem(FEED_ONBOARDING_SEEN_KEY),
      Date.now(),
      FEED_ONBOARDING_TTL_MS
    );
  } catch {
    return false;
  }
}

function markFeedOnboardingSeen() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FEED_ONBOARDING_SEEN_KEY, String(Date.now()));
  } catch {
    // Storage unavailable (private browsing, quota) — the hint shows again next visit.
  }
}

function stopRailEvent(event: SyntheticEvent) {
  event.stopPropagation();
}

function categoryLabel(categories: LaunchpadCategory[], slug: CategorySlug): string {
  return categories.find((c) => c.slug === slug)?.name ?? slug;
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 860px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return isMobile;
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReducedMotion(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return reducedMotion;
}

function blocksFeedShortcuts(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest('input, textarea, select, button, a, [contenteditable="true"]');
  return Boolean(interactive && !interactive.hasAttribute('data-feed-activator'));
}

function isPlayableContent(item: LaunchpadContent | undefined): boolean {
  return item?.format === 'video' && Boolean(getVideoSource(item.mediaUrl));
}

function nowMs(): number {
  return Date.now();
}

function loadYouTubeIframeAPI(): Promise<YouTubeNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);

  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-career-launchpad-youtube-api]');
    const previousReady = window.onYouTubeIframeAPIReady;

    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      if (window.YT) resolve(window.YT);
    };

    if (existing) return;

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.dataset.careerLaunchpadYoutubeApi = 'true';
    document.head.appendChild(script);
  });
}

function useFeedNavigation(
  element: HTMLElement | null,
  options: { disabled: boolean; onNavigate: (direction: FeedDirection) => boolean }
) {
  const { disabled, onNavigate } = options;
  const wheelRef = useRef<{ total: number; lastAt: number; consumed: boolean; resetTimer: number | null }>({
    total: 0,
    lastAt: 0,
    consumed: false,
    resetTimer: null,
  });
  const touchRef = useRef<{
    startX: number;
    startY: number;
    lockedAxis: 'vertical' | 'horizontal' | null;
    samples: Array<{ y: number; t: number }>;
    triggered: boolean;
  } | null>(null);

  useEffect(() => {
    if (!element) return;

    const navigate = (direction: FeedDirection) => {
      if (touchRef.current) touchRef.current.triggered = true;
      return onNavigate(direction);
    };

    const onWheel = (event: WheelEvent) => {
      if (disabled) return;
      const absY = Math.abs(event.deltaY);
      const absX = Math.abs(event.deltaX);
      if (absY < 8 || absX > absY) return;

      event.preventDefault();
      const t = nowMs();
      const wheel = wheelRef.current;
      if (wheel.resetTimer) window.clearTimeout(wheel.resetTimer);
      wheel.resetTimer = window.setTimeout(() => {
        wheelRef.current = { total: 0, lastAt: 0, consumed: false, resetTimer: null };
      }, 160);

      if (t - wheel.lastAt > 160) {
        wheel.total = 0;
        wheel.consumed = false;
      }
      if (wheel.consumed) {
        wheel.lastAt = t;
        return;
      }

      wheel.total += event.deltaY;
      wheel.lastAt = t;

      if (Math.abs(wheel.total) >= 80) {
        if (navigate(wheel.total > 0 ? 'next' : 'prev')) {
          wheel.consumed = true;
          wheel.total = 0;
        }
      }
    };

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      touchRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        lockedAxis: null,
        samples: [{ y: touch.clientY, t: nowMs() }],
        triggered: false,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (disabled || !touchRef.current || touchRef.current.triggered) return;
      const touch = event.touches[0];
      if (!touch) return;

      const state = touchRef.current;
      const dx = touch.clientX - state.startX;
      const dy = state.startY - touch.clientY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      if (!state.lockedAxis && Math.max(absX, absY) >= 12) {
        state.lockedAxis = absY > absX * 1.25 ? 'vertical' : 'horizontal';
      }

      if (state.lockedAxis !== 'vertical') return;
      event.preventDefault();

      const t = nowMs();
      state.samples = [...state.samples, { y: touch.clientY, t }].filter((sample) => t - sample.t <= 100);
      const firstSample = state.samples[0];
      const elapsed = Math.max(1, t - firstSample.t);
      const velocity = Math.abs(touch.clientY - firstSample.y) / elapsed;

      if (absY >= 56 || (velocity >= 0.45 && absY >= 32)) {
        navigate(dy > 0 ? 'next' : 'prev');
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      const state = touchRef.current;
      if (!state || disabled || state.triggered) {
        touchRef.current = null;
        return;
      }

      const touch = event.changedTouches[0];
      const fallbackY = state.samples[state.samples.length - 1]?.y ?? state.startY;
      const endX = touch?.clientX ?? state.startX;
      const endY = touch?.clientY ?? fallbackY;
      const dx = endX - state.startX;
      const dy = state.startY - endY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      const lockedAxis = state.lockedAxis ?? (Math.max(absX, absY) >= 12 && absY > absX * 1.25 ? 'vertical' : null);

      if (lockedAxis === 'vertical' && absY >= 40) {
        navigate(dy > 0 ? 'next' : 'prev');
      }
      touchRef.current = null;
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      if (wheelRef.current.resetTimer) window.clearTimeout(wheelRef.current.resetTimer);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [disabled, element, onNavigate]);
}

type LaunchpadAppProps = {
  initialContent: LaunchpadContent[];
  initialCategories: LaunchpadCategory[];
  initialContentSlug?: string | null;
  initialPanel?: InitialPanel;
  initialPathSlug?: string | null;
  feedSeed: string;
};

export function LaunchpadApp({
  initialContent,
  initialCategories,
  initialContentSlug = null,
  initialPanel = null,
  initialPathSlug = null,
  feedSeed,
}: LaunchpadAppProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const unfilteredFeedContent = useMemo(
    () => shuffleContentForVisit(initialContent, feedSeed),
    [feedSeed, initialContent]
  );
  const initialLinkedContent = useMemo(
    () => getContentBySlug(initialContent, initialContentSlug ?? null),
    [initialContentSlug, initialContent]
  );
  const initialFeedIndex = useMemo(() => {
    if (!initialLinkedContent) return 0;
    return Math.max(0, unfilteredFeedContent.findIndex((entry) => entry.id === initialLinkedContent.id));
  }, [initialLinkedContent, unfilteredFeedContent]);
  const initialPathCategories = useMemo(() => {
    if (!initialPathSlug) return [];
    const slugs = initialPathSlug.split(',').map((slug) => normalizeKnownCategory(slug.trim().toLowerCase()));
    return [...new Set(slugs.filter((slug): slug is CategorySlug => slug !== null))];
  }, [initialPathSlug]);
  // A resolved content deep link wins over a path link: focusFeedContent clears
  // filters so the linked item is always visible.
  const [filters, setFilters] = useState<ContentFilters>(() => ({
    categories: initialLinkedContent ? [] : initialPathCategories,
    format: null,
  }));
  const [query, setQuery] = useState('');
  const [feedIdx, setFeedIdx] = useState(initialFeedIndex);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<LaunchpadContent | null>(
    initialPanel === 'info' ? (initialLinkedContent ?? null) : null
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pathsDrawerOpen, setPathsDrawerOpen] = useState(false);
  const [formatsDrawerOpen, setFormatsDrawerOpen] = useState(false);
  const [navDirection, setNavDirection] = useState<FeedDirection>('next');
  const [playingContentId, setPlayingContentId] = useState<string | null>(null);
  const [autoplayMode, setAutoplayMode] = useState<AutoplayMode>('audible');
  const [gumletAudioRecovery, setGumletAudioRecovery] = useState<GumletAudioRecovery | null>(null);
  const [activeRailFeedback, setActiveRailFeedback] = useState<RailFeedback | null>(null);
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [feedOnboardingOpen, setFeedOnboardingOpen] = useState(false);
  const toastTimer = useRef<number | null>(null);
  const railFeedbackTimer = useRef<number | null>(null);
  const [navSurfaceElement, setNavSurfaceElement] = useState<HTMLDivElement | null>(null);
  const feedDeckRef = useRef<HTMLDivElement | null>(null);
  const navLockedUntilRef = useRef(0);
  const processedInitialRouteRef = useRef<string | null>(null);
  const processedInitialPathRef = useRef<string | null>(null);
  const activePlayerRef = useRef<FeedPlayerInstance | null>(null);
  const gumletAudioRecoveryShownRef = useRef(new Set<string>());
  const sharedLinkOnboardingTimerRef = useRef<number | null>(null);
  const feedOnboardingSuppressedForSessionRef = useRef(false);
  const sessionStartTrackedRef = useRef(false);
  const currentFeedCardRef = useRef<HTMLDivElement | null>(null);
  const focusedFeedIdRef = useRef<string | null>(null);
  const [pendingFeedFocusId, setPendingFeedFocusId] = useState<string | null>(
    initialLinkedContent && initialPanel !== 'info' ? initialLinkedContent.id : null
  );
  const isMobile = useIsMobile();
  const reducedMotion = usePrefersReducedMotion();

  const filteredContent = useMemo(() => {
    const base = applyContentFilters(unfilteredFeedContent, filters);
    if (!query.trim()) return base;

    const q = query.trim().toLowerCase();
    return base.filter((item) =>
      [item.title, item.description, ...item.categories, item.format].join(' ').toLowerCase().includes(q)
    );
  }, [filters, query, unfilteredFeedContent]);

  // Reset feedIdx when filters/query change — React-recommended "store info from
  // previous renders" pattern: detect the change during render and reset before paint.
  const filterKey = `${filters.categories.join(',')}|${filters.format ?? ''}|${query}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey);
    setFeedIdx(0);
  }

  const safeIdx = filteredContent.length === 0 ? 0 : Math.min(feedIdx, filteredContent.length - 1);
  const item: LaunchpadContent | undefined = filteredContent[safeIdx];
  const nextItem = filteredContent[safeIdx + 1] ?? null;
  const effectivePlayingContentId = item?.id === playingContentId && isPlayableContent(item) ? playingContentId : null;
  const currentGumletAudioRecovery =
    isGumletAudioRecoveryEnabled() &&
    gumletAudioRecovery?.contentId === item?.id &&
    effectivePlayingContentId === item?.id
      ? gumletAudioRecovery
      : null;

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  }, []);

  const showRailFeedback = useCallback((action: RailFeedbackAction, contentId: string) => {
    setActiveRailFeedback({ action, contentId });
    if (railFeedbackTimer.current) window.clearTimeout(railFeedbackTimer.current);
    railFeedbackTimer.current = window.setTimeout(() => setActiveRailFeedback(null), RAIL_FEEDBACK_MS);
  }, []);

  const dismissFeedOnboarding = useCallback(() => {
    feedOnboardingSuppressedForSessionRef.current = true;
    markFeedOnboardingSeen();
    setFeedOnboardingOpen(false);
  }, []);

  const shouldShowFeedOnboarding =
    onboardingChecked && feedOnboardingOpen && !selected && !searchOpen && !pathsDrawerOpen && !formatsDrawerOpen;

  const cancelSharedLinkOnboarding = useCallback(() => {
    if (sharedLinkOnboardingTimerRef.current !== null) {
      window.clearTimeout(sharedLinkOnboardingTimerRef.current);
      sharedLinkOnboardingTimerRef.current = null;
      // Suppress for this mount, but don't persist — the hint never rendered.
      feedOnboardingSuppressedForSessionRef.current = true;
      setOnboardingChecked(true);
      setFeedOnboardingOpen(false);
      return;
    }
    if (shouldShowFeedOnboarding) dismissFeedOnboarding();
  }, [shouldShowFeedOnboarding, dismissFeedOnboarding]);

  const trackVideoPause = useCallback(
    (reason: unknown) => {
      if (!item || effectivePlayingContentId !== item.id || item.format !== 'video') return;
      const source = getVideoSource(item.mediaUrl);
      trackEvent('video_pause', {
        contentId: item.id,
        metadata: {
          reason: typeof reason === 'string' ? reason : 'explicit',
          provider: source?.provider,
          format: item.format,
          durationSeconds: item.durationSeconds,
        },
      });
    },
    [effectivePlayingContentId, item]
  );

  const focusFeedContent = useCallback(
    (target: LaunchpadContent, options: { panel: boolean; focusFeed?: boolean }) => {
      const nextIdx = Math.max(0, unfilteredFeedContent.findIndex((entry) => entry.id === target.id));

      activePlayerRef.current?.pauseVideo?.();
      setPlayingContentId(null);
      setSearchOpen(false);
      setPathsDrawerOpen(false);
      setFormatsDrawerOpen(false);
      setFilters({ categories: [], format: null });
      setQuery('');
      setPrevFilterKey('||');
      setNavDirection('next');
      navLockedUntilRef.current = 0;
      setFeedIdx(nextIdx);
      setSelected(options.panel ? target : null);
      if (options.focusFeed && !options.panel) {
        focusedFeedIdRef.current = null;
        setPendingFeedFocusId(target.id);
      }
    },
    [unfilteredFeedContent]
  );

  const openSearch = useCallback(() => {
    cancelSharedLinkOnboarding();
    if (!searchOpen) trackEvent('search_open');
    trackVideoPause('search');
    activePlayerRef.current?.pauseVideo?.();
    setPlayingContentId(null);
    setSearchOpen(true);
  }, [cancelSharedLinkOnboarding, searchOpen, trackVideoPause]);

  const setPathsDrawerOpenWithOnboardingCancel = useCallback(
    (open: boolean) => {
      if (open) cancelSharedLinkOnboarding();
      setPathsDrawerOpen(open);
    },
    [cancelSharedLinkOnboarding]
  );

  const setFormatsDrawerOpenWithOnboardingCancel = useCallback(
    (open: boolean) => {
      if (open) cancelSharedLinkOnboarding();
      setFormatsDrawerOpen(open);
    },
    [cancelSharedLinkOnboarding]
  );

  // Initial load
  useEffect(() => {
    queueMicrotask(() => setSavedIds(readSavedIds()));
    if (!sessionStartTrackedRef.current) {
      sessionStartTrackedRef.current = true;
      trackEvent('session_start', { metadata: { contentCount: initialContent.length } });
    }
    trackEvent('entry_view', { metadata: { contentCount: initialContent.length } });
  }, [initialContent.length]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;

      if (feedOnboardingSuppressedForSessionRef.current || hasSeenFeedOnboarding()) {
        setOnboardingChecked(true);
        setFeedOnboardingOpen(false);
        return;
      }

      if (initialLinkedContent && initialPanel !== 'info') {
        sharedLinkOnboardingTimerRef.current = window.setTimeout(() => {
          sharedLinkOnboardingTimerRef.current = null;
          if (cancelled) return;

          // A dismissal may have landed during the delay, including from another tab.
          if (feedOnboardingSuppressedForSessionRef.current || hasSeenFeedOnboarding()) {
            setOnboardingChecked(true);
            setFeedOnboardingOpen(false);
            return;
          }

          setOnboardingChecked(true);
          setFeedOnboardingOpen(true);
        }, SHARED_LINK_ONBOARDING_DELAY_MS);
        return;
      }

      setOnboardingChecked(true);
      setFeedOnboardingOpen(true);
    });
    return () => {
      cancelled = true;
      if (sharedLinkOnboardingTimerRef.current !== null) {
        window.clearTimeout(sharedLinkOnboardingTimerRef.current);
        sharedLinkOnboardingTimerRef.current = null;
      }
    };
  }, [initialLinkedContent, initialPanel]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      if (railFeedbackTimer.current) window.clearTimeout(railFeedbackTimer.current);
      if (sharedLinkOnboardingTimerRef.current) window.clearTimeout(sharedLinkOnboardingTimerRef.current);
    };
  }, []);

  // Deep link
  useEffect(() => {
    const routeKey = `${initialContentSlug ?? ''}|${initialPanel ?? ''}`;
    const invalidInitialPath = Boolean(initialPathSlug) && initialPathCategories.length === 0;

    if (initialContentSlug && processedInitialRouteRef.current !== routeKey) {
      processedInitialRouteRef.current = routeKey;
      if (initialLinkedContent) {
        queueMicrotask(() => {
          focusFeedContent(initialLinkedContent, {
            panel: initialPanel === 'info',
            focusFeed: initialPanel !== 'info',
          });
        });
        trackEvent('content_open', { contentId: initialLinkedContent.id, metadata: { source: 'direct_link' } });
        if (initialPanel === 'info') {
          trackEvent('learn_more_open', { contentId: initialLinkedContent.id, metadata: { source: 'direct_link' } });
        }
      } else {
        const params = new URLSearchParams(searchParams.toString());
        params.delete('content');
        params.delete('panel');
        if (invalidInitialPath) {
          processedInitialPathRef.current = initialPathSlug;
          params.delete('path');
        }
        const nextUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
        router.replace(nextUrl);
        queueMicrotask(() => showToast('Content not available'));
      }
    }

    if (initialPathSlug && processedInitialPathRef.current !== initialPathSlug) {
      processedInitialPathRef.current = initialPathSlug;
      if (invalidInitialPath) {
        const params = new URLSearchParams(searchParams.toString());
        params.delete('path');
        const nextUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
        router.replace(nextUrl);
        queueMicrotask(() => showToast('Path not available'));
      } else if (!initialLinkedContent) {
        for (const slug of initialPathCategories) {
          trackEvent('category_filter', { metadata: { category: slug, action: 'add', source: 'direct_link' } });
        }
      }
    }

    const onPop = () => {
      const next = new URLSearchParams(window.location.search);
      const linked = getContentBySlug(initialContent, next.get('content'));
      const panel = next.get('panel') === 'info';
      if (linked) {
        focusFeedContent(linked, { panel, focusFeed: !panel });
      } else {
        setSelected(null);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [
    focusFeedContent,
    initialContent,
    initialContentSlug,
    initialLinkedContent,
    initialPanel,
    initialPathCategories,
    initialPathSlug,
    pathname,
    router,
    searchParams,
    showToast,
  ]);

  const toggleCategory = useCallback((slug: CategorySlug) => {
    setFilters((current) => {
      const next = current.categories.includes(slug)
        ? current.categories.filter((s) => s !== slug)
        : [...current.categories, slug];
      trackEvent('category_filter', { metadata: { category: slug, action: current.categories.includes(slug) ? 'remove' : 'add' } });
      return { ...current, categories: next };
    });
  }, []);

  const clearCategories = useCallback(() => {
    setFilters((current) => ({ ...current, categories: [] }));
    trackEvent('category_filter', { metadata: { category: 'all' } });
  }, []);

  const setFormat = useCallback((format: ContentFormat | null) => {
    setFilters((current) => ({ ...current, format }));
    trackEvent('format_filter', { metadata: { format: format ?? 'all' } });
  }, []);

  const openPanel = useCallback(
    (target: LaunchpadContent, source: string) => {
      cancelSharedLinkOnboarding();
      trackVideoPause('panel');
      activePlayerRef.current?.pauseVideo?.();
      setPlayingContentId(null);
      setSearchOpen(false);
      setPathsDrawerOpen(false);
      setFormatsDrawerOpen(false);

      const isCurrent = target.id === item?.id;
      if (!isCurrent) {
        const fits = itemMatchesFilters(target, filters);
        if (!fits) {
          setFilters({ categories: [], format: null });
          setQuery('');
          setPrevFilterKey('||');
        }
        setNavDirection('next');
        navLockedUntilRef.current = 0;
        const list = fits ? filteredContent : unfilteredFeedContent;
        setFeedIdx(Math.max(0, list.findIndex((entry) => entry.id === target.id)));
      }

      setSelected(target);

      const url = new URL(window.location.href);
      url.searchParams.set('content', target.slug);
      url.searchParams.set('panel', 'info');
      window.history.pushState({ contentSlug: target.slug, panel: 'info' }, '', url);

      trackEvent('content_open', { contentId: target.id, metadata: { source } });
      trackEvent('learn_more_open', { contentId: target.id, metadata: { source } });
    },
    [cancelSharedLinkOnboarding, filteredContent, filters, item?.id, trackVideoPause, unfilteredFeedContent]
  );

  const closePanel = useCallback(() => {
    setSelected(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('panel');
    window.history.replaceState({}, '', url);
  }, []);

  const jumpToSearchResult = useCallback(
    (
      target: LaunchpadContent,
      searchAnalytics?: { query: string; resultCount: number; rank: number }
    ) => {
      trackVideoPause('search');
      activePlayerRef.current?.pauseVideo?.();
      setPlayingContentId(null);
      setSearchOpen(false);
      setSelected(null);
      setFilters({ categories: [], format: null });
      setQuery('');
      setPrevFilterKey('||');
      setNavDirection('next');
      setFeedIdx(Math.max(0, unfilteredFeedContent.findIndex((entry) => entry.id === target.id)));
      navLockedUntilRef.current = 0;

      const url = new URL(window.location.href);
      url.searchParams.delete('content');
      window.history.replaceState({}, '', url);
      if (searchAnalytics?.query) {
        trackEvent('search_result_click', {
          contentId: target.id,
          metadata: { ...searchAnalytics, selectedContentId: target.id },
        });
      }
      trackEvent('content_open', { contentId: target.id, metadata: { source: 'search' } });
    },
    [trackVideoPause, unfilteredFeedContent]
  );

  const toggleSave = useCallback(
    (target: LaunchpadContent) => {
      setSavedIds((current) => {
        const wasSaved = current.includes(target.id);
        const next = wasSaved ? current.filter((id) => id !== target.id) : [...current, target.id];
        writeSavedIds(next);
        trackEvent('like', { contentId: target.id, metadata: { liked: !wasSaved } });
        showToast(wasSaved ? 'Like removed' : 'Liked');
        return next;
      });
    },
    [showToast]
  );

  const shareItem = useCallback(
    async (target: LaunchpadContent) => {
      const url = new URL(window.location.href);
      url.searchParams.set('content', target.slug);
      url.searchParams.delete('panel');
      url.searchParams.delete('path');
      try {
        await window.navigator.clipboard.writeText(url.toString());
      } catch {
        window.prompt('Copy this link', url.toString());
      }
      trackEvent('share', { contentId: target.id });
      showToast('Link copied');
    },
    [showToast]
  );

  const navigateFeed = useCallback(
    (direction: FeedDirection, options: { ignoreLock?: boolean } = {}) => {
      const t = nowMs();
      if (!options.ignoreLock && t < navLockedUntilRef.current) return false;

      const delta = direction === 'next' ? 1 : -1;
      const nextIdx = Math.max(0, Math.min(filteredContent.length - 1, safeIdx + delta));
      if (nextIdx === safeIdx) return false;

      setNavDirection(direction);
      setFeedIdx(nextIdx);
      const nextItem = filteredContent[nextIdx];
      setPlayingContentId((current) => {
        if (!current || current !== item?.id) return null;
        return isPlayableContent(nextItem) ? nextItem.id : null;
      });
      navLockedUntilRef.current = t + FEED_NAV_LOCK_MS;
      return true;
    },
    [filteredContent, item, safeIdx]
  );

  const stepNext = useCallback(() => {
    navigateFeed('next');
  }, [navigateFeed]);
  const stepPrev = useCallback(() => {
    navigateFeed('prev');
  }, [navigateFeed]);

  useEffect(() => {
    if (!pendingFeedFocusId || item?.id !== pendingFeedFocusId || selected) return;
    if (focusedFeedIdRef.current === pendingFeedFocusId) return;
    currentFeedCardRef.current?.focus({ preventScroll: true });
    focusedFeedIdRef.current = pendingFeedFocusId;
  }, [item?.id, pendingFeedFocusId, selected]);

  useFeedNavigation(navSurfaceElement, {
    disabled: Boolean(selected || searchOpen || shouldShowFeedOnboarding),
    onNavigate: navigateFeed,
  });

  const playItem = useCallback((target: LaunchpadContent) => {
    if (!isPlayableContent(target)) return;
    setAutoplayMode('audible');
    setGumletAudioRecovery(null);
    setPlayingContentId(target.id);
  }, []);

  const stopPlayback = useCallback(
    (reason = 'explicit') => {
      trackVideoPause(reason);
      setGumletAudioRecovery(null);
      setPlayingContentId(null);
    },
    [trackVideoPause]
  );

  const handleGumletAudioState = useCallback((state: GumletAudioState) => {
    const needsRecovery = state.muted || state.volume <= 0;

    if (!isGumletAudioRecoveryEnabled()) {
      gumletAudioRecoveryShownRef.current.delete(state.contentId);
      setGumletAudioRecovery((current) => (current?.contentId === state.contentId ? null : current));
      return;
    }

    if (!needsRecovery) {
      const wasRecovering = gumletAudioRecoveryShownRef.current.has(state.contentId);
      gumletAudioRecoveryShownRef.current.delete(state.contentId);
      setGumletAudioRecovery((current) => (current?.contentId === state.contentId ? null : current));
      if (wasRecovering) {
        trackEvent('video_audio_recovery', {
          contentId: state.contentId,
          metadata: { provider: 'gumlet', action: 'confirmed', muted: state.muted, volume: state.volume },
        });
      }
      return;
    }

    if (!gumletAudioRecoveryShownRef.current.has(state.contentId)) {
      gumletAudioRecoveryShownRef.current.add(state.contentId);
      trackEvent('video_audio_recovery', {
        contentId: state.contentId,
        metadata: { provider: 'gumlet', action: 'shown', muted: state.muted, volume: state.volume },
      });
    }

    setGumletAudioRecovery(state);
  }, []);

  const recoverGumletAudio = useCallback(async () => {
    if (!item || !currentGumletAudioRecovery) return;

    const player = activePlayerRef.current;
    trackEvent('video_audio_recovery', {
      contentId: item.id,
      metadata: {
        provider: 'gumlet',
        action: 'clicked',
        muted: currentGumletAudioRecovery.muted,
        volume: currentGumletAudioRecovery.volume,
      },
    });

    player?.unMute?.();
    player?.setVolume?.(100);
    player?.playVideo?.();

    const [muted, volume] = await Promise.all([
      player?.getMuted?.() ?? Promise.resolve(false),
      player?.getVolume?.() ?? Promise.resolve(100),
    ]);

    handleGumletAudioState({ contentId: item.id, muted, volume });
  }, [currentGumletAudioRecovery, handleGumletAudioState, item]);

  const handleVideoEnd = useCallback(() => {
    if (item) {
      const source = getVideoSource(item.mediaUrl);
      trackEvent('video_complete', {
        contentId: item.id,
        metadata: { provider: source?.provider, format: item.format, durationSeconds: item.durationSeconds },
      });
    }
    setGumletAudioRecovery(null);
    const advanced = navigateFeed('next', { ignoreLock: true });
    if (!advanced) setPlayingContentId(null);
  }, [item, navigateFeed]);

  const handlePlayerReady = useCallback((player: FeedPlayerInstance | null) => {
    activePlayerRef.current = player;
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        openSearch();
        return;
      }
      if (selected || searchOpen || shouldShowFeedOnboarding) return;
      if (blocksFeedShortcuts(e.target) || blocksFeedShortcuts(document.activeElement)) return;
      if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'j') {
        e.preventDefault();
        stepNext();
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'k') {
        e.preventDefault();
        stepPrev();
      } else if (e.key === ' ' || e.key === 'Spacebar') {
        if (!item || !isPlayableContent(item)) return;
        e.preventDefault();
        if (effectivePlayingContentId === item.id) stopPlayback();
        else playItem(item);
      }
    };
    window.addEventListener('keydown', onKey as unknown as EventListener);
    return () => window.removeEventListener('keydown', onKey as unknown as EventListener);
  }, [
    effectivePlayingContentId,
    item,
    openSearch,
    playItem,
    searchOpen,
    selected,
    shouldShowFeedOnboarding,
    stepNext,
    stepPrev,
    stopPlayback,
  ]);

  // Track impression when item changes
  const lastImpressionId = useRef<string | null>(null);
  useEffect(() => {
    if (!item || lastImpressionId.current === item.id) return;
    lastImpressionId.current = item.id;
    trackEvent('feed_impression', {
      contentId: item.id,
      metadata: { category: item.primaryCategory, categories: item.categories, format: item.format },
    });
  }, [item]);

  if (!item) {
    return (
      <EmptyState
        onClear={() => {
          setFilters({ categories: [], format: null });
          setQuery('');
        }}
      />
    );
  }

  const isSaved = savedIds.includes(item.id);
  const currentRailFeedback = activeRailFeedback?.contentId === item.id ? activeRailFeedback.action : null;
  const stageProps = {
    item,
    nextItem,
    categories: initialCategories,
    isSaved,
    activeRailFeedback: currentRailFeedback,
    audioRecoveryVisible: Boolean(currentGumletAudioRecovery),
    activeCategories: filters.categories,
    activeFormat: filters.format,
    toggleCategory,
    clearCategories,
    setFormat,
    onLearnMore: () => openPanel(item, 'feed'),
    onInfo: () => {
      showRailFeedback('info', item.id);
      openPanel(item, 'feed');
    },
    onSave: () => toggleSave(item),
    onShare: () => {
      showRailFeedback('share', item.id);
      void shareItem(item);
    },
    onAudioRecovery: () => {
      void recoverGumletAudio();
    },
    onSearch: openSearch,
    pathsDrawerOpen,
    setPathsDrawerOpen: setPathsDrawerOpenWithOnboardingCancel,
    formatsDrawerOpen,
    setFormatsDrawerOpen: setFormatsDrawerOpenWithOnboardingCancel,
    feedDeckRef,
    currentFeedCardRef,
    navDirection,
    reducedMotion,
    isPlaying: effectivePlayingContentId === item.id,
    autoplayMode,
    onPlay: () => playItem(item),
    onPause: stopPlayback,
    onVideoEnd: handleVideoEnd,
    onAutoplayModeChange: setAutoplayMode,
    onPlayerReady: handlePlayerReady,
    onGumletAudioState: handleGumletAudioState,
    navSurfaceRef: setNavSurfaceElement,
  };

  return (
    <main style={{ minHeight: '100dvh', background: 'var(--off-white)', color: 'var(--navy)', fontFamily: 'var(--font-primary)' }}>
      {isMobile ? <MobileStage {...stageProps} /> : <DesktopStage {...stageProps} />}

      <BrowseDrawer
        mode="paths"
        open={pathsDrawerOpen}
        mobile={isMobile}
        categories={initialCategories}
        content={initialContent}
        activeCategories={filters.categories}
        activeFormat={filters.format}
        onToggleCategory={toggleCategory}
        onClearCategories={clearCategories}
        onPickFormat={() => {}}
        onClose={() => setPathsDrawerOpen(false)}
      />

      <BrowseDrawer
        mode="formats"
        open={formatsDrawerOpen}
        mobile={isMobile}
        categories={initialCategories}
        content={initialContent}
        activeCategories={filters.categories}
        activeFormat={filters.format}
        onToggleCategory={() => {}}
        onClearCategories={() => {}}
        onPickFormat={(format) => {
          setFormat(format);
          setFormatsDrawerOpen(false);
        }}
        onClose={() => setFormatsDrawerOpen(false)}
      />

      {selected && (
        <LearnMorePanel
          item={selected}
          categories={initialCategories}
          related={getRelatedContent(initialContent, selected)}
          isSaved={savedIds.includes(selected.id)}
          mobile={isMobile}
          onClose={closePanel}
          onSave={() => toggleSave(selected)}
          onShare={() => shareItem(selected)}
          onOutboundClick={(href) =>
            trackEvent('outbound_click', {
              contentId: selected.id,
              metadata: { href },
            })
          }
          onRelated={(next) => {
            trackEvent('related_content_click', {
              contentId: selected.id,
              metadata: { relatedContentId: next.id },
            });
            openPanel(next, 'related');
          }}
        />
      )}

      {searchOpen && (
        <SearchModal
          content={unfilteredFeedContent}
          categories={initialCategories}
          mobile={isMobile}
          onClose={() => setSearchOpen(false)}
          onPick={jumpToSearchResult}
          onSearchQuery={(query, resultCount) => {
            trackEvent('search_query', { metadata: { query, resultCount } });
            if (resultCount === 0) {
              trackEvent('search_zero_results', { metadata: { query, resultCount } });
            }
          }}
        />
      )}

      {shouldShowFeedOnboarding && (
        <FeedOnboardingDialog
          mobile={isMobile}
          reducedMotion={reducedMotion}
          onDismiss={dismissFeedOnboarding}
        />
      )}

      <Toast message={toast} show={!!toast} />
    </main>
  );
}

// ============================================================
// Desktop Stage
// ============================================================
type StageProps = {
  item: LaunchpadContent;
  nextItem: LaunchpadContent | null;
  categories: LaunchpadCategory[];
  isSaved: boolean;
  activeRailFeedback: RailFeedbackAction | null;
  audioRecoveryVisible: boolean;
  activeCategories: CategorySlug[];
  activeFormat: ContentFormat | null;
  toggleCategory: (slug: CategorySlug) => void;
  clearCategories: () => void;
  setFormat: (format: ContentFormat | null) => void;
  onLearnMore: () => void;
  onInfo: () => void;
  onSave: () => void;
  onShare: () => void;
  onAudioRecovery: () => void;
  onSearch: () => void;
  pathsDrawerOpen: boolean;
  setPathsDrawerOpen: (open: boolean) => void;
  formatsDrawerOpen: boolean;
  setFormatsDrawerOpen: (open: boolean) => void;
  navSurfaceRef: (node: HTMLDivElement | null) => void;
  feedDeckRef: RefObject<HTMLDivElement | null>;
  currentFeedCardRef: RefObject<HTMLDivElement | null>;
  navDirection: FeedDirection;
  reducedMotion: boolean;
  isPlaying: boolean;
  autoplayMode: AutoplayMode;
  onPlay: () => void;
  onPause: () => void;
  onVideoEnd: () => void;
  onAutoplayModeChange: (mode: AutoplayMode) => void;
  onPlayerReady: (player: FeedPlayerInstance | null) => void;
  onGumletAudioState: (state: GumletAudioState) => void;
};

function DesktopStage({
  item,
  nextItem,
  categories,
  isSaved,
  activeRailFeedback,
  audioRecoveryVisible,
  activeCategories,
  activeFormat,
  onLearnMore,
  onInfo,
  onSave,
  onShare,
  onAudioRecovery,
  onSearch,
  pathsDrawerOpen,
  setPathsDrawerOpen,
  formatsDrawerOpen,
  setFormatsDrawerOpen,
  navSurfaceRef,
  feedDeckRef,
  currentFeedCardRef,
  navDirection,
  reducedMotion,
  isPlaying,
  autoplayMode,
  onPlay,
  onPause,
  onVideoEnd,
  onAutoplayModeChange,
  onPlayerReady,
  onGumletAudioState,
}: StageProps) {
  const blockColor = CATEGORY_BLOCK_BG[item.primaryCategory] ?? BLUE;
  const DESKTOP_STAGE_MAX_WIDTH = 1720;

  const pathsCtaText = (() => {
    if (activeCategories.length === 0) return null;
    if (activeCategories.length === 1) return categoryLabel(categories, activeCategories[0]);
    return `${activeCategories.length} Paths`;
  })();
  const defaultPathsCount = categories.length;
  const pathsAriaLabel = pathsCtaText ?? `${defaultPathsCount} Paths`;

  return (
    <div
      ref={navSurfaceRef}
      data-testid="launchpad-navigation-surface"
      className="lp-fullheight"
      style={{ width: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      {/* Header */}
      <header
        style={{
          height: 64,
          display: 'flex',
          alignItems: 'center',
          padding: '0 32px',
          borderBottom: '1px solid var(--border-1)',
          flexShrink: 0,
          gap: 16,
          background: 'var(--white)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontWeight: 900,
            fontSize: 18,
            letterSpacing: 0,
          }}
        >
          <BrandMark size={32} />
          LaunchPad
        </div>
        <div style={{ flex: 1 }} />

        <button
          type="button"
          className="lp-header-browse-cta"
          onClick={() => setPathsDrawerOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={pathsDrawerOpen}
          aria-label={pathsAriaLabel}
          data-active={activeCategories.length > 0 ? 'true' : 'false'}
        >
          {pathsCtaText === null ? (
            <>
              <span className="num" aria-hidden="true">{defaultPathsCount}</span>
              <span aria-hidden="true">Paths</span>
            </>
          ) : (
            <span aria-hidden="true">{pathsCtaText}</span>
          )}
          <ChevronRight size={12} aria-hidden="true" />
        </button>

        <button
          type="button"
          className="lp-header-browse-cta"
          onClick={() => setFormatsDrawerOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={formatsDrawerOpen}
          aria-label={activeFormat === null ? '2 Formats' : FORMAT_LABEL[activeFormat]}
          data-active={activeFormat !== null ? 'true' : 'false'}
        >
          {activeFormat === null ? (
            <>
              <span className="num" aria-hidden="true">2</span>
              <span aria-hidden="true">Formats</span>
            </>
          ) : (
            <span aria-hidden="true">{FORMAT_LABEL[activeFormat]}</span>
          )}
          <ChevronRight size={12} aria-hidden="true" />
        </button>

        <button
          onClick={onSearch}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'var(--white)',
            border: '1px solid var(--border-1)',
            borderRadius: 999,
            padding: '8px 14px',
            fontSize: 13,
            color: 'var(--neutral-5)',
            cursor: 'pointer',
            minWidth: 240,
          }}
          aria-label="Open search"
        >
          <Search size={14} />
          <span>Search careers, skills, articles…</span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              padding: '2px 6px',
              border: '1px solid var(--border-1)',
              borderRadius: 4,
            }}
          >
            ⌘K
          </span>
        </button>
      </header>

      {/* Stage */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: 'clamp(20px, 2.5vw, 24px) clamp(24px, 4vw, 64px) clamp(28px, 4vw, 40px)',
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(320px, min(42vw, 520px)) minmax(0, 1fr)',
            gap: 'clamp(24px, 3vw, 40px)',
            alignItems: 'center',
            width: '100%',
            maxWidth: DESKTOP_STAGE_MAX_WIDTH,
            height: '100%',
            minHeight: 0,
            boxSizing: 'border-box',
          }}
        >
        {/* LEFT: editorial */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ transform: 'rotate(-2deg)', display: 'inline-block' }}>
              <div
                data-testid="desktop-category-pill"
                style={{
                  background: blockColor,
                  color: 'var(--white)',
                  padding: '6px 12px',
                  fontSize: 11,
                  fontWeight: 900,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  display: 'inline-block',
                }}
              >
                {categoryLabel(categories, item.primaryCategory)}
              </div>
            </div>
            <FormatPill type={item.format} />
          </div>

          <h1
            style={{
              fontSize: 'clamp(40px, 4vw, 56px)',
              lineHeight: 1.08,
              fontWeight: 900,
              letterSpacing: '-0.03em',
              margin: 0,
              textWrap: 'balance' as CSSProperties['textWrap'],
            }}
          >
            <HighlightedTitle title={item.title} accent={BLUE} />
          </h1>

          <p
            style={{
              fontSize: 17,
              lineHeight: 1.55,
              color: 'var(--neutral-5)',
              margin: 0,
              textWrap: 'pretty' as CSSProperties['textWrap'],
            }}
          >
            {item.description}
          </p>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--neutral-5)',
              flexWrap: 'wrap',
            }}
          >
            {item.format === 'video' && item.durationSeconds && (
              <Meta icon={Clock} label={formatDuration(item.durationSeconds) ?? ''} />
            )}
            {item.format === 'article' && <Meta icon={BookOpen} label="Article" />}
            {item.format === 'article' && item.readingTimeMinutes && (
              <Meta icon={Clock} label={`${item.readingTimeMinutes} min read`} />
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: 'var(--primary-blue)',
              }}
            >
              Why it matters
            </span>
            <p
              style={{
                margin: 0,
                fontSize: 17,
                lineHeight: 1.5,
                color: 'var(--navy)',
                fontStyle: 'italic',
                fontWeight: 500,
              }}
            >
              {pullQuoteFor(item)}
            </p>
          </div>

          <LearnMoreCta format={item.format} variant="desktop" onClick={onLearnMore} />

        </div>

        {/* CENTER: media */}
        <div
          style={{
            position: 'relative',
            display: 'grid',
            placeItems: 'center',
            height: '100%',
          }}
        >
          <FeedMediaDeck
            deckRef={feedDeckRef}
            currentCardRef={currentFeedCardRef}
            item={item}
            nextItem={nextItem}
            blockColor={blockColor}
            variant="desktop-immersive"
            direction={navDirection}
            reducedMotion={reducedMotion}
            isPlaying={isPlaying}
            isSaved={isSaved}
            activeRailFeedback={activeRailFeedback}
            audioRecoveryVisible={audioRecoveryVisible}
            autoplayMode={autoplayMode}
            onPlay={onPlay}
            onPause={onPause}
            onVideoEnd={onVideoEnd}
            onSave={onSave}
            onShare={onShare}
            onAudioRecovery={onAudioRecovery}
            onLearnMore={onInfo}
            onAutoplayModeChange={onAutoplayModeChange}
            onPlayerReady={onPlayerReady}
            onGumletAudioState={onGumletAudioState}
          />
        </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Mobile Stage — full-bleed media + overlaid CTA
// ============================================================
function MobileStage({
  item,
  categories,
  isSaved,
  activeRailFeedback,
  audioRecoveryVisible,
  activeCategories,
  activeFormat,
  onLearnMore,
  onInfo,
  onSave,
  onShare,
  onAudioRecovery,
  onSearch,
  pathsDrawerOpen,
  setPathsDrawerOpen,
  formatsDrawerOpen,
  setFormatsDrawerOpen,
  navSurfaceRef,
  feedDeckRef,
  currentFeedCardRef,
  navDirection,
  reducedMotion,
  isPlaying,
  autoplayMode,
  onPlay,
  onPause,
  onVideoEnd,
  onAutoplayModeChange,
  onPlayerReady,
  onGumletAudioState,
}: StageProps) {
  const pathsCtaText = (() => {
    if (activeCategories.length === 0) return null;
    if (activeCategories.length === 1) return categoryLabel(categories, activeCategories[0]);
    return `${activeCategories.length} Paths`;
  })();
  const defaultPathsCount = categories.length;
  const pathsAriaLabel = pathsCtaText ?? `${defaultPathsCount} Paths`;
  return (
    <div
      ref={navSurfaceRef}
      data-testid="launchpad-navigation-surface"
      className="lp-fullheight"
      style={{
        width: '100%',
        background: 'var(--off-white)',
        color: 'var(--navy)',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* header */}
      <div
        style={{
          height: 52,
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          borderBottom: '1px solid var(--border-1)',
          gap: 8,
          flexShrink: 0,
          background: 'var(--white)',
        }}
      >
        <BrandMark size={28} />
        <div style={{ fontWeight: 900, fontSize: 15 }}>LaunchPad</div>
        <div style={{ flex: 1 }} />

        <button
          type="button"
          className="lp-header-browse-cta"
          onClick={() => setPathsDrawerOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={pathsDrawerOpen}
          aria-label={pathsAriaLabel}
          data-active={activeCategories.length > 0 ? 'true' : 'false'}
        >
          {pathsCtaText === null ? (
            <>
              <span className="num" aria-hidden="true">{defaultPathsCount}</span>
              <span aria-hidden="true">Paths</span>
            </>
          ) : (
            <span aria-hidden="true">{pathsCtaText}</span>
          )}
          <ChevronRight size={12} aria-hidden="true" />
        </button>

        <button
          type="button"
          className="lp-header-browse-cta"
          onClick={() => setFormatsDrawerOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={formatsDrawerOpen}
          aria-label={activeFormat === null ? '2 Formats' : FORMAT_LABEL[activeFormat]}
          data-active={activeFormat !== null ? 'true' : 'false'}
        >
          {activeFormat === null ? (
            <>
              <span className="num" aria-hidden="true">2</span>
              <span aria-hidden="true">Formats</span>
            </>
          ) : (
            <span aria-hidden="true">{FORMAT_LABEL[activeFormat]}</span>
          )}
          <ChevronRight size={12} aria-hidden="true" />
        </button>

        <button
          onClick={onSearch}
          style={{ background: 'transparent', border: 'none', color: 'var(--navy)', padding: 8, cursor: 'pointer' }}
          aria-label="Open search"
        >
          <Search size={20} />
        </button>
      </div>

      {/* Stage: video fills full space */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
        <FeedMediaDeck
          deckRef={feedDeckRef}
          currentCardRef={currentFeedCardRef}
          item={item}
          nextItem={null}
          blockColor={CATEGORY_BLOCK_BG[item.primaryCategory]}
          variant="mobile"
          direction={navDirection}
          reducedMotion={reducedMotion}
          isPlaying={isPlaying}
          isSaved={isSaved}
          activeRailFeedback={activeRailFeedback}
          audioRecoveryVisible={audioRecoveryVisible}
          autoplayMode={autoplayMode}
          onPlay={onPlay}
          onPause={onPause}
          onVideoEnd={onVideoEnd}
          onSave={onSave}
          onShare={onShare}
          onAudioRecovery={onAudioRecovery}
          onLearnMore={onInfo}
          onAutoplayModeChange={onAutoplayModeChange}
          onPlayerReady={onPlayerReady}
          onGumletAudioState={onGumletAudioState}
        />

        {/* floating action rail */}
        <div
          data-testid="mobile-overlay-rail"
          style={{
            position: 'absolute',
            right: 12,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            zIndex: 6,
          }}
        >
          <MobileRailBtn
            icon={Heart}
            label={isSaved ? 'Liked' : 'Like'}
            active={isSaved}
            onClick={onSave}
          />
          {audioRecoveryVisible && (
            <MobileRailBtn icon={Volume2} label="Sound" active onClick={onAudioRecovery} />
          )}
          <MobileRailBtn icon={Share2} label="Share" active={activeRailFeedback === 'share'} onClick={onShare} />
          <MobileRailBtn icon={Info} label="Info" active={activeRailFeedback === 'info'} onClick={onInfo} />
        </div>

        <LearnMoreCta format={item.format} variant="mobile" onClick={onLearnMore} />
      </div>
    </div>
  );
}

// ============================================================
// Media Stage (video / article poster)
// ============================================================
type MediaDeckCard = {
  item: LaunchpadContent;
  blockColor: string;
};

function FeedMediaDeck({
  deckRef,
  currentCardRef,
  item,
  nextItem,
  blockColor,
  variant,
  direction,
  reducedMotion,
  isPlaying,
  isSaved,
  activeRailFeedback,
  audioRecoveryVisible,
  autoplayMode,
  onPlay,
  onPause,
  onVideoEnd,
  onSave,
  onShare,
  onAudioRecovery,
  onLearnMore,
  onAutoplayModeChange,
  onPlayerReady,
  onGumletAudioState,
}: {
  deckRef: RefObject<HTMLDivElement | null>;
  currentCardRef: RefObject<HTMLDivElement | null>;
  item: LaunchpadContent;
  nextItem: LaunchpadContent | null;
  blockColor: string;
  variant: FeedMediaVariant;
  direction: FeedDirection;
  reducedMotion: boolean;
  isPlaying: boolean;
  isSaved: boolean;
  activeRailFeedback: RailFeedbackAction | null;
  audioRecoveryVisible: boolean;
  autoplayMode: AutoplayMode;
  onPlay: () => void;
  onPause: () => void;
  onVideoEnd: () => void;
  onSave: () => void;
  onShare: () => void;
  onAudioRecovery: () => void;
  onLearnMore: () => void;
  onAutoplayModeChange: (mode: AutoplayMode) => void;
  onPlayerReady: (player: FeedPlayerInstance | null) => void;
  onGumletAudioState: (state: GumletAudioState) => void;
}) {
  const [current, setCurrent] = useState<MediaDeckCard>({ item, blockColor });
  const [previous, setPrevious] = useState<MediaDeckCard | null>(null);
  const [transitionDirection, setTransitionDirection] = useState<FeedDirection>(direction);
  const [transitionPhase, setTransitionPhase] = useState<'idle' | 'prepare' | 'animating'>('idle');
  const incomingKey = `${item.id}|${blockColor}|${reducedMotion ? 'reduced' : 'motion'}`;
  const [renderedKey, setRenderedKey] = useState(incomingKey);

  if (renderedKey !== incomingKey) {
    setRenderedKey(incomingKey);
    if (current.item.id === item.id || reducedMotion) {
      setPrevious(null);
      setTransitionPhase('idle');
      setTransitionDirection(direction);
      setCurrent({ item, blockColor });
    } else {
      setPrevious(current);
      setTransitionDirection(direction);
      setTransitionPhase('prepare');
      setCurrent({ item, blockColor });
    }
  }

  useEffect(() => {
    if (transitionPhase !== 'prepare') return;

    const phaseTimer = window.setTimeout(() => setTransitionPhase('animating'), 16);
    const doneTimer = window.setTimeout(() => {
      setPrevious(null);
      setTransitionPhase('idle');
    }, FEED_TRANSITION_MS);

    return () => {
      window.clearTimeout(phaseTimer);
      window.clearTimeout(doneTimer);
    };
  }, [current.item.id, transitionPhase]);

  const transitioning = transitionPhase !== 'idle';
  const isMobileVariant = variant === 'mobile';
  const deckStyle: CSSProperties = isMobileVariant
    ? {
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        zIndex: 1,
        touchAction: 'none',
      }
    : {
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 0,
        borderRadius: 18,
        overflow: 'hidden',
        zIndex: 1,
        touchAction: 'none',
      };

  const cardStyle = (role: 'current' | 'previous'): CSSProperties => {
    const baseStyle: CSSProperties = isMobileVariant
      ? { position: 'absolute', inset: 0, outline: 'none' }
      : { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', outline: 'none' };

    if (!transitioning || reducedMotion) {
      return { ...baseStyle, transform: 'translate3d(0, 0, 0)', opacity: 1 };
    }

    const enteringFrom = transitionDirection === 'next' ? '100%' : '-100%';
    const exitingTo = transitionDirection === 'next' ? '-100%' : '100%';
    const isPreparing = transitionPhase === 'prepare';

    return {
      ...baseStyle,
      transform:
        role === 'current'
          ? `translate3d(0, ${isPreparing ? enteringFrom : '0'}, 0)`
          : `translate3d(0, ${isPreparing ? '0' : exitingTo}, 0)`,
      opacity: role === 'current' ? 1 : isPreparing ? 1 : 0.35,
      transition: isPreparing
        ? 'none'
        : `transform ${FEED_TRANSITION_MS}ms var(--ease-out), opacity ${FEED_TRANSITION_MS}ms var(--ease-out)`,
      pointerEvents: role === 'current' ? 'auto' : 'none',
      zIndex: role === 'current' ? 2 : 1,
    };
  };

  return (
    <div
      ref={deckRef}
      data-testid="feed-media-deck"
      data-transitioning={transitioning ? 'true' : 'false'}
      style={deckStyle}
    >
      {previous && (
        <div data-testid={`feed-media-card-${previous.item.id}`} style={cardStyle('previous')}>
          <MediaStage
            item={previous.item}
            nextItem={null}
            variant={variant}
            isPlaying={false}
            autoplayMode={autoplayMode}
            onPlay={onPlay}
            onPause={onPause}
            onVideoEnd={onVideoEnd}
            onAutoplayModeChange={onAutoplayModeChange}
            onPlayerReady={onPlayerReady}
            onGumletAudioState={onGumletAudioState}
          />
        </div>
      )}
      <div
        ref={currentCardRef}
        data-testid={`feed-media-card-${current.item.id}`}
        data-current="true"
        aria-current="true"
        tabIndex={-1}
        style={cardStyle('current')}
      >
        <MediaStage
          item={current.item}
          nextItem={nextItem}
          variant={variant}
          isPlaying={isPlaying}
          autoplayMode={autoplayMode}
          onPlay={onPlay}
          onPause={onPause}
          onVideoEnd={onVideoEnd}
          onAutoplayModeChange={onAutoplayModeChange}
          onPlayerReady={onPlayerReady}
          onGumletAudioState={onGumletAudioState}
          onArticleOutbound={(href) =>
            trackEvent('outbound_click', {
              contentId: current.item.id,
              metadata: { href },
            })
          }
        />
      </div>
      {!isMobileVariant && (
        <DesktopOverlayRail
          isSaved={isSaved}
          activeRailFeedback={activeRailFeedback}
          audioRecoveryVisible={audioRecoveryVisible}
          onSave={onSave}
          onShare={onShare}
          onAudioRecovery={onAudioRecovery}
          onLearnMore={onLearnMore}
        />
      )}
    </div>
  );
}

function DesktopOverlayRail({
  isSaved,
  activeRailFeedback,
  audioRecoveryVisible,
  onSave,
  onShare,
  onAudioRecovery,
  onLearnMore,
}: {
  isSaved: boolean;
  activeRailFeedback: RailFeedbackAction | null;
  audioRecoveryVisible: boolean;
  onSave: () => void;
  onShare: () => void;
  onAudioRecovery: () => void;
  onLearnMore?: () => void;
}) {
  return (
    <div
      data-testid="desktop-overlay-rail"
      style={{
        position: 'absolute',
        right: 'clamp(16px, 2vw, 28px)',
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        alignItems: 'center',
        zIndex: 6,
      }}
    >
      <DesktopRailBtn
        icon={Heart}
        label={isSaved ? 'Liked' : 'Like'}
        active={isSaved}
        onClick={onSave}
      />
      {audioRecoveryVisible && (
        <DesktopRailBtn icon={Volume2} label="Sound" active onClick={onAudioRecovery} />
      )}
      <DesktopRailBtn icon={Share2} label="Share" active={activeRailFeedback === 'share'} onClick={onShare} />
      {onLearnMore && (
        <DesktopRailBtn icon={Info} label="Info" active={activeRailFeedback === 'info'} onClick={onLearnMore} />
      )}
    </div>
  );
}

function YouTubePlayer({
  videoId,
  title,
  autoplayMode,
  onAutoplayModeChange,
  onVideoEnd,
  onPlayerReady,
}: {
  videoId: string;
  title: string;
  autoplayMode: AutoplayMode;
  onAutoplayModeChange: (mode: AutoplayMode) => void;
  onVideoEnd: () => void;
  onPlayerReady: (player: FeedPlayerInstance | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const playedRef = useRef(false);
  const endedRef = useRef(false);
  const fallbackTimerRef = useRef<number | null>(null);
  const initialAutoplayModeRef = useRef(autoplayMode);
  const [hasPlayed, setHasPlayed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let hostElement: HTMLDivElement | null = null;

    const clearFallbackTimer = () => {
      if (fallbackTimerRef.current) {
        window.clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };

    const fallbackToMuted = () => {
      const player = playerRef.current;
      if (!player) return;
      player.mute();
      onAutoplayModeChange('muted-fallback');
      player.playVideo();
    };

    const createPlayer = (YT: YouTubeNamespace) => {
      const host = hostRef.current;
      if (cancelled || !host) return;
      hostElement = host;
      host.textContent = '';
      const playerMount = document.createElement('div');
      Object.assign(playerMount.style, {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
      });
      host.appendChild(playerMount);

      const player = new YT.Player(playerMount, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 0,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            const policy = window.navigator.getAutoplayPolicy?.('mediaelement');
            const shouldStartMuted = initialAutoplayModeRef.current === 'muted-fallback' || policy === 'allowed-muted';
            if (shouldStartMuted) {
              player.mute();
              onAutoplayModeChange('muted-fallback');
            } else {
              player.unMute?.();
            }
            player.playVideo();
            fallbackTimerRef.current = window.setTimeout(() => {
              if (!playedRef.current) fallbackToMuted();
            }, 900);
            const iframe = hostRef.current?.querySelector('iframe');
            iframe?.setAttribute('tabindex', '-1');
            iframe?.setAttribute('title', title);
            if (iframe) {
              Object.assign(iframe.style, {
                position: 'absolute',
                inset: '0',
                width: '100%',
                height: '100%',
                border: '0px',
                display: 'block',
              });
            }
          },
          onStateChange: (event) => {
            if (event.data === YT.PlayerState.PLAYING) {
              playedRef.current = true;
              setHasPlayed(true);
              clearFallbackTimer();
            } else if (event.data === YT.PlayerState.ENDED && !endedRef.current) {
              endedRef.current = true;
              clearFallbackTimer();
              onVideoEnd();
            }
          },
          onAutoplayBlocked: fallbackToMuted,
        },
      });

      playerRef.current = player;
      onPlayerReady(player);
    };

    if (window.YT?.Player) createPlayer(window.YT);
    else loadYouTubeIframeAPI().then(createPlayer);

    return () => {
      cancelled = true;
      clearFallbackTimer();
      playerRef.current?.destroy();
      playerRef.current = null;
      onPlayerReady(null);
      if (hostElement) hostElement.textContent = '';
    };
  }, [onAutoplayModeChange, onPlayerReady, onVideoEnd, title, videoId]);

  return (
    <div
      ref={hostRef}
      data-testid={`youtube-host-${videoId}`}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        opacity: hasPlayed ? 1 : 0,
        overflow: 'hidden',
        transition: 'opacity 160ms var(--ease-standard)',
        pointerEvents: 'none',
      }}
    />
  );
}

function EmbeddedVideoPlayer({
  source,
  contentId,
  title,
  autoplayMode,
  onAutoplayModeChange,
  onVideoEnd,
  onPlayerReady,
  onGumletAudioState,
}: {
  source: VideoSource;
  contentId: string;
  title: string;
  autoplayMode: AutoplayMode;
  onAutoplayModeChange: (mode: AutoplayMode) => void;
  onVideoEnd: () => void;
  onPlayerReady: (player: FeedPlayerInstance | null) => void;
  onGumletAudioState: (state: GumletAudioState) => void;
}) {
  if (source.provider === 'youtube') {
    return (
      <YouTubePlayer
        videoId={source.id}
        title={title}
        autoplayMode={autoplayMode}
        onAutoplayModeChange={onAutoplayModeChange}
        onPlayerReady={onPlayerReady}
        onVideoEnd={onVideoEnd}
      />
    );
  }

  return (
    <GumletVideoPlayer
      contentId={contentId}
      videoId={source.id}
      title={title}
      autoplayMode={autoplayMode}
      onAutoplayModeChange={onAutoplayModeChange}
      onPlayerReady={onPlayerReady}
      onGumletAudioState={onGumletAudioState}
      onVideoEnd={onVideoEnd}
    />
  );
}

function GumletVideoPlayer({
  contentId,
  videoId,
  title,
  autoplayMode,
  onAutoplayModeChange,
  onVideoEnd,
  onPlayerReady,
  onGumletAudioState,
}: {
  contentId: string;
  videoId: string;
  title: string;
  autoplayMode: AutoplayMode;
  onAutoplayModeChange: (mode: AutoplayMode) => void;
  onVideoEnd: () => void;
  onPlayerReady: (player: FeedPlayerInstance | null) => void;
  onGumletAudioState: (state: GumletAudioState) => void;
}) {
  const playerRef = useRef<GumletPlayerHandle | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const playedRef = useRef(false);
  const endedRef = useRef(false);
  const initialAutoplayModeRef = useRef(autoplayMode);
  const [initialMuted] = useState(() => autoplayMode === 'muted-fallback');
  const [hasPlayed, setHasPlayed] = useState(false);

  const clearFallbackTimer = useCallback(() => {
    if (!fallbackTimerRef.current) return;
    window.clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = null;
  }, []);

  const reportAudioState = useCallback(async () => {
    const player = playerRef.current;
    if (!player) return;

    const [muted, volume] = await Promise.all([player.getMuted(), player.getVolume()]);
    onGumletAudioState({ contentId, muted, volume });
  }, [contentId, onGumletAudioState]);

  const fallbackToMuted = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    player.mute();
    onAutoplayModeChange('muted-fallback');
    player.play();
  }, [onAutoplayModeChange]);

  useEffect(() => {
    return () => {
      clearFallbackTimer();
      onPlayerReady(null);
    };
  }, [clearFallbackTimer, onPlayerReady]);

  const handleReady = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;

    const policy = window.navigator.getAutoplayPolicy?.('mediaelement');
    const shouldStartMuted = initialAutoplayModeRef.current === 'muted-fallback' || policy === 'allowed-muted';
    if (shouldStartMuted) {
      player.mute();
      onAutoplayModeChange('muted-fallback');
    } else {
      player.unmute();
      player.setVolume(100);
    }

    player.play();
    void reportAudioState();
    fallbackTimerRef.current = window.setTimeout(() => {
      if (!playedRef.current) fallbackToMuted();
    }, 900);
    onPlayerReady({
      playVideo: () => player.play(),
      pauseVideo: () => player.pause(),
      mute: () => player.mute(),
      unMute: () => player.unmute(),
      setVolume: (volume: number) => player.setVolume(volume),
      getMuted: () => player.getMuted(),
      getVolume: () => player.getVolume(),
    });
  }, [fallbackToMuted, onAutoplayModeChange, onPlayerReady, reportAudioState]);

  const handlePlay = useCallback(() => {
    playedRef.current = true;
    setHasPlayed(true);
    clearFallbackTimer();
    void reportAudioState();
  }, [clearFallbackTimer, reportAudioState]);

  const handleVolumeChange = useCallback(
    (event: { muted?: boolean; volume?: number }) => {
      if (typeof event.muted === 'boolean' && typeof event.volume === 'number') {
        onGumletAudioState({ contentId, muted: event.muted, volume: event.volume });
        return;
      }

      void reportAudioState();
    },
    [contentId, onGumletAudioState, reportAudioState]
  );

  const handleEnded = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    clearFallbackTimer();
    onVideoEnd();
  }, [clearFallbackTimer, onVideoEnd]);

  return (
    <div
      data-testid={`gumlet-host-${videoId}`}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        opacity: hasPlayed ? 1 : 0,
        overflow: 'hidden',
        transition: 'opacity 160ms var(--ease-standard)',
        pointerEvents: 'none',
      }}
    >
      <GumletPlayer
        ref={playerRef}
        videoID={videoId}
        title={title}
        autoplay={false}
        preload
        muted={initialMuted}
        background={false}
        loop={false}
        disable_player_controls={false}
        onReady={handleReady}
        onPlay={handlePlay}
        onVolumeChange={handleVolumeChange}
        onEnded={handleEnded}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        iframeStyle={{
          border: 'none',
          position: 'absolute',
          top: 0,
          left: 0,
          height: '100%',
          width: '100%',
          display: 'block',
        }}
      />
    </div>
  );
}

function ArticleCardLayer({
  title,
  mobile,
  href,
  onOutbound,
}: {
  title: string;
  mobile: boolean;
  href?: string;
  onOutbound?: (href: string) => void;
}) {
  const style: CSSProperties = {
    position: 'absolute',
    inset: 0,
    padding: mobile ? '20px 20px calc(136px + env(safe-area-inset-bottom))' : '32px 20px 104px',
    display: 'flex',
    alignItems: mobile ? 'flex-end' : undefined,
    flexDirection: mobile ? undefined : 'column',
    justifyContent: mobile ? undefined : 'flex-end',
    color: 'var(--white)',
    textDecoration: 'none',
    zIndex: 4,
  };
  const copy = (
    <div data-testid="media-article-copy">
      {!mobile && (
        <div
          aria-hidden="true"
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            opacity: 0.85,
            marginBottom: 10,
          }}
        >
          The read
        </div>
      )}
      <div style={{ fontSize: 22, fontWeight: 900, lineHeight: 1.15, letterSpacing: '-0.01em' }}>{title}</div>
    </div>
  );

  if (href && onOutbound) {
    return (
      <a
        className="media-article-activator"
        data-feed-activator="true"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => onOutbound(href)}
        style={style}
      >
        {copy}
      </a>
    );
  }

  return <div style={style}>{copy}</div>;
}

function MediaStage({
  item,
  nextItem,
  variant,
  isPlaying,
  autoplayMode,
  onPlay,
  onPause,
  onAutoplayModeChange,
  onPlayerReady,
  onGumletAudioState,
  onVideoEnd,
  onArticleOutbound,
}: {
  item: LaunchpadContent;
  nextItem: LaunchpadContent | null;
  variant: FeedMediaVariant;
  isPlaying: boolean;
  autoplayMode: AutoplayMode;
  onPlay: () => void;
  onPause: () => void;
  onAutoplayModeChange: (mode: AutoplayMode) => void;
  onPlayerReady: (player: FeedPlayerInstance | null) => void;
  onGumletAudioState: (state: GumletAudioState) => void;
  onVideoEnd: () => void;
  onArticleOutbound?: (href: string) => void;
}) {
  const progressTracked = useRef(new Set<number>());
  const videoSource = getVideoSource(item.mediaUrl);
  const isPlayableVideo = item.format === 'video' && Boolean(videoSource);
  const isMobileVariant = variant === 'mobile';
  const articleUrl = item.format === 'article' ? item.articleUrl : undefined;

  // Video progress milestones
  useEffect(() => {
    progressTracked.current.clear();
  }, [item.id]);

  useEffect(() => {
    if (!isPlaying || item.format !== 'video') return;
    const duration = item.durationSeconds ?? 90;
    trackEvent('video_play', {
      contentId: item.id,
      metadata: { provider: videoSource?.provider, format: item.format, durationSeconds: duration },
    });
    let elapsed = 0;
    const timer = window.setInterval(() => {
      elapsed += 5;
      const progress = Math.min(100, Math.round((elapsed / duration) * 100));
      [25, 50, 80].forEach((milestone) => {
        if (progress >= milestone && !progressTracked.current.has(milestone)) {
          progressTracked.current.add(milestone);
          trackEvent('video_progress', {
            contentId: item.id,
            metadata: { milestone, provider: videoSource?.provider, format: item.format, durationSeconds: duration },
          });
        }
      });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [item, isPlaying, videoSource?.provider]);

  if (isMobileVariant) {
    return (
      <div style={{ position: 'absolute', inset: 0, background: 'var(--navy)' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.thumbnailUrl}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(8, 8, 26, 0.5)',
          }}
        />
        <FormatBadge type={item.format} top={12} left={14} />
        {isPlayableVideo && !isPlaying && (
          <button
            onClick={onPlay}
            style={{
              position: 'absolute',
              inset: 0,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'grid',
              placeItems: 'center',
              zIndex: 3,
            }}
            aria-label={`Play ${item.title}`}
          >
            <div
              style={{
                width: 76,
                height: 76,
                borderRadius: 999,
                background: 'var(--primary-blue)',
                display: 'grid',
                placeItems: 'center',
                boxShadow: '0 10px 30px rgba(0,146,255,0.55)',
              }}
            >
              <Play size={32} style={{ color: 'var(--white)', marginLeft: 3 }} />
            </div>
          </button>
        )}
        {isPlayableVideo && isPlaying && videoSource && (
          <>
            <EmbeddedVideoPlayer
              source={videoSource}
              contentId={item.id}
              title={item.title}
              autoplayMode={autoplayMode}
              onAutoplayModeChange={onAutoplayModeChange}
              onPlayerReady={onPlayerReady}
              onGumletAudioState={onGumletAudioState}
              onVideoEnd={onVideoEnd}
            />
            <div
              data-testid="youtube-scroll-overlay"
              aria-hidden="true"
              onClick={() => onPause()}
              style={{ position: 'absolute', inset: 0, zIndex: 4, cursor: 'pointer' }}
            />
          </>
        )}
        {item.format === 'article' && (
          <ArticleCardLayer
            title={item.title}
            mobile
            href={articleUrl}
            onOutbound={onArticleOutbound}
          />
        )}
      </div>
    );
  }

  // Desktop 9:16 stage
  return (
    <div
      data-testid="desktop-immersive-media-frame"
      style={{
        position: 'relative',
        aspectRatio: '9 / 16',
        height: 'min(calc(100dvh - 214px), 1040px)',
        maxHeight: 'calc(100% - 56px)',
        maxWidth: 'calc(100% - 132px)',
        width: 'auto',
        margin: '0 auto',
        overflow: 'visible',
        transform: 'translateY(-14px)',
        zIndex: 2,
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          background: 'var(--navy)',
          zIndex: 1,
          borderRadius: 16,
          boxShadow: '0 30px 60px rgba(34,34,76,0.18)',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.thumbnailUrl}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(8, 8, 26, 0.5)',
          }}
        />
        {isPlayableVideo && !isPlaying && (
          <button
            onClick={onPlay}
            style={{
              position: 'absolute',
              inset: 0,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'grid',
              placeItems: 'center',
              zIndex: 3,
            }}
            aria-label={`Play ${item.title}`}
          >
            <div
              style={{
                width: 80,
                height: 80,
                borderRadius: 999,
                background: 'var(--primary-blue)',
                display: 'grid',
                placeItems: 'center',
                boxShadow: '0 10px 30px rgba(0,146,255,0.6)',
              }}
            >
              <Play size={32} style={{ color: 'var(--white)', marginLeft: 4 }} />
            </div>
          </button>
        )}
        {isPlayableVideo && isPlaying && videoSource && (
          <>
            <EmbeddedVideoPlayer
              source={videoSource}
              contentId={item.id}
              title={item.title}
              autoplayMode={autoplayMode}
              onAutoplayModeChange={onAutoplayModeChange}
              onPlayerReady={onPlayerReady}
              onGumletAudioState={onGumletAudioState}
              onVideoEnd={onVideoEnd}
            />
            <div
              data-testid="youtube-scroll-overlay"
              aria-hidden="true"
              onClick={() => onPause()}
              style={{ position: 'absolute', inset: 0, zIndex: 4, cursor: 'pointer' }}
            />
          </>
        )}
        {item.format === 'video' && !isPlaying && item.durationSeconds && (
          <div
            style={{
              position: 'absolute',
              top: 14,
              left: 14,
              right: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              zIndex: 3,
            }}
          >
            <div
              style={{
                flex: 1,
                height: 3,
                background: 'rgba(255,255,255,0.25)',
                borderRadius: 999,
              }}
            />
            <span
              style={{
                color: 'var(--white)',
                fontSize: 11,
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              0:00 / {formatDuration(item.durationSeconds)}
            </span>
          </div>
        )}
        {item.format === 'article' && (
          <ArticleCardLayer
            title={item.title}
            mobile={false}
            href={articleUrl}
            onOutbound={onArticleOutbound}
          />
        )}
      </div>
      {nextItem && (
        <div
          data-testid="desktop-next-card-peek"
          data-next-slug={nextItem.slug}
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 'calc(100% + 24px)',
            left: '50%',
            width: '90%',
            aspectRatio: '9 / 16',
            transform: 'translateX(-50%)',
            overflow: 'hidden',
            borderRadius: 14,
            background: 'var(--navy)',
            opacity: 0.82,
            zIndex: 0,
            boxShadow: '0 22px 42px rgba(8,8,26,0.26)',
            pointerEvents: 'none',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={nextItem.thumbnailUrl}
            alt=""
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'saturate(0.9)',
            }}
          />
        </div>
      )}
    </div>
  );
}

// ============================================================
// Highlighted title — wrap longest >4-letter word in accent block
// ============================================================
function HighlightedTitle({ title, accent }: { title: string; accent: string }) {
  const { words, bestIdx } = useMemo(() => {
    const ws = title.split(' ');
    let idx = 0;
    let best = 0;
    ws.forEach((w, i) => {
      const clean = w.replace(/[^a-zA-Z]/g, '');
      if (clean.length > best && clean.length > 4) {
        best = clean.length;
        idx = i;
      }
    });
    return { words: ws, bestIdx: idx };
  }, [title]);

  return (
    <>
      {words.map((w, i) => (
        <span key={i}>
          {i === bestIdx ? (
            <span
              style={{
                display: 'inline-block',
                background: accent,
                color: 'var(--white)',
                padding: '0.02em 0.14em 0.08em',
                lineHeight: 0.92,
                verticalAlign: 'baseline',
                boxDecorationBreak: 'clone',
                WebkitBoxDecorationBreak: 'clone',
              }}
            >
              {w}
            </span>
          ) : (
            w
          )}
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
  );
}

// ============================================================
// Smaller building blocks
// ============================================================
function FormatBadge({ type, top, left }: { type: ContentFormat; top: number; left: number }) {
  const Cmp = FORMAT_ICON[type];
  return (
    <div data-testid="media-format-badge" style={{ position: 'absolute', top, left, zIndex: 3 }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'rgba(34, 34, 76, 0.78)',
          border: '1px solid rgba(255, 255, 255, 0.18)',
          color: 'var(--white)',
          fontSize: 11,
          fontWeight: 700,
          padding: '4px 10px',
          borderRadius: 999,
          letterSpacing: '0.02em',
        }}
      >
        <Cmp size={13} />
        {FORMAT_LABEL[type]}
      </span>
    </div>
  );
}

function FormatPill({ type }: { type: ContentFormat }) {
  const Cmp = FORMAT_ICON[type];
  return (
    <div
      data-testid="desktop-format-pill"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        border: '1px solid var(--border-1)',
        background: 'var(--white)',
        color: 'var(--navy)',
        padding: '6px 12px',
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        borderRadius: 999,
        boxShadow: '0 4px 14px rgba(34,34,76,0.06)',
      }}
    >
      <Cmp size={13} />
      {FORMAT_LABEL[type]}
    </div>
  );
}

function DesktopRailBtn({
  icon: IconCmp,
  label,
  ariaLabel,
  active,
  disabled = false,
  onClick,
  title,
  testId,
}: {
  icon: IconCmp;
  label: string;
  ariaLabel?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  testId?: string;
}) {
  return (
    <button
      className="lp-overlay-rail-button"
      onPointerDown={stopRailEvent}
      onTouchStart={stopRailEvent}
      onClick={(event) => {
        stopRailEvent(event);
        onClick?.();
      }}
      aria-label={ariaLabel ?? label}
      aria-disabled={disabled ? 'true' : 'false'}
      disabled={disabled}
      title={title}
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      style={{
        background: 'transparent',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: 0,
        color: 'var(--white)',
        textShadow: '0 1px 5px rgba(0,0,0,0.75)',
        opacity: disabled ? 0.42 : 1,
      }}
    >
      <span
        style={{
          width: 56,
          height: 56,
          borderRadius: 999,
          background: active ? 'var(--primary-blue)' : 'rgba(8,8,26,0.62)',
          border: `1px solid ${active ? 'var(--primary-blue)' : 'rgba(255,255,255,0.22)'}`,
          color: 'var(--white)',
          display: 'grid',
          placeItems: 'center',
          transition: 'background 160ms var(--ease-standard), border-color 160ms var(--ease-standard)',
          boxShadow: '0 8px 20px rgba(0,0,0,0.24)',
          backdropFilter: 'blur(10px)',
        }}
      >
        <IconCmp size={21} fill={active ? 'currentColor' : 'none'} />
      </span>
      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.01em' }}>{label}</span>
    </button>
  );
}

function MobileRailBtn({
  icon: IconCmp,
  label,
  ariaLabel,
  active,
  disabled = false,
  onClick,
  title,
  testId,
}: {
  icon: IconCmp;
  label: string;
  ariaLabel?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  testId?: string;
}) {
  return (
    <button
      onPointerDown={stopRailEvent}
      onTouchStart={stopRailEvent}
      onClick={(event) => {
        stopRailEvent(event);
        onClick?.();
      }}
      aria-label={ariaLabel ?? label}
      aria-disabled={disabled ? 'true' : 'false'}
      disabled={disabled}
      title={title}
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      style={{
        background: 'transparent',
        border: 'none',
        cursor: disabled || !onClick ? 'default' : 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        opacity: disabled ? 0.46 : 1,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 999,
          background: active ? 'var(--primary-blue)' : 'rgba(255,255,255,0.85)',
          backdropFilter: 'blur(8px)',
          display: 'grid',
          placeItems: 'center',
          color: active ? 'var(--white)' : 'var(--navy)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}
      >
        <IconCmp size={18} fill={active ? 'currentColor' : 'none'} />
      </div>
      <span
        style={{
          fontSize: 9,
          fontWeight: 800,
          color: 'var(--white)',
          textShadow: '0 1px 3px rgba(0,0,0,0.5)',
          letterSpacing: '0.02em',
        }}
      >
        {label}
      </span>
    </button>
  );
}

function Meta({ icon: IconCmp, label }: { icon: IconCmp; label: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <IconCmp size={13} />
      {label}
    </span>
  );
}

// ============================================================
// Spotlight Search Modal
// ============================================================
function SearchModal({
  content,
  categories,
  mobile,
  onClose,
  onPick,
  onSearchQuery,
}: {
  content: LaunchpadContent[];
  categories: LaunchpadCategory[];
  mobile: boolean;
  onClose: () => void;
  onPick: (item: LaunchpadContent, analytics?: { query: string; resultCount: number; rank: number }) => void;
  onSearchQuery: (query: string, resultCount: number) => void;
}) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const lastTrackedQueryRef = useRef<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey as unknown as EventListener);
    return () => window.removeEventListener('keydown', onKey as unknown as EventListener);
  }, [onClose]);

  const results = useMemo(() => {
    if (!q.trim()) return content.slice(0, 6);
    const needle = q.trim().toLowerCase();
    return content.filter((entry) =>
      [entry.title, entry.description, ...entry.categories, entry.format]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [content, q]);

  const sanitizedQuery = useMemo(() => sanitizeSearchQuery(q), [q]);

  useEffect(() => {
    if (!sanitizedQuery) return;

    const timer = window.setTimeout(() => {
      if (lastTrackedQueryRef.current === sanitizedQuery) return;
      lastTrackedQueryRef.current = sanitizedQuery;
      onSearchQuery(sanitizedQuery, results.length);
    }, 400);

    return () => window.clearTimeout(timer);
  }, [onSearchQuery, results.length, sanitizedQuery]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(8,8,26,0.6)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        justifyContent: 'center',
        paddingTop: mobile ? '6vh' : '12vh',
        zIndex: 2000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: mobile ? '92%' : 'min(680px, 92%)',
          height: 'fit-content',
          background: 'var(--white)',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 30px 80px rgba(0,0,0,0.4)',
          border: '1px solid var(--border-1)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '18px 20px',
            borderBottom: '1px solid var(--border-1)',
          }}
        >
          <Search size={20} style={{ color: 'var(--neutral-5)' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search careers, skills, articles…"
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 18,
              color: 'var(--navy)',
              fontFamily: 'inherit',
              fontWeight: 500,
            }}
          />
          <span
            style={{
              fontSize: 11,
              padding: '4px 8px',
              border: '1px solid var(--border-1)',
              borderRadius: 6,
              color: 'var(--neutral-5)',
              fontWeight: 700,
            }}
          >
            ESC
          </span>
        </div>
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {results.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--neutral-5)' }}>
              No matches yet. Try &ldquo;internship&rdquo; or &ldquo;feedback&rdquo;.
            </div>
          ) : (
            results.map((entry, index) => (
              <button
                key={entry.id}
                data-testid="search-result"
                data-format={entry.format}
                onClick={() =>
                  onPick(
                    entry,
                    sanitizedQuery ? { query: sanitizedQuery, resultCount: results.length, rank: index + 1 } : undefined
                  )
                }
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  width: '100%',
                  padding: '14px 20px',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--navy)',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                  borderBottom: '1px solid var(--border-1)',
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 60,
                    borderRadius: 6,
                    overflow: 'hidden',
                    background: 'var(--navy)',
                    flexShrink: 0,
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={entry.thumbnailUrl}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>{entry.title}</div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--neutral-5)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span>{entry.format}</span> · <span>{categoryLabel(categories, entry.primaryCategory)}</span>
                  </div>
                </div>
                <ArrowUpRight size={16} style={{ color: 'var(--neutral-5)' }} />
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Toast
// ============================================================
function Toast({ message, show }: { message: string | null; show: boolean }) {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: `translateX(-50%) translateY(${show ? 0 : 20}px)`,
        opacity: show ? 1 : 0,
        background: 'var(--navy)',
        color: 'var(--white)',
        padding: '12px 20px',
        borderRadius: 12,
        fontSize: 14,
        fontWeight: 600,
        boxShadow: 'var(--shadow-lg)',
        pointerEvents: 'none',
        transition: 'opacity 200ms, transform 200ms',
        zIndex: 9999,
        whiteSpace: 'nowrap',
      }}
    >
      {message}
    </div>
  );
}

// ============================================================
// Feed onboarding
// ============================================================
function FeedOnboardingDialog({
  mobile,
  reducedMotion,
  onDismiss,
}: {
  mobile: boolean;
  reducedMotion: boolean;
  onDismiss: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onDismiss();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      data-testid="feed-onboarding-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2500,
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'rgba(8, 8, 26, 0.48)',
        backdropFilter: 'blur(6px)',
        animation: reducedMotion ? undefined : 'lp-fade-in 180ms var(--ease-standard)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feed-onboarding-title"
        data-testid="feed-onboarding-dialog"
        style={{
          width: 'min(420px, 100%)',
          borderRadius: 18,
          border: '1px solid rgba(217, 223, 234, 0.96)',
          background: 'var(--white)',
          color: 'var(--navy)',
          boxShadow: '0 24px 70px rgba(8, 8, 26, 0.28)',
          padding: mobile ? 24 : 28,
          textAlign: 'center',
        }}
      >
        <FeedOnboardingVisual mobile={mobile} />
        <h2 id="feed-onboarding-title" style={{ margin: '0 0 10px', fontSize: 24, lineHeight: 1.15, fontWeight: 900 }}>
          Hey, you can scroll.
        </h2>
        <p style={{ margin: '0 0 22px', color: 'var(--neutral-5)', fontSize: 15, lineHeight: 1.55 }}>
          {mobile
            ? 'Swipe up or down to move through the feed. If swiping ever feels stuck, use the up and down arrows beside the social icons.'
            : 'Use the ↑ and ↓ arrow keys, or swipe with your touchpad, to move through the feed.'}
        </p>
        <button
          ref={buttonRef}
          type="button"
          onClick={onDismiss}
          style={{
            minWidth: 132,
            height: 46,
            border: 0,
            borderRadius: 14,
            background: 'var(--primary-blue)',
            color: 'var(--white)',
            fontSize: 14,
            fontWeight: 800,
            cursor: 'pointer',
            boxShadow: '0 10px 24px -10px rgba(0, 146, 255, 0.65)',
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}

function FeedOnboardingVisual({ mobile }: { mobile: boolean }) {
  if (mobile) {
    return (
      <div
        aria-hidden
        data-testid="feed-onboarding-swipe-cue"
        style={{
          width: 66,
          height: 78,
          margin: '0 auto 16px',
          borderRadius: 24,
          display: 'grid',
          placeItems: 'center',
          background: 'var(--secondary-blue-pale)',
          color: 'var(--primary-blue)',
        }}
      >
        <div
          style={{
            display: 'grid',
            justifyItems: 'center',
            gap: 2,
          }}
        >
          <ChevronUp size={18} strokeWidth={3} />
          <span
            style={{
              width: 3,
              height: 24,
              borderRadius: 999,
              background: 'currentColor',
              opacity: 0.72,
            }}
          />
          <ChevronDown size={18} strokeWidth={3} />
        </div>
      </div>
    );
  }

  return (
    <div
      aria-hidden
      data-testid="feed-onboarding-keycap-visual"
      style={{
        width: 118,
        height: 104,
        margin: '0 auto 18px',
        borderRadius: 30,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--secondary-blue-pale)',
        color: 'var(--primary-blue)',
      }}
    >
      <div
        style={{
          display: 'grid',
          gap: 8,
        }}
      >
        <FeedOnboardingKeycap label="↑" testId="feed-onboarding-keycap-up" />
        <FeedOnboardingKeycap label="↓" testId="feed-onboarding-keycap-down" />
      </div>
    </div>
  );
}

function FeedOnboardingKeycap({ label, testId }: { label: string; testId: string }) {
  return (
    <span
      data-testid={testId}
      style={{
        width: 54,
        height: 38,
        borderRadius: 11,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--white)',
        border: '1px solid rgba(0, 146, 255, 0.2)',
        boxShadow:
          '0 8px 18px rgba(0, 146, 255, 0.18), inset 0 -4px 0 rgba(34, 34, 76, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.96)',
        color: 'var(--primary-blue)',
        fontSize: 24,
        fontWeight: 900,
        lineHeight: 1,
      }}
    >
      {label}
    </span>
  );
}

// ============================================================
// Empty state — when filter+search produces no items
// ============================================================
function EmptyState({ onClear }: { onClear: () => void }) {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 32,
        background: 'var(--off-white)',
      }}
    >
      <div
        style={{
          textAlign: 'center',
          maxWidth: 380,
          background: 'var(--white)',
          padding: 40,
          borderRadius: 16,
          border: '1px solid var(--border-1)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <Sparkles size={32} style={{ color: 'var(--primary-blue)' }} />
        <h2 style={{ margin: '12px 0 8px', fontSize: 22, fontWeight: 900 }}>No matches yet</h2>
        <p style={{ color: 'var(--neutral-5)', margin: '0 0 20px', fontSize: 14 }}>
          Clear a filter or try a broader search to keep exploring.
        </p>
        <button
          onClick={onClear}
          style={{
            background: 'var(--primary-blue)',
            color: 'var(--white)',
            border: 'none',
            padding: '12px 20px',
            borderRadius: 12,
            fontSize: 14,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Clear filters
        </button>
      </div>
    </main>
  );
}

// ============================================================
// Helpers
// ============================================================
function pullQuoteFor(item: LaunchpadContent): string {
  return item.learnMore.takeaway ?? item.description;
}
