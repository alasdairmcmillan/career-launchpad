import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureCategories, fixtureContent } from '@/test/fixtures/content';
import type { AnalyticsEvent, LaunchpadContent } from '@/types';

import { FEED_ONBOARDING_SEEN_KEY, isFeedOnboardingSeen, LaunchpadApp } from './LaunchpadApp';

const { replaceMock, gumletPlayers } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  gumletPlayers: [] as Array<{
    videoID: string;
    props: Record<string, unknown>;
    muted: boolean;
    volume: number;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    mute: ReturnType<typeof vi.fn>;
    unmute: ReturnType<typeof vi.fn>;
    setVolume: ReturnType<typeof vi.fn>;
    getMuted: ReturnType<typeof vi.fn>;
    getVolume: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock('@gumlet/react-embed-player', async () => {
  const React = await vi.importActual<typeof import('react')>('react');

  return {
    GumletPlayer: React.forwardRef(function MockGumletPlayer(
      props: { videoID?: string; [key: string]: unknown },
      ref
    ) {
      const videoID = props.videoID ?? '';
      const record = React.useMemo(() => {
        const entry = {
          videoID,
          props,
          muted: props.muted === true,
          volume: 100,
          play: vi.fn(),
          pause: vi.fn(),
          mute: vi.fn(),
          unmute: vi.fn(),
          setVolume: vi.fn(),
          getMuted: vi.fn(),
          getVolume: vi.fn(),
        };

        entry.mute.mockImplementation(() => {
          entry.muted = true;
        });
        entry.unmute.mockImplementation(() => {
          entry.muted = false;
        });
        entry.setVolume.mockImplementation((volume: number) => {
          entry.volume = volume;
        });
        entry.getMuted.mockImplementation(() => Promise.resolve(entry.muted));
        entry.getVolume.mockImplementation(() => Promise.resolve(entry.volume));

        return entry;
      }, [props, videoID]);

      React.useImperativeHandle(ref, () => ({
        play: record.play,
        pause: record.pause,
        mute: record.mute,
        unmute: record.unmute,
        setVolume: record.setVolume,
        getMuted: record.getMuted,
        getVolume: record.getVolume,
      }));

      React.useEffect(() => {
        gumletPlayers.push(record);
      }, [record]);

      return React.createElement('iframe', {
        'data-testid': `gumlet-player-${videoID}`,
        title: props.title as string,
      });
    }),
  };
});

type PlayerEvents = {
  onReady?: () => void;
  onStateChange?: (event: { data: number }) => void;
  onAutoplayBlocked?: () => void;
};

type MockPlayer = {
  videoId: string;
  state: 'idle' | 'playing' | 'paused' | 'destroyed';
  pausedBeforeDestroy: boolean;
  events: PlayerEvents;
  playVideo: ReturnType<typeof vi.fn>;
  pauseVideo: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
  unMute: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

const players: MockPlayer[] = [];
let reducedMotion = false;
let mobileViewport = false;

function installMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion')
        ? reducedMotion
        : query.includes('max-width: 860px')
          ? mobileViewport
          : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function installYouTubeMock() {
  players.length = 0;
  const Player = vi.fn(function MockYTPlayer(
    this: MockPlayer,
    _element: HTMLElement,
    options: { videoId: string; events: PlayerEvents }
  ) {
    const iframe = document.createElement('iframe');
    _element.appendChild(iframe);
    this.videoId = options.videoId;
    this.state = 'idle';
    this.pausedBeforeDestroy = false;
    this.events = options.events;
    this.playVideo = vi.fn(() => {
      this.state = 'playing';
    });
    this.pauseVideo = vi.fn(() => {
      this.state = 'paused';
      this.pausedBeforeDestroy = true;
    });
    this.mute = vi.fn();
    this.unMute = vi.fn();
    this.destroy = vi.fn(() => {
      this.state = 'destroyed';
    });
    players.push(this);
  });

  Object.defineProperty(window, 'YT', {
    configurable: true,
    writable: true,
    value: {
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 },
      Player,
    },
  });
}

function renderLaunchpad(
  initialContentSlug: string | null = null,
  content = fixtureContent,
  initialPanel: 'info' | null = null,
  feedSeed = 'test-9',
  initialPathSlug: string | null = null
) {
  return render(
    <LaunchpadApp
      initialContent={content}
      initialCategories={fixtureCategories}
      initialContentSlug={initialContentSlug}
      initialPanel={initialPanel}
      initialPathSlug={initialPathSlug}
      feedSeed={feedSeed}
    />
  );
}

function contentVariant(
  base: LaunchpadContent,
  overrides: Partial<LaunchpadContent> & Pick<LaunchpadContent, 'id' | 'slug' | 'title'>
): LaunchpadContent {
  return { ...base, ...overrides };
}

function gumletTestContent(): LaunchpadContent {
  return contentVariant(fixtureContent[0], {
    id: 'video-gumlet-test',
    slug: 'gumlet-test-video',
    title: 'Gumlet Test Video',
    mediaUrl:
      'https://play.gumlet.io/embed/6a106a3589ec653eb39ce727?background=false&autoplay=false&loop=false&disable_player_controls=false',
    thumbnailUrl: '/images/article-placeholder.svg',
  });
}

function feedDeck() {
  return screen.getByTestId('feed-media-deck');
}

function navigationSurface() {
  return screen.getByTestId('launchpad-navigation-surface');
}

function desktopRail() {
  return screen.getByTestId('desktop-overlay-rail');
}

function expectHeading(title: string) {
  const collapsedTitle = title.replace(/\s+/g, '');
  return expect(screen.getByRole('heading', { name: new RegExp(collapsedTitle, 'i') })).toBeInTheDocument();
}

function storedEvents(): AnalyticsEvent[] {
  return JSON.parse(window.localStorage.getItem('career-launchpad-events') ?? '[]') as AnalyticsEvent[];
}

function dispatchWheel(target: Element, deltaY: number, deltaX = 0) {
  target.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaX, bubbles: true, cancelable: true }));
}

function dispatchTouch(target: Element, type: string, x: number, y: number) {
  const touch = { clientX: x, clientY: y, identifier: 1, target };
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? [] : [touch],
  });
  Object.defineProperty(event, 'changedTouches', {
    value: [touch],
  });
  target.dispatchEvent(event);
  return event;
}

async function finishTransition() {
  await act(async () => {
    vi.advanceTimersByTime(340);
  });
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
  });
  await vi.dynamicImportSettled();
  await act(async () => {
    await Promise.resolve();
  });
}

async function dismissFeedOnboarding() {
  await flushAsyncWork();
  const dialog = screen.queryByRole('dialog', { name: /hey, you can scroll/i });
  if (!dialog) return;

  fireEvent.click(within(dialog).getByRole('button', { name: 'Got it' }));
  await flushAsyncWork();
}

async function navigateToFirstInternshipArticle() {
  await dismissFeedOnboarding();

  act(() => {
    dispatchWheel(navigationSurface(), 90);
  });
  await finishTransition();
  act(() => {
    dispatchWheel(navigationSurface(), 90);
  });
  await finishTransition();

  expect(screen.getByTestId('feed-media-card-article-first-internship')).toHaveAttribute('data-current', 'true');
}

beforeEach(() => {
  vi.useFakeTimers();
  reducedMotion = false;
  mobileViewport = false;
  delete process.env.NEXT_PUBLIC_LAUNCHPAD_GUMLET_AUDIO_RECOVERY;
  gumletPlayers.length = 0;
  installMatchMedia();
  installYouTubeMock();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  replaceMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('LaunchpadApp feed navigation', () => {
  it('registers cancelable wheel and touchmove listeners on the full page surface and advances once for wheel inertia', async () => {
    const elementAdd = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const windowAdd = vi.spyOn(window, 'addEventListener');

    renderLaunchpad();

    expect(elementAdd).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false });
    expect(elementAdd).toHaveBeenCalledWith('touchmove', expect.any(Function), { passive: false });
    expect(windowAdd).not.toHaveBeenCalledWith('wheel', expect.any(Function), expect.anything());

    const heading = screen.getByRole('heading');
    act(() => {
      dispatchWheel(heading, 42);
      dispatchWheel(heading, 46);
      dispatchWheel(heading, 120);
    });

    await finishTransition();

    expectHeading('The Career Path Was Not a Straight Line');
  });

  it('axis-locks vertical touch movement, prevents default only after lock, and ignores horizontal gestures', async () => {
    renderLaunchpad();
    const surface = navigationSurface();

    act(() => {
      dispatchTouch(surface, 'touchstart', 100, 300);
    });
    const verticalMove = dispatchTouch(surface, 'touchmove', 104, 236);

    expect(verticalMove.defaultPrevented).toBe(true);
    await finishTransition();
    expectHeading('The Career Path Was Not a Straight Line');

    act(() => {
      dispatchTouch(surface, 'touchstart', 100, 300);
    });
    const horizontalMove = dispatchTouch(surface, 'touchmove', 172, 292);

    expect(horizontalMove.defaultPrevented).toBe(false);
    await finishTransition();
    expectHeading('The Career Path Was Not a Straight Line');
  });

  it('commits a slow vertical mobile swipe on touchend after axis lock', async () => {
    mobileViewport = true;
    installMatchMedia();
    renderLaunchpad();
    await dismissFeedOnboarding();
    const surface = navigationSurface();

    act(() => {
      dispatchTouch(surface, 'touchstart', 100, 300);
      vi.advanceTimersByTime(220);
    });
    const verticalMove = dispatchTouch(surface, 'touchmove', 104, 256);
    expect(verticalMove.defaultPrevented).toBe(true);
    expect(screen.queryByRole('button', { name: /play the career path/i })).not.toBeInTheDocument();

    act(() => {
      dispatchTouch(surface, 'touchend', 104, 256);
    });
    await finishTransition();

    expect(screen.getByRole('button', { name: /play the career path/i })).toBeInTheDocument();
  });

  it('keeps edge navigation as a no-op with no transition animation', async () => {
    renderLaunchpad();

    act(() => {
      dispatchWheel(navigationSurface(), -120);
    });
    await finishTransition();

    expectHeading('AI Tools That Make Schoolwork Less Messy');
    expect(feedDeck()).toHaveAttribute('data-transitioning', 'false');
  });

  it('uses keyboard navigation and ignores shortcuts from interactive controls', async () => {
    renderLaunchpad();

    fireEvent.keyDown(window, { key: 'j' });
    await finishTransition();
    expectHeading('The Career Path Was Not a Straight Line');

    screen.getByTestId('learn-more-primary-cta').focus();
    fireEvent.keyDown(window, { key: 'k' });
    await finishTransition();

    expectHeading('The Career Path Was Not a Straight Line');
  });

  it('skips slide transitions for reduced-motion users', async () => {
    reducedMotion = true;
    installMatchMedia();
    renderLaunchpad();

    act(() => {
      dispatchWheel(navigationSurface(), 90);
      vi.advanceTimersByTime(500);
    });

    expectHeading('The Career Path Was Not a Straight Line');
    expect(feedDeck()).toHaveAttribute('data-transitioning', 'false');
  });

  it('shows desktop feed onboarding on the first visit and persists dismissal across mounts', async () => {
    const { unmount } = renderLaunchpad();
    await flushAsyncWork();

    const dialog = screen.getByRole('dialog', { name: /hey, you can scroll/i });
    expect(within(dialog).getByTestId('feed-onboarding-keycap-up')).toHaveTextContent('↑');
    expect(within(dialog).getByTestId('feed-onboarding-keycap-down')).toHaveTextContent('↓');
    expect(within(dialog).getByText(/↑ and ↓ arrow keys/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/touchpad/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Got it' })).toHaveFocus();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Got it' }));

    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();
    expect(Number(window.localStorage.getItem(FEED_ONBOARDING_SEEN_KEY))).toBeGreaterThan(0);

    unmount();
    renderLaunchpad();
    await flushAsyncWork();

    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();
  });

  it('shows mobile feed onboarding copy and dismisses with Escape', async () => {
    mobileViewport = true;
    installMatchMedia();
    renderLaunchpad();
    await flushAsyncWork();

    const dialog = screen.getByRole('dialog', { name: /hey, you can scroll/i });
    expect(within(dialog).queryByTestId('feed-onboarding-keycap-up')).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId('feed-onboarding-keycap-down')).not.toBeInTheDocument();
    expect(within(dialog).getByTestId('feed-onboarding-swipe-cue')).toBeInTheDocument();
    expect(within(dialog).getByText(/swipe up or down/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/up and down arrows beside the social icons/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();
    expect(Number(window.localStorage.getItem(FEED_ONBOARDING_SEEN_KEY))).toBeGreaterThan(0);
  });

  it('does not show feed onboarding again once a dismissal is stored', async () => {
    window.localStorage.setItem(FEED_ONBOARDING_SEEN_KEY, String(Date.now()));

    renderLaunchpad();
    await flushAsyncWork();

    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();

    const heading = screen.getByRole('heading');
    act(() => {
      dispatchWheel(heading, 120);
    });
    await finishTransition();

    expectHeading('The Career Path Was Not a Straight Line');
  });

  it('keeps onboarding hidden on a bare shared link when a dismissal is stored', async () => {
    window.localStorage.setItem(FEED_ONBOARDING_SEEN_KEY, String(Date.now()));
    window.history.replaceState({}, '', '/?content=nonlinear-career-path');

    renderLaunchpad('nonlinear-career-path');
    await flushAsyncWork();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();
  });

  it('keeps onboarding hidden behind Learn More when a dismissal is stored', async () => {
    window.localStorage.setItem(FEED_ONBOARDING_SEEN_KEY, String(Date.now()));

    renderLaunchpad(fixtureContent[0].slug, fixtureContent, 'info');
    await flushAsyncWork();

    fireEvent.click(screen.getByTestId('learn-more-overlay'));
    await flushAsyncWork();

    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();
  });

  it('shows onboarding when the stored value is corrupt and replaces it on dismissal', async () => {
    window.localStorage.setItem(FEED_ONBOARDING_SEEN_KEY, 'garbage');

    renderLaunchpad();
    await flushAsyncWork();

    const dialog = screen.getByRole('dialog', { name: /hey, you can scroll/i });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Got it' }));

    expect(Number(window.localStorage.getItem(FEED_ONBOARDING_SEEN_KEY))).toBeGreaterThan(0);
  });

  it('treats opening search with Cmd+K as dismissing the onboarding', async () => {
    renderLaunchpad();
    await flushAsyncWork();

    expect(screen.getByRole('dialog', { name: /hey, you can scroll/i })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await flushAsyncWork();

    expect(screen.getByPlaceholderText(/search careers/i)).toBeInTheDocument();
    expect(Number(window.localStorage.getItem(FEED_ONBOARDING_SEEN_KEY))).toBeGreaterThan(0);

    fireEvent.keyDown(window, { key: 'Escape' });
    await flushAsyncWork();

    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();
  });

  it('keeps onboarding dismissed for the mount when the storage write fails', async () => {
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === FEED_ONBOARDING_SEEN_KEY) throw new Error('quota exceeded');
      originalSetItem(key, value);
    });

    renderLaunchpad();
    await flushAsyncWork();

    const dialog = screen.getByRole('dialog', { name: /hey, you can scroll/i });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Got it' }));
    await flushAsyncWork();

    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(FEED_ONBOARDING_SEEN_KEY)).toBeNull();
  });

  it('waits to show feed onboarding until an existing Learn More overlay closes', async () => {
    renderLaunchpad(fixtureContent[0].slug, fixtureContent, 'info');
    await flushAsyncWork();

    expect(screen.getByRole('dialog', { name: /ai tools that make schoolwork/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('learn-more-overlay'));
    await flushAsyncWork();

    expect(screen.getByRole('dialog', { name: /hey, you can scroll/i })).toBeInTheDocument();
  });

  it('opens a bare content permalink on the shared feed item without any modal first', async () => {
    window.history.replaceState({}, '', '/?content=nonlinear-career-path');

    renderLaunchpad('nonlinear-career-path');
    await flushAsyncWork();

    const currentCard = screen.getByTestId('feed-media-card-video-nonlinear-path');
    expect(currentCard).toHaveAttribute('data-current', 'true');
    expect(currentCard).toHaveAttribute('aria-current', 'true');
    expect(currentCard).toHaveStyle({ outline: 'none' });
    expect(currentCard).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /play the career path/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /play ai tools/i })).not.toBeInTheDocument();
    expect(players).toHaveLength(0);
    expect(window.location.search).toBe('?content=nonlinear-career-path');
  });

  it('delays onboarding on a bare content permalink and cancels it when another overlay opens first', async () => {
    window.history.replaceState({}, '', '/?content=nonlinear-career-path');

    renderLaunchpad('nonlinear-career-path');
    await flushAsyncWork();

    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2499);
    });
    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search careers/i)).toBeInTheDocument();
    // The hint never rendered, so nothing is persisted — but it stays suppressed for this mount.
    expect(window.localStorage.getItem(FEED_ONBOARDING_SEEN_KEY)).toBeNull();

    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();
  });

  it('opens a panel permalink over the matching feed item', async () => {
    window.history.replaceState({}, '', '/?content=nonlinear-career-path&panel=info');

    renderLaunchpad('nonlinear-career-path', fixtureContent, 'info');
    await flushAsyncWork();

    expect(screen.getByTestId('feed-media-card-video-nonlinear-path')).toHaveAttribute('data-current', 'true');
    expect(screen.getByRole('dialog', { name: /the career path was not a straight line/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /hey, you can scroll/i })).not.toBeInTheDocument();
  });

  it('moves the format label beside the category and keeps it off the desktop media frame', async () => {
    renderLaunchpad();
    await flushAsyncWork();

    const primaryCategory = fixtureCategories.find((category) => category.slug === fixtureContent[0].primaryCategory);
    expect(screen.getByTestId('desktop-category-pill')).toHaveTextContent(primaryCategory?.name ?? '');
    expect(screen.getByTestId('desktop-format-pill')).toHaveTextContent('Video');
    expect(screen.queryByTestId('media-format-badge')).not.toBeInTheDocument();
  });

  it('uses a larger desktop media frame and previews the next card at the bottom', () => {
    renderLaunchpad();

    expect(screen.getByTestId('desktop-immersive-media-frame')).toHaveStyle({
      height: 'min(calc(100dvh - 214px), 1040px)',
      maxHeight: 'calc(100% - 56px)',
      transform: 'translateY(-14px)',
    });

    const peek = screen.getByTestId('desktop-next-card-peek');
    expect(peek).toHaveAttribute('data-next-slug', fixtureContent[2].slug);
    expect(peek.querySelector('img')).toHaveAttribute('src', fixtureContent[2].thumbnailUrl);
    expect(peek).toHaveStyle({
      top: 'calc(100% + 24px)',
      width: '90%',
      opacity: '0.82',
    });
  });

  it('uses the visit shuffle even when articles arrive first from the server', () => {
    const articleFirst = [fixtureContent[1], fixtureContent[0], fixtureContent[3], fixtureContent[2], fixtureContent[4]];

    renderLaunchpad(null, articleFirst, null, 'seed-2');

    expectHeading('AI Tools That Make Schoolwork Less Messy');
    expect(screen.getByTestId('desktop-format-pill')).toHaveTextContent('Video');
  });

  it('does not render the desktop next-card preview on the final item', () => {
    renderLaunchpad(null, [fixtureContent[0]]);

    expect(screen.queryByTestId('desktop-next-card-peek')).not.toBeInTheDocument();
  });

  it('does not render source-type labels in the feed or Learn More panel', async () => {
    renderLaunchpad();
    const sourceLabels = ['Curated', 'Clipped', 'Original', 'Partner'];

    sourceLabels.forEach((label) => {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /learn more/i }));
    await flushAsyncWork();
    const dialog = screen.getByRole('dialog', { name: /ai tools that make schoolwork/i });

    sourceLabels.forEach((label) => {
      expect(within(dialog).queryByText(label)).not.toBeInTheDocument();
    });
  });

  it('uses the desktop immersive rail without fallback navigation controls or the old Heart view-count action', () => {
    renderLaunchpad();
    const rail = within(desktopRail());

    expect(rail.getByRole('button', { name: 'Like' })).toBeInTheDocument();
    expect(rail.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(rail.getByRole('button', { name: 'Info' })).toBeInTheDocument();
    expect(rail.queryByRole('button', { name: 'Previous item' })).not.toBeInTheDocument();
    expect(rail.queryByRole('button', { name: 'Next item' })).not.toBeInTheDocument();
    expect(rail.queryByRole('button', { name: /^[\d.]+K?$/ })).not.toBeInTheDocument();
  });

  it('uses Like/Liked copy and preserves legacy local saves', async () => {
    window.localStorage.setItem('career-launchpad-saved-content', JSON.stringify([fixtureContent[0].id]));
    renderLaunchpad();
    await flushAsyncWork();

    const rail = within(desktopRail());
    const likedButton = rail.getByRole('button', { name: 'Liked' });
    expect(likedButton).toHaveAttribute('data-active', 'true');

    fireEvent.click(likedButton);

    expect(rail.getByRole('button', { name: 'Like' })).toHaveAttribute('data-active', 'false');
    expect(JSON.parse(window.localStorage.getItem('career-launchpad-liked-content') ?? '[]')).toEqual([]);
  });

  it('briefly applies active rail feedback to Share and Info', async () => {
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    renderLaunchpad();

    const share = within(desktopRail()).getByRole('button', { name: 'Share' });
    expect(share).toHaveAttribute('data-active', 'false');

    fireEvent.click(share);

    expect(share).toHaveAttribute('data-active', 'true');
    await act(async () => {
      vi.advanceTimersByTime(1800);
    });
    expect(within(desktopRail()).getByRole('button', { name: 'Share' })).toHaveAttribute('data-active', 'false');

    const info = within(desktopRail()).getByRole('button', { name: 'Info' });
    fireEvent.click(info);
    await flushAsyncWork();

    expect(within(desktopRail()).getByRole('button', { name: 'Info', hidden: true })).toHaveAttribute(
      'data-active',
      'true'
    );
    expect(screen.getByRole('dialog', { name: /ai tools that make schoolwork/i })).toBeInTheDocument();
  });

  it('copies a bare content permalink for a non-first feed item', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderLaunchpad();
    await dismissFeedOnboarding();

    act(() => {
      dispatchWheel(navigationSurface(), 90);
    });
    await finishTransition();

    fireEvent.click(within(desktopRail()).getByRole('button', { name: 'Share' }));
    await flushAsyncWork();

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = new URL(writeText.mock.calls[0][0]);
    expect(copied.searchParams.get('content')).toBe('nonlinear-career-path');
    expect(copied.searchParams.has('panel')).toBe(false);
  });

  it('copies a bare content permalink from an open Info panel', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderLaunchpad();

    fireEvent.click(within(desktopRail()).getByRole('button', { name: 'Info' }));
    await flushAsyncWork();
    fireEvent.click(within(screen.getByRole('dialog', { name: /ai tools/i })).getByRole('button', { name: 'Share' }));
    await flushAsyncWork();

    expect(window.location.search).toBe('?content=ai-tools-student-workflow&panel=info');
    const copied = new URL(writeText.mock.calls.at(-1)?.[0]);
    expect(copied.searchParams.get('content')).toBe('ai-tools-student-workflow');
    expect(copied.searchParams.has('panel')).toBe(false);
  });

  it('removes the passive desktop scroll hint', () => {
    renderLaunchpad();

    expect(screen.queryByTestId('desktop-scroll-hint')).not.toBeInTheDocument();
  });

  it('renders the desktop primary Learn More CTA in the editorial column and opens the panel from it', async () => {
    renderLaunchpad();

    const primaryCtas = screen.getAllByTestId('learn-more-primary-cta');
    expect(primaryCtas).toHaveLength(1);
    expect(primaryCtas[0]).toHaveAttribute('data-variant', 'desktop');
    expect(primaryCtas[0]).toHaveAccessibleName('Learn More');
    expect(primaryCtas[0].parentElement).toHaveStyle({ position: 'static' });
    expect(
      within(screen.getByTestId('desktop-immersive-media-frame')).queryByTestId('learn-more-primary-cta')
    ).not.toBeInTheDocument();

    fireEvent.click(primaryCtas[0]);
    await flushAsyncWork();

    expect(screen.getByRole('dialog', { name: /ai tools that make schoolwork/i })).toBeInTheDocument();
  });

  it('keeps Learn More entry points visible for rows without rich Learn More fields', async () => {
    renderLaunchpad(null, [fixtureContent[4]]);

    expect(screen.getByTestId('learn-more-primary-cta')).toHaveAccessibleName('Read it');
    expect(within(desktopRail()).getByRole('button', { name: 'Info' })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('learn-more-primary-cta'));
    await flushAsyncWork();

    expect(screen.getByRole('dialog', { name: /article with no learn more copy/i })).toBeInTheDocument();
    expect(screen.queryByText(/why this matters/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/how it connects to career planning/i)).not.toBeInTheDocument();
  });

  it('uses Read it as the primary CTA on article cards and opens the panel from it', async () => {
    renderLaunchpad();
    await navigateToFirstInternshipArticle();

    const primaryCta = screen.getByTestId('learn-more-primary-cta');
    expect(primaryCta).toHaveAttribute('data-variant', 'desktop');
    expect(primaryCta).toHaveAccessibleName('Read it');
    expect(screen.getByTestId('media-article-copy')).toBeInTheDocument();

    fireEvent.click(primaryCta);
    await flushAsyncWork();

    expect(screen.getByRole('dialog', { name: /what your first internship/i })).toBeInTheDocument();
  });

  it.each([
    ['desktop', false],
    ['mobile', true],
  ])('links the full %s article card directly outbound and tracks the click once', async (_label, isMobile) => {
    mobileViewport = isMobile;
    installMatchMedia();
    const article = fixtureContent[3];
    renderLaunchpad(null, [article]);
    await dismissFeedOnboarding();

    const articleLink = screen.getByRole('link', { name: article.title });
    expect(articleLink).toHaveAttribute('data-feed-activator', 'true');
    expect(articleLink).toHaveAttribute('href', article.articleUrl);
    expect(articleLink).toHaveAttribute('target', '_blank');
    expect(articleLink).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByTestId('media-article-copy').closest('a')).toBe(articleLink);

    fireEvent.click(articleLink);

    const articleEvents = storedEvents().filter((event) => event.contentId === article.id);
    expect(articleEvents.filter((event) => event.eventType === 'outbound_click')).toHaveLength(1);
    expect(articleEvents.filter((event) => event.eventType === 'content_open')).toHaveLength(0);
    expect(articleEvents.filter((event) => event.eventType === 'learn_more_open')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps feed shortcuts active while preserving outgoing article copy without an activator', async () => {
    renderLaunchpad();
    await navigateToFirstInternshipArticle();

    const articleLink = screen.getByRole('link', { name: 'What Your First Internship Actually Teaches You' });
    articleLink.focus();
    expect(articleLink).toHaveFocus();

    fireEvent.keyDown(window, { key: 'ArrowDown' });

    const outgoingCard = screen.getByTestId('feed-media-card-article-first-internship');
    expect(feedDeck()).toHaveAttribute('data-transitioning', 'true');
    expect(within(outgoingCard).getByText('What Your First Internship Actually Teaches You')).toBeInTheDocument();
    expect(within(outgoingCard).queryByRole('link')).not.toBeInTheDocument();
    expect(
      outgoingCard.querySelector('a, button, input, textarea, select, [tabindex]:not([tabindex="-1"])')
    ).toBeNull();

    await finishTransition();
    expect(screen.queryByTestId('feed-media-card-article-first-internship')).not.toBeInTheDocument();
  });

  it('keeps mobile feed swipes working when the gesture begins on the article link', async () => {
    mobileViewport = true;
    installMatchMedia();
    renderLaunchpad();
    await navigateToFirstInternshipArticle();

    const articleLink = screen.getByRole('link', { name: 'What Your First Internship Actually Teaches You' });
    act(() => {
      dispatchTouch(articleLink, 'touchstart', 100, 300);
      dispatchTouch(articleLink, 'touchmove', 104, 236);
    });

    expect(feedDeck()).toHaveAttribute('data-transitioning', 'true');
    expect(storedEvents().filter((event) => event.eventType === 'outbound_click')).toHaveLength(0);

    await finishTransition();
    expect(screen.queryByTestId('feed-media-card-article-first-internship')).not.toBeInTheDocument();
  });

  it.each([
    ['desktop', false],
    ['mobile', true],
  ])('offers only Videos and Articles as formats on %s', async (_label, isMobile) => {
    mobileViewport = isMobile;
    installMatchMedia();
    renderLaunchpad();
    await flushAsyncWork();

    const formatsButton = screen.getByRole('button', { name: /2 formats/i });
    expect(formatsButton).toHaveAccessibleName('2 Formats');
    expect(formatsButton).toHaveTextContent('2');
    expect(formatsButton).toHaveTextContent('Formats');

    fireEvent.click(formatsButton);
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByRole('button', { name: /Videos/i })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: /Articles/i })).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: /Playbooks/i })).not.toBeInTheDocument();
  });

  it('renders the LaunchPad brand on desktop and mobile', async () => {
    const { unmount } = renderLaunchpad();

    expect(screen.getByText('LaunchPad')).toBeInTheDocument();
    expect(screen.queryByText('Career LaunchPAD')).not.toBeInTheDocument();
    expect(screen.queryByText('LaunchPAD')).not.toBeInTheDocument();

    unmount();
    mobileViewport = true;
    installMatchMedia();
    renderLaunchpad();
    await flushAsyncWork();

    expect(screen.getByText('LaunchPad')).toBeInTheDocument();
    expect(screen.queryByText('Career LaunchPAD')).not.toBeInTheDocument();
    expect(screen.queryByText('LaunchPAD')).not.toBeInTheDocument();
  });

  it('renders the centered mobile primary Learn More CTA and opens the panel from it', async () => {
    mobileViewport = true;
    installMatchMedia();
    renderLaunchpad();

    const primaryCta = screen.getByTestId('learn-more-primary-cta');
    const rail = within(screen.getByTestId('mobile-overlay-rail'));
    expect(primaryCta).toHaveAttribute('data-variant', 'mobile');
    expect(primaryCta).toHaveAccessibleName('Learn More');
    expect(rail.getAllByRole('button')).toHaveLength(3);
    expect(rail.getByRole('button', { name: 'Like' })).toBeInTheDocument();
    expect(rail.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(rail.getByRole('button', { name: 'Info' })).toBeInTheDocument();
    expect(rail.queryByRole('button', { name: 'Previous item' })).not.toBeInTheDocument();
    expect(rail.queryByRole('button', { name: 'Next item' })).not.toBeInTheDocument();
    expect(primaryCta).toHaveStyle({
      width: '100%',
      height: '56px',
    });
    expect(screen.queryByTestId('mobile-scroll-hint')).not.toBeInTheDocument();

    fireEvent.click(primaryCta);
    await flushAsyncWork();

    expect(screen.getByRole('dialog', { name: /ai tools that make schoolwork/i })).toBeInTheDocument();
  });

  it('keeps mobile swipe navigation after removing rail navigation controls', async () => {
    mobileViewport = true;
    installMatchMedia();
    renderLaunchpad();
    await dismissFeedOnboarding();

    const surface = navigationSurface();
    act(() => {
      dispatchTouch(surface, 'touchstart', 100, 300);
    });
    act(() => {
      dispatchTouch(surface, 'touchmove', 104, 236);
    });
    await finishTransition();

    expect(screen.getByRole('button', { name: /play the career path/i })).toBeInTheDocument();
    expect(
      within(screen.getByTestId('mobile-overlay-rail')).queryByRole('button', { name: 'Next item' })
    ).not.toBeInTheDocument();
  });

  it('keeps mobile rail taps isolated from touch navigation', async () => {
    mobileViewport = true;
    installMatchMedia();
    renderLaunchpad();
    await flushAsyncWork();

    const like = within(screen.getByTestId('mobile-overlay-rail')).getByRole('button', { name: 'Like' });
    fireEvent.touchStart(like);
    fireEvent.click(like);
    await finishTransition();

    expect(screen.getByRole('button', { name: /play ai tools/i })).toBeInTheDocument();
    expect(within(screen.getByTestId('mobile-overlay-rail')).getByRole('button', { name: 'Liked' })).toHaveAttribute(
      'data-active',
      'true'
    );
  });

  it('keeps focus order from left Learn More to play, Like, Share, and Info', () => {
    renderLaunchpad();

    const buttons = screen.getAllByRole('button');
    const playIdx = buttons.indexOf(screen.getByRole('button', { name: /play ai tools/i }));
    const learnMoreIdx = buttons.indexOf(screen.getByTestId('learn-more-primary-cta'));
    const saveIdx = buttons.indexOf(within(desktopRail()).getByRole('button', { name: 'Like' }));
    const shareIdx = buttons.indexOf(within(desktopRail()).getByRole('button', { name: 'Share' }));
    const infoIdx = buttons.indexOf(within(desktopRail()).getByRole('button', { name: 'Info' }));

    expect([learnMoreIdx, playIdx, saveIdx, shareIdx, infoIdx]).toEqual(
      [...[learnMoreIdx, playIdx, saveIdx, shareIdx, infoIdx]].sort((a, b) => a - b)
    );
  });

  it('uses the visit shuffle for the first visible feed card', async () => {
    renderLaunchpad(null, fixtureContent, null, 'seed-1');
    await dismissFeedOnboarding();

    expectHeading('An Article With No Learn More Copy');
  });

  it('shows shuffled default search results', () => {
    const articleBase = fixtureContent[1];
    const videoBase = fixtureContent[0];
    const content: LaunchpadContent[] = [
      contentVariant(articleBase, { id: 'article-a', slug: 'article-a', title: 'Article A' }),
      contentVariant(articleBase, { id: 'article-b', slug: 'article-b', title: 'Article B' }),
      ...Array.from({ length: 6 }, (_, index) =>
        contentVariant(videoBase, {
          id: `video-${index}`,
          slug: `video-${index}`,
          title: `Video Result ${index + 1}`,
        })
      ),
    ];

    renderLaunchpad(null, content, null, 'seed-1');
    fireEvent.click(screen.getByRole('button', { name: 'Open search' }));

    const results = screen.getAllByTestId('search-result');
    expect(results).toHaveLength(6);
    expect(results.map((result) => result.textContent)).toEqual([
      'Article Barticle · Mindsets',
      'Video Result 6video · Life Skills',
      'Video Result 4video · Life Skills',
      'Video Result 5video · Life Skills',
      'Video Result 1video · Life Skills',
      'Video Result 3video · Life Skills',
    ]);
  });

  it('keeps typed search results in matching content order', () => {
    const articleMatch = contentVariant(fixtureContent[1], {
      id: 'article-alpha',
      slug: 'article-alpha',
      title: 'Alpha Article',
    });
    const videoMatch = contentVariant(fixtureContent[0], {
      id: 'video-alpha',
      slug: 'video-alpha',
      title: 'Alpha Video',
    });

    renderLaunchpad(null, [articleMatch, videoMatch], null, 'seed-1');
    fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
    fireEvent.change(screen.getByPlaceholderText(/search careers/i), { target: { value: 'alpha' } });

    const results = screen.getAllByTestId('search-result');
    expect(results.map((result) => result.textContent)).toEqual([
      'Alpha Videovideo · Life Skills',
      'Alpha Articlearticle · Mindsets',
    ]);
  });

  it('tracks session start and sanitized zero-result search analytics', async () => {
    renderLaunchpad();
    await flushAsyncWork();

    expect(storedEvents().filter((event) => event.eventType === 'session_start')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
    fireEvent.change(screen.getByPlaceholderText(/search careers/i), {
      target: { value: ' Student.Name@example.com 613-555-0199 ' },
    });

    act(() => {
      vi.advanceTimersByTime(450);
    });
    await flushAsyncWork();

    const events = storedEvents();
    expect(events.filter((event) => event.eventType === 'search_open')).toHaveLength(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'search_query',
          metadata: { query: '[redacted-email] [redacted-phone]', resultCount: 0 },
        }),
        expect.objectContaining({
          eventType: 'search_zero_results',
          metadata: { query: '[redacted-email] [redacted-phone]', resultCount: 0 },
        }),
      ])
    );
  });

  it('tracks search result clicks with query, result count, rank, and selected content id', async () => {
    const articleMatch = contentVariant(fixtureContent[1], {
      id: 'article-alpha',
      slug: 'article-alpha',
      title: 'Alpha Article',
    });
    const videoMatch = contentVariant(fixtureContent[0], {
      id: 'video-alpha',
      slug: 'video-alpha',
      title: 'Alpha Video',
    });

    renderLaunchpad(null, [articleMatch, videoMatch], null, 'seed-1');
    await flushAsyncWork();
    fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
    fireEvent.change(screen.getByPlaceholderText(/search careers/i), { target: { value: ' Alpha ' } });

    act(() => {
      vi.advanceTimersByTime(450);
    });
    await flushAsyncWork();
    fireEvent.click(screen.getAllByTestId('search-result')[0]);
    await flushAsyncWork();

    expect(storedEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'search_result_click',
          contentId: 'video-alpha',
          metadata: { query: 'alpha', resultCount: 2, rank: 1, selectedContentId: 'video-alpha' },
        }),
      ])
    );
  });

  it('preserves shuffled-relative order when filtering by category', async () => {
    renderLaunchpad(null, fixtureContent, null, 'seed-1');
    await dismissFeedOnboarding();

    fireEvent.click(screen.getByRole('button', { name: /8 paths/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Mindsets/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Done/i }));

    expectHeading('An Article With No Learn More Copy');
    dispatchWheel(navigationSurface(), 180);
    await finishTransition();
    expectHeading('The Skills That Travel With You');
  });

  it('preserves shuffled-relative order when filtering by format', async () => {
    renderLaunchpad(null, fixtureContent, null, 'seed-1');
    await dismissFeedOnboarding();

    fireEvent.click(screen.getByRole('button', { name: /2 formats/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Videos/i }));

    expectHeading('The Career Path Was Not a Straight Line');
    dispatchWheel(navigationSurface(), 180);
    await finishTransition();
    expectHeading('AI Tools That Make Schoolwork Less Messy');
  });

  it('keeps the Video format filter after opening Learn More on the current video card', async () => {
    renderLaunchpad();
    await dismissFeedOnboarding();

    fireEvent.click(screen.getByRole('button', { name: /2 formats/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Videos/i }));

    fireEvent.click(screen.getByTestId('learn-more-primary-cta'));
    await flushAsyncWork();

    expect(screen.getByRole('dialog', { name: /ai tools that make schoolwork/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Video$/, hidden: true })).toHaveAttribute('data-active', 'true');
    expect(screen.queryByRole('button', { name: /2 formats/i, hidden: true })).not.toBeInTheDocument();
  });

  it('keeps the Article format filter after opening Read it on the current article card', async () => {
    renderLaunchpad(null, fixtureContent, null, 'seed-1');
    await dismissFeedOnboarding();

    expectHeading('An Article With No Learn More Copy');

    fireEvent.click(screen.getByRole('button', { name: /2 formats/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Articles/i }));

    fireEvent.click(screen.getByTestId('learn-more-primary-cta'));
    await flushAsyncWork();

    expect(screen.getByRole('dialog', { name: /article with no learn more copy/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Article$/, hidden: true })).toHaveAttribute('data-active', 'true');
    expect(screen.queryByRole('button', { name: /2 formats/i, hidden: true })).not.toBeInTheDocument();
  });

  it('clears the format filter when a picked related item does not match it', async () => {
    const articleWithVideoRelated = contentVariant(fixtureContent[1], {
      id: 'article-x',
      slug: 'article-x',
      title: 'Article X',
      learnMore: { ...fixtureContent[1].learnMore, relatedContentIds: ['video-y'] },
    });
    const videoY = contentVariant(fixtureContent[0], {
      id: 'video-y',
      slug: 'video-y',
      title: 'Video Y',
      mediaUrl: 'https://www.youtube.com/watch?v=yyyyyyyyyyy',
      learnMore: { ...fixtureContent[0].learnMore, relatedContentIds: [] },
    });
    renderLaunchpad(null, [articleWithVideoRelated, videoY]);
    await dismissFeedOnboarding();

    fireEvent.click(screen.getByRole('button', { name: /2 formats/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Articles/i }));
    expectHeading('Article X');

    fireEvent.click(screen.getByTestId('learn-more-primary-cta'));
    await flushAsyncWork();

    const dialog = screen.getByRole('dialog', { name: /article x/i });
    expect(screen.getByRole('button', { name: /^Article$/, hidden: true })).toHaveAttribute('data-active', 'true');

    const videoYTitle = within(dialog).getByText('Video Y');
    fireEvent.click(videoYTitle.closest('button') as HTMLButtonElement);
    await flushAsyncWork();

    expect(screen.queryByRole('button', { name: /^Article$/, hidden: true })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2 formats/i, hidden: true })).toBeInTheDocument();
  });

  it('preserves the format filter when a picked related item matches it', async () => {
    const videoA = contentVariant(fixtureContent[0], {
      id: 'video-a',
      slug: 'video-a',
      title: 'Video A',
      mediaUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      learnMore: { ...fixtureContent[0].learnMore, relatedContentIds: ['video-b'] },
    });
    const videoB = contentVariant(fixtureContent[0], {
      id: 'video-b',
      slug: 'video-b',
      title: 'Video B',
      mediaUrl: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
      learnMore: { ...fixtureContent[0].learnMore, relatedContentIds: ['video-a'] },
    });
    renderLaunchpad(null, [videoA, videoB]);
    await dismissFeedOnboarding();

    fireEvent.click(screen.getByRole('button', { name: /2 formats/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Videos/i }));

    fireEvent.click(screen.getByTestId('learn-more-primary-cta'));
    await flushAsyncWork();

    const dialogA = screen.queryByRole('dialog', { name: /video a/i });
    const dialog = dialogA ?? screen.getByRole('dialog', { name: /video b/i });
    const otherTitle = dialogA ? 'Video B' : 'Video A';

    const relatedTitle = within(dialog).getByText(otherTitle);
    fireEvent.click(relatedTitle.closest('button') as HTMLButtonElement);
    await flushAsyncWork();

    expect(screen.getByRole('button', { name: /^Video$/, hidden: true })).toHaveAttribute('data-active', 'true');
    expect(screen.queryByRole('button', { name: /2 formats/i, hidden: true })).not.toBeInTheDocument();
  });

  it('jumps from a search result to the feed card without opening Learn More', async () => {
    renderLaunchpad();
    await dismissFeedOnboarding();
    // Set a category filter via the paths drawer before opening search
    fireEvent.click(screen.getByRole('button', { name: /8 paths/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Life Skills/i }));
    // Paths drawer stays open (multi-select) — close it via Done before opening search
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Done/i }));
    window.history.replaceState({}, '', '/?content=stale-content');

    fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
    fireEvent.click(screen.getByRole('button', { name: /what your first internship/i }));
    await flushAsyncWork();

    expectHeading('What Your First Internship Actually Teaches You');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search careers/i)).not.toBeInTheDocument();
    expect(window.location.search).not.toContain('content=');
  });

  it('uses popstate content URLs to focus feed content and open or close the panel', async () => {
    renderLaunchpad(null, fixtureContent, null, 'seed-1');
    await dismissFeedOnboarding();

    window.history.pushState({}, '', '/?content=nonlinear-career-path');
    fireEvent.popState(window);
    await flushAsyncWork();

    expect(screen.getByTestId('feed-media-card-video-nonlinear-path')).toHaveAttribute('data-current', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    window.history.pushState({}, '', '/?content=nonlinear-career-path&panel=info');
    fireEvent.popState(window);
    await flushAsyncWork();

    expect(screen.getByTestId('feed-media-card-video-nonlinear-path')).toHaveAttribute('data-current', 'true');
    expect(screen.getByRole('dialog', { name: /the career path was not a straight line/i })).toBeInTheDocument();

    window.history.pushState({}, '', '/?content=nonlinear-career-path');
    fireEvent.popState(window);
    await flushAsyncWork();

    expect(screen.getByTestId('feed-media-card-video-nonlinear-path')).toHaveAttribute('data-current', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lets back navigation close an in-app panel while keeping the feed item focused', async () => {
    window.history.replaceState({}, '', '/?content=nonlinear-career-path');
    renderLaunchpad('nonlinear-career-path');
    await flushAsyncWork();

    fireEvent.click(within(desktopRail()).getByRole('button', { name: 'Info' }));
    await flushAsyncWork();

    expect(window.location.search).toBe('?content=nonlinear-career-path&panel=info');
    expect(screen.getByRole('dialog', { name: /the career path was not a straight line/i })).toBeInTheDocument();

    window.history.replaceState({}, '', '/?content=nonlinear-career-path');
    fireEvent.popState(window);
    await flushAsyncWork();

    expect(screen.getByTestId('feed-media-card-video-nonlinear-path')).toHaveAttribute('data-current', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.location.search).toBe('?content=nonlinear-career-path');
  });

  it('tracks direct-link and in-app panel analytics without double-firing from URL writes', async () => {
    window.history.replaceState({}, '', '/?content=nonlinear-career-path');
    const { unmount } = renderLaunchpad('nonlinear-career-path');
    await flushAsyncWork();

    let events = storedEvents();
    expect(events.filter((event) => event.eventType === 'content_open' && event.contentId === 'video-nonlinear-path')).toHaveLength(1);
    expect(events.filter((event) => event.eventType === 'learn_more_open' && event.contentId === 'video-nonlinear-path')).toHaveLength(0);

    unmount();
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/?content=nonlinear-career-path&panel=info');
    renderLaunchpad('nonlinear-career-path', fixtureContent, 'info');
    await flushAsyncWork();

    events = storedEvents();
    expect(events.filter((event) => event.eventType === 'content_open' && event.contentId === 'video-nonlinear-path')).toHaveLength(1);
    expect(events.filter((event) => event.eventType === 'learn_more_open' && event.contentId === 'video-nonlinear-path')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await flushAsyncWork();
    fireEvent.click(within(desktopRail()).getByRole('button', { name: 'Info' }));
    await flushAsyncWork();

    events = storedEvents();
    expect(events.filter((event) => event.eventType === 'content_open' && event.contentId === 'video-nonlinear-path')).toHaveLength(2);
    expect(events.filter((event) => event.eventType === 'learn_more_open' && event.contentId === 'video-nonlinear-path')).toHaveLength(2);
  });
});

describe('LaunchpadApp playback', () => {
  it('plays a Gumlet embed URL in the feed media frame', () => {
    renderLaunchpad(null, [gumletTestContent()]);

    fireEvent.click(screen.getByRole('button', { name: /play gumlet test video/i }));

    expect(screen.getByTestId('gumlet-host-6a106a3589ec653eb39ce727')).toBeInTheDocument();
  });

  it('tracks explicit video pause actions', async () => {
    renderLaunchpad(null, [fixtureContent[0]]);

    fireEvent.click(screen.getByRole('button', { name: /play ai tools/i }));
    await flushAsyncWork();
    fireEvent.click(screen.getByTestId('youtube-scroll-overlay'));
    await flushAsyncWork();

    expect(storedEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'video_pause',
          contentId: 'video-ai-tools',
          metadata: expect.objectContaining({ reason: 'explicit' }),
        }),
      ])
    );
  });

  it('tracks video progress milestones independently for each feed item', async () => {
    const firstVideo = contentVariant(fixtureContent[0], {
      id: 'video-progress-one',
      slug: 'video-progress-one',
      title: 'Progress One',
      durationSeconds: 20,
    });
    const secondVideo = contentVariant(fixtureContent[2], {
      id: 'video-progress-two',
      slug: 'video-progress-two',
      title: 'Progress Two',
      durationSeconds: 20,
    });

    renderLaunchpad('video-progress-one', [firstVideo, secondVideo], null, 'progress');
    await flushAsyncWork();

    fireEvent.click(screen.getByRole('button', { name: /play progress one/i }));
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    const firstPlayer = players.at(-1);
    if (!firstPlayer) throw new Error('Expected first YouTube player');
    if (!window.YT) throw new Error('Expected YouTube API mock');
    const endedState = window.YT.PlayerState.ENDED;
    act(() => {
      firstPlayer.events.onStateChange?.({ data: endedState });
    });
    await finishTransition();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    const progressEvents = storedEvents().filter((event) => event.eventType === 'video_progress');
    expect(progressEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contentId: 'video-progress-one',
          metadata: expect.objectContaining({ milestone: 25 }),
        }),
        expect.objectContaining({
          contentId: 'video-progress-two',
          metadata: expect.objectContaining({ milestone: 25 }),
        }),
      ])
    );
  });

  it('starts Gumlet playback on ready and falls back to muted autoplay if playback does not start', async () => {
    renderLaunchpad(null, [gumletTestContent()]);

    fireEvent.click(screen.getByRole('button', { name: /play gumlet test video/i }));
    await flushAsyncWork();

    const player = gumletPlayers.at(-1);
    if (!player) throw new Error('Expected Gumlet player');

    act(() => {
      (player.props.onReady as () => void)();
    });
    expect(player.unmute).toHaveBeenCalledTimes(1);
    expect(player.setVolume).toHaveBeenCalledWith(100);
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.mute).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(900);
    });

    expect(player.mute).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledTimes(2);
  });

  it('shows a rail-level sound recovery control when Gumlet stays muted', async () => {
    renderLaunchpad(null, [gumletTestContent()]);

    fireEvent.click(screen.getByRole('button', { name: /play gumlet test video/i }));
    await flushAsyncWork();

    const player = gumletPlayers.at(-1);
    if (!player) throw new Error('Expected Gumlet player');

    act(() => {
      (player.props.onReady as () => void)();
      player.muted = true;
      player.volume = 0;
      (player.props.onVolumeChange as (event: { muted: boolean; volume: number }) => void)({
        muted: true,
        volume: 0,
      });
    });

    expect(within(desktopRail()).getByRole('button', { name: 'Sound' })).toBeInTheDocument();
  });

  it('retries Gumlet audio from the rail-level sound control and records analytics', async () => {
    renderLaunchpad(null, [gumletTestContent()]);

    fireEvent.click(screen.getByRole('button', { name: /play gumlet test video/i }));
    await flushAsyncWork();

    const player = gumletPlayers.at(-1);
    if (!player) throw new Error('Expected Gumlet player');

    act(() => {
      (player.props.onReady as () => void)();
      player.muted = true;
      player.volume = 0;
      (player.props.onVolumeChange as (event: { muted: boolean; volume: number }) => void)({
        muted: true,
        volume: 0,
      });
    });

    const soundButton = within(desktopRail()).getByRole('button', { name: 'Sound' });
    fireEvent.click(soundButton);
    await flushAsyncWork();

    expect(player.unmute).toHaveBeenCalledTimes(2);
    expect(player.setVolume).toHaveBeenLastCalledWith(100);
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(within(desktopRail()).queryByRole('button', { name: 'Sound' })).not.toBeInTheDocument();
    expect(
      storedEvents().some(
        (event) =>
          event.eventType === 'video_audio_recovery' &&
          event.contentId === 'video-gumlet-test' &&
          event.metadata?.action === 'clicked'
      )
    ).toBe(true);
  });

  it('hides Gumlet audio recovery when the kill switch is disabled', async () => {
    process.env.NEXT_PUBLIC_LAUNCHPAD_GUMLET_AUDIO_RECOVERY = 'false';
    renderLaunchpad(null, [gumletTestContent()]);

    fireEvent.click(screen.getByRole('button', { name: /play gumlet test video/i }));
    await flushAsyncWork();

    const player = gumletPlayers.at(-1);
    if (!player) throw new Error('Expected Gumlet player');

    act(() => {
      (player.props.onReady as () => void)();
      player.muted = true;
      player.volume = 0;
      (player.props.onVolumeChange as (event: { muted: boolean; volume: number }) => void)({
        muted: true,
        volume: 0,
      });
    });

    expect(within(desktopRail()).queryByRole('button', { name: 'Sound' })).not.toBeInTheDocument();
    expect(storedEvents().some((event) => event.eventType === 'video_audio_recovery')).toBe(false);
  });

  it('auto-advances from a Gumlet video when it ends', async () => {
    renderLaunchpad(null, [gumletTestContent(), fixtureContent[1]], null, 'seed-2');

    fireEvent.click(screen.getByRole('button', { name: /play gumlet test video/i }));
    await flushAsyncWork();
    const player = gumletPlayers.at(-1);
    if (!player) throw new Error('Expected Gumlet player');

    act(() => {
      (player.props.onReady as () => void)();
      (player.props.onPlay as () => void)();
      (player.props.onEnded as () => void)();
    });
    await finishTransition();

    expectHeading('The Skills That Travel With You');
    expect(screen.queryByTestId('gumlet-host-6a106a3589ec653eb39ce727')).not.toBeInTheDocument();
  });

  it('creates a YouTube player after a user play intent and falls back to muted autoplay if playback does not start', () => {
    renderLaunchpad();

    fireEvent.click(screen.getByRole('button', { name: /play ai tools/i }));
    expect(players).toHaveLength(1);

    act(() => {
      players[0].events.onReady?.();
    });
    expect(players[0].playVideo).toHaveBeenCalledTimes(1);
    expect(players[0].mute).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(900);
    });

    expect(players[0].mute).toHaveBeenCalledTimes(1);
    expect(players[0].playVideo).toHaveBeenCalledTimes(2);
  });

  it('sizes the YouTube iframe to fill the media frame instead of the API default', () => {
    renderLaunchpad();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /play ai tools/i }));
    });
    const host = screen.getByTestId('youtube-host-5MgBikgcWnY');
    const mount = host.firstElementChild as HTMLElement;

    expect(mount).toHaveStyle({
      position: 'absolute',
      width: '100%',
      height: '100%',
    });

    act(() => {
      players[0].events.onReady?.();
    });

    const iframe = host.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe.style.position).toBe('absolute');
    expect(iframe.style.width).toBe('100%');
    expect(iframe.style.height).toBe('100%');
    expect(iframe.style.border).toBe('0px');
    expect(iframe.style.display).toBe('block');
  });

  it('uses muted mode immediately when the browser reports allowed-muted autoplay', () => {
    Object.defineProperty(window.navigator, 'getAutoplayPolicy', {
      configurable: true,
      value: vi.fn(() => 'allowed-muted'),
    });
    renderLaunchpad();

    fireEvent.click(screen.getByRole('button', { name: /play ai tools/i }));
    act(() => {
      players[0].events.onReady?.();
    });

    expect(players[0].mute).toHaveBeenCalledBefore(players[0].playVideo);
  });

  it('captures scroll over the playing iframe overlay and stops playback on non-video content', async () => {
    renderLaunchpad();
    await dismissFeedOnboarding();

    fireEvent.click(screen.getByRole('button', { name: /play ai tools/i }));
    act(() => {
      players[0].events.onReady?.();
      players[0].events.onStateChange?.({ data: 1 });
    });

    const overlay = screen.getByTestId('youtube-scroll-overlay');
    act(() => {
      dispatchWheel(overlay, 90);
    });
    await finishTransition();

    expectHeading('The Career Path Was Not a Straight Line');
    expect(screen.getByTestId('youtube-scroll-overlay')).toBeInTheDocument();
    expect(players[0].destroy).toHaveBeenCalled();

    act(() => {
      dispatchWheel(screen.getByTestId('youtube-scroll-overlay'), 90);
    });
    await finishTransition();

    expectHeading('What Your First Internship Actually Teaches You');
    expect(screen.queryByTestId('youtube-scroll-overlay')).not.toBeInTheDocument();
  });

  it('captures wheel navigation from desktop rail buttons while a video is playing', async () => {
    renderLaunchpad();

    fireEvent.click(screen.getByRole('button', { name: /play ai tools/i }));
    act(() => {
      players[0].events.onReady?.();
      players[0].events.onStateChange?.({ data: 1 });
      dispatchWheel(within(desktopRail()).getByRole('button', { name: 'Share' }), 90);
    });
    await finishTransition();

    expectHeading('The Career Path Was Not a Straight Line');
    expect(screen.getByTestId('youtube-scroll-overlay')).toBeInTheDocument();
  });

  it('carries user-started autoplay between videos and recreates the player when scrolling back', async () => {
    renderLaunchpad();
    await dismissFeedOnboarding();

    // Open formats drawer and pick Videos
    fireEvent.click(screen.getByRole('button', { name: /2 formats/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Videos/i }));
    fireEvent.click(screen.getByRole('button', { name: /play ai tools/i }));
    act(() => {
      players[0].events.onReady?.();
      players[0].events.onStateChange?.({ data: 1 });
      dispatchWheel(screen.getByTestId('youtube-scroll-overlay'), 90);
    });
    await finishTransition();

    expectHeading('The Career Path Was Not a Straight Line');
    expect(players.at(-1)?.videoId).toBe('arj7oStGLkU');

    act(() => {
      players.at(-1)?.events.onReady?.();
      players.at(-1)?.events.onStateChange?.({ data: 1 });
      dispatchWheel(screen.getByTestId('youtube-scroll-overlay'), -90);
    });
    await finishTransition();

    expectHeading('AI Tools That Make Schoolwork Less Messy');
    expect(players.at(-1)?.videoId).toBe('5MgBikgcWnY');
    expect(players.filter((player) => player.videoId === '5MgBikgcWnY')).toHaveLength(2);
  });

  it('auto-advances to the next video when the current video ends', async () => {
    renderLaunchpad();

    fireEvent.click(screen.getByRole('button', { name: /play ai tools/i }));
    act(() => {
      players[0].events.onReady?.();
      players[0].events.onStateChange?.({ data: 1 });
      players[0].events.onStateChange?.({ data: 0 });
    });
    await finishTransition();

    expectHeading('The Career Path Was Not a Straight Line');
    expect(screen.getByTestId('youtube-scroll-overlay')).toBeInTheDocument();
    expect(players.at(-1)?.videoId).toBe('arj7oStGLkU');

    act(() => {
      players[0].events.onStateChange?.({ data: 0 });
    });
    await finishTransition();

    expectHeading('The Career Path Was Not a Straight Line');
  });

  it('auto-advances to an article and stops playback when the ended video is followed by non-video content', async () => {
    renderLaunchpad(null, [fixtureContent[0], fixtureContent[1]], null, 'seed-2');

    fireEvent.click(screen.getByRole('button', { name: /play ai tools/i }));
    act(() => {
      players[0].events.onReady?.();
      players[0].events.onStateChange?.({ data: 1 });
      players[0].events.onStateChange?.({ data: 0 });
    });
    await finishTransition();

    expectHeading('The Skills That Travel With You');
    expect(screen.queryByTestId('youtube-scroll-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('media-article-copy')).toBeInTheDocument();
  });

  it('stops playback when the final video ends', async () => {
    renderLaunchpad(null, [fixtureContent[0]]);

    fireEvent.click(screen.getByRole('button', { name: /play ai tools/i }));
    act(() => {
      players[0].events.onReady?.();
      players[0].events.onStateChange?.({ data: 1 });
      players[0].events.onStateChange?.({ data: 0 });
    });
    await finishTransition();

    expectHeading('AI Tools That Make Schoolwork Less Messy');
    expect(screen.queryByTestId('youtube-scroll-overlay')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /play ai tools/i })).toBeInTheDocument();
  });

  it('opens Learn More from the desktop Info rail action', async () => {
    renderLaunchpad();

    fireEvent.click(within(desktopRail()).getByRole('button', { name: 'Info' }));
    await flushAsyncWork();

    expect(screen.getByRole('dialog', { name: /ai tools that make schoolwork/i })).toBeInTheDocument();
  });

  it('pauses playing video before opening Learn More and does not auto-resume on close', async () => {
    renderLaunchpad();

    fireEvent.click(screen.getByRole('button', { name: /play ai tools/i }));
    act(() => {
      players[0].events.onReady?.();
      players[0].events.onStateChange?.({ data: 1 });
    });

    fireEvent.click(within(desktopRail()).getByRole('button', { name: 'Info' }));
    await flushAsyncWork();

    expect(players[0].pauseVideo).toHaveBeenCalledTimes(1);
    expect(players[0].pausedBeforeDestroy).toBe(true);
    expect(players[0].state).toBe('destroyed');
    expect(screen.getByRole('dialog', { name: /ai tools that make schoolwork/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await act(async () => {
      vi.advanceTimersByTime(340);
    });

    expect(players).toHaveLength(1);
    expect(screen.getByRole('button', { name: /play ai tools/i })).toBeInTheDocument();
  });

  it('strips invalid direct content links and explains recovery', async () => {
    window.history.replaceState({}, '', '/?content=missing-slug');

    renderLaunchpad('missing-slug');
    await flushAsyncWork();

    expect(replaceMock).toHaveBeenCalledWith('/');
    expect(screen.getByText(/content not available/i)).toBeInTheDocument();
  });
});

describe('LaunchpadApp path deep links', () => {
  it('seeds the category filter from a path link and shows it in the header CTA', async () => {
    window.history.replaceState({}, '', '/?path=mindsets');

    renderLaunchpad(null, fixtureContent, null, 'seed-1', 'mindsets');
    await dismissFeedOnboarding();

    expectHeading('An Article With No Learn More Copy');
    dispatchWheel(navigationSurface(), 180);
    await finishTransition();
    expectHeading('The Skills That Travel With You');

    expect(screen.queryByRole('button', { name: /8 paths/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mindsets/i })).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('honors legacy category aliases in path links', async () => {
    window.history.replaceState({}, '', '/?path=day-in-the-life');

    renderLaunchpad(null, fixtureContent, null, 'seed-1', 'day-in-the-life');
    await dismissFeedOnboarding();

    expectHeading('What Your First Internship Actually Teaches You');
    expect(screen.getByRole('button', { name: /on the job/i })).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('seeds multiple categories from a comma-separated path link', async () => {
    window.history.replaceState({}, '', '/?path=mindsets,life-skills');

    renderLaunchpad(null, fixtureContent, null, 'seed-1', 'mindsets,life-skills');
    await dismissFeedOnboarding();

    expect(screen.getByRole('button', { name: /2 paths/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /8 paths/i })).not.toBeInTheDocument();
  });

  it('strips invalid path links, keeps the feed unfiltered, and explains recovery', async () => {
    window.history.replaceState({}, '', '/?path=not-a-real-path');

    renderLaunchpad(null, fixtureContent, null, 'test-9', 'not-a-real-path');
    await dismissFeedOnboarding();

    expect(replaceMock).toHaveBeenCalledWith('/');
    expect(screen.getByText(/path not available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /8 paths/i })).toBeInTheDocument();
  });

  it('lets a content deep link win over a path link', async () => {
    window.history.replaceState({}, '', '/?path=mindsets&content=nonlinear-career-path');

    renderLaunchpad('nonlinear-career-path', fixtureContent, null, 'test-9', 'mindsets');
    await flushAsyncWork();

    expect(screen.getByTestId('feed-media-card-video-nonlinear-path')).toHaveAttribute('data-current', 'true');
    // Filters stay empty so the linked item is guaranteed visible.
    expect(screen.getByRole('button', { name: /8 paths/i })).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('still seeds the path filter when the content slug in the link is invalid', async () => {
    window.history.replaceState({}, '', '/?path=mindsets&content=missing-slug');

    renderLaunchpad('missing-slug', fixtureContent, null, 'seed-1', 'mindsets');
    await flushAsyncWork();

    expect(replaceMock).toHaveBeenCalledWith('/?path=mindsets');
    expect(screen.getByText(/content not available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mindsets/i })).toBeInTheDocument();
  });

  it('drops the path param from shared content links', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    window.history.replaceState({}, '', '/?path=mindsets');

    renderLaunchpad(null, fixtureContent, null, 'seed-1', 'mindsets');
    await dismissFeedOnboarding();

    fireEvent.click(within(desktopRail()).getByRole('button', { name: 'Share' }));
    await flushAsyncWork();

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = new URL(writeText.mock.calls[0][0]);
    expect(copied.searchParams.get('content')).toBe('article-empty-learn-more');
    expect(copied.searchParams.has('path')).toBe(false);
  });

  it('tracks a single direct-link category_filter event per seeded path', async () => {
    window.history.replaceState({}, '', '/?path=mindsets');

    renderLaunchpad(null, fixtureContent, null, 'seed-1', 'mindsets');
    await dismissFeedOnboarding();

    dispatchWheel(navigationSurface(), 180);
    await finishTransition();

    const events = storedEvents().filter((event) => event.eventType === 'category_filter');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual({ category: 'mindsets', action: 'add', source: 'direct_link' });
  });
});

describe('BrowseDrawer integration (via LaunchpadApp)', () => {
  it('opens the paths drawer when the Paths button is clicked', () => {
    renderLaunchpad();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /8 paths/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('browse-drawer')).toHaveAttribute('data-mode', 'paths');
  });

  it('opens the formats drawer when the 2 Formats button is clicked', () => {
    renderLaunchpad();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /2 formats/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('browse-drawer')).toHaveAttribute('data-mode', 'formats');
  });

  it('keeps the drawer open and applies the category filter when a path card is clicked', () => {
    renderLaunchpad();

    fireEvent.click(screen.getByRole('button', { name: /8 paths/i }));
    const drawer = screen.getByRole('dialog');
    fireEvent.click(within(drawer).getByRole('button', { name: /Mindsets/i }));

    // Drawer stays open (multi-select)
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes the paths drawer via Done button after selecting a path', () => {
    renderLaunchpad();

    fireEvent.click(screen.getByRole('button', { name: /8 paths/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Mindsets/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Done/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the active category name in the header CTA after a path is selected and Done is clicked', () => {
    renderLaunchpad();

    fireEvent.click(screen.getByRole('button', { name: /8 paths/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Mindsets/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Done/i }));

    // The CTA should now show the active filter name, not the default paths count.
    expect(screen.queryByRole('button', { name: /8 paths/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mindsets/i })).toBeInTheDocument();
  });

  it('selects two paths and shows count in the header CTA', () => {
    renderLaunchpad();

    fireEvent.click(screen.getByRole('button', { name: /8 paths/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Mindsets/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Life Skills/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Done/i }));

    expect(screen.getByRole('button', { name: /2 paths/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /8 paths/i })).not.toBeInTheDocument();
  });

  it('toggles a path off when clicked twice', () => {
    renderLaunchpad();

    fireEvent.click(screen.getByRole('button', { name: /8 paths/i }));
    const drawer = screen.getByRole('dialog');
    fireEvent.click(within(drawer).getByRole('button', { name: /Mindsets/i }));
    // Click again to deselect
    fireEvent.click(within(drawer).getByRole('button', { name: /Mindsets/i }));
    fireEvent.click(within(drawer).getByRole('button', { name: /Done/i }));

    // Back to unfiltered count
    expect(screen.getByRole('button', { name: /8 paths/i })).toBeInTheDocument();
  });

  it('clears all selected paths via the All Paths featured card', () => {
    renderLaunchpad();

    // Select Mindsets first
    fireEvent.click(screen.getByRole('button', { name: /8 paths/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Mindsets/i }));
    // Click All Paths to clear
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /All Paths/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Done/i }));

    expect(screen.getByRole('button', { name: /8 paths/i })).toBeInTheDocument();
  });

  it('shows the active format name in the header CTA after a format is selected', () => {
    renderLaunchpad();

    fireEvent.click(screen.getByRole('button', { name: /2 formats/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Videos/i }));

    // Formats drawer closes on tap (single-select preserved)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /2 formats/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /video/i })).toBeInTheDocument();
  });

  it('closes the drawer on Escape key', () => {
    renderLaunchpad();

    fireEvent.click(screen.getByRole('button', { name: /8 paths/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('isFeedOnboardingSeen', () => {
  const now = 1_700_000_000_000;
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  it('treats a missing or empty value as not seen', () => {
    expect(isFeedOnboardingSeen(null, now, null)).toBe(false);
    expect(isFeedOnboardingSeen('', now, null)).toBe(false);
  });

  it('treats any stored timestamp as seen when there is no TTL', () => {
    expect(isFeedOnboardingSeen(String(now - thirtyDays * 100), now, null)).toBe(true);
  });

  it('honours an unexpired TTL and expires an old timestamp', () => {
    expect(isFeedOnboardingSeen(String(now - 1000), now, thirtyDays)).toBe(true);
    expect(isFeedOnboardingSeen(String(now - thirtyDays - 1), now, thirtyDays)).toBe(false);
  });

  it('rejects corrupt, zero, and negative values', () => {
    expect(isFeedOnboardingSeen('garbage', now, null)).toBe(false);
    expect(isFeedOnboardingSeen('   ', now, null)).toBe(false);
    expect(isFeedOnboardingSeen('0', now, null)).toBe(false);
    expect(isFeedOnboardingSeen('-1', now, null)).toBe(false);
    expect(isFeedOnboardingSeen('Infinity', now, null)).toBe(false);
  });

  it('treats a future timestamp as seen so a clock rollback cannot resurrect the hint', () => {
    expect(isFeedOnboardingSeen(String(now + thirtyDays), now, null)).toBe(true);
    expect(isFeedOnboardingSeen(String(now + thirtyDays), now, thirtyDays)).toBe(true);
  });
});
