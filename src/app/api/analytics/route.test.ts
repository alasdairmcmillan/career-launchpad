import { afterEach, describe, expect, it, vi } from 'vitest';

const { fromMock, insertMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  insertMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseServerClient: () => ({
    from: fromMock,
  }),
}));

import { POST } from './route';

const URL = 'http://localhost/api/analytics';

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'clp_evt_test',
    eventType: 'content_open',
    eventVersion: 1,
    visitorId: 'clp_visitor_test',
    sessionId: 'clp_session_test',
    timestamp: '2026-06-11T12:00:00.000Z',
    contentId: 'video-1',
    metadata: { source: 'feed' },
    context: {
      deviceType: 'desktop',
      pagePath: '/',
      referrerHost: 'example.com',
      utmSource: 'newsletter',
      utmCampaign: 'launch',
    },
    ...overrides,
  };
}

function analyticsRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const VERCEL_GEO_HEADERS = {
  'x-vercel-ip-country': 'CA',
  'x-vercel-ip-country-region': 'ON',
};

describe('POST /api/analytics', () => {
  afterEach(() => {
    fromMock.mockReset();
    insertMock.mockReset();
  });

  it('inserts a valid analytics event batch', async () => {
    fromMock.mockReturnValue({ insert: insertMock });
    insertMock.mockResolvedValue({ error: null });

    const res = await POST(analyticsRequest({ events: [validEvent()] }));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, accepted: 1 });
    expect(fromMock).toHaveBeenCalledWith('analytics_events');
    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({
        event_id: 'clp_evt_test',
        event_type: 'content_open',
        event_version: 1,
        visitor_id: 'clp_visitor_test',
        session_id: 'clp_session_test',
        content_id: 'video-1',
        occurred_at: '2026-06-11T12:00:00.000Z',
        device_type: 'desktop',
        page_path: '/',
        referrer_host: 'example.com',
        utm_source: 'newsletter',
        utm_campaign: 'launch',
        metadata: { source: 'feed' },
      }),
    ]);
  });

  it('stores country and region from Vercel geolocation headers on every event in the batch', async () => {
    fromMock.mockReturnValue({ insert: insertMock });
    insertMock.mockResolvedValue({ error: null });

    await POST(
      analyticsRequest(
        { events: [validEvent(), validEvent({ eventId: 'clp_evt_second' })] },
        VERCEL_GEO_HEADERS
      )
    );

    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({ event_id: 'clp_evt_test', geo_country: 'CA', geo_region: 'ON' }),
      expect.objectContaining({ event_id: 'clp_evt_second', geo_country: 'CA', geo_region: 'ON' }),
    ]);
  });

  it('stores null geo when Vercel geolocation headers are absent', async () => {
    fromMock.mockReturnValue({ insert: insertMock });
    insertMock.mockResolvedValue({ error: null });

    await POST(analyticsRequest({ events: [validEvent()] }));

    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({ geo_country: null, geo_region: null }),
    ]);
  });

  it('stores null geo when the header values are not ISO codes', async () => {
    fromMock.mockReturnValue({ insert: insertMock });
    insertMock.mockResolvedValue({ error: null });

    await POST(
      analyticsRequest(
        { events: [validEvent()] },
        { 'x-vercel-ip-country': 'Canada', 'x-vercel-ip-country-region': 'Ontario' }
      )
    );

    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({ geo_country: null, geo_region: null }),
    ]);
  });

  it('drops the region when the country is missing', async () => {
    fromMock.mockReturnValue({ insert: insertMock });
    insertMock.mockResolvedValue({ error: null });

    await POST(analyticsRequest({ events: [validEvent()] }, { 'x-vercel-ip-country-region': 'ON' }));

    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({ geo_country: null, geo_region: null }),
    ]);
  });

  it('ignores geo claimed in the event payload', async () => {
    fromMock.mockReturnValue({ insert: insertMock });
    insertMock.mockResolvedValue({ error: null });

    const spoofed = validEvent({
      geoCountry: 'US',
      geoRegion: 'CA',
      context: { deviceType: 'desktop', pagePath: '/', geoCountry: 'US', geoRegion: 'CA' },
    });
    await POST(analyticsRequest({ events: [spoofed] }, VERCEL_GEO_HEADERS));

    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({ geo_country: 'CA', geo_region: 'ON' }),
    ]);
  });

  it('rejects an unknown analytics event type', async () => {
    const res = await POST(analyticsRequest({ events: [validEvent({ eventType: 'made_up_event' })] }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_event' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects oversized metadata', async () => {
    const res = await POST(
      analyticsRequest({
        events: [validEvent({ metadata: { value: 'x'.repeat(5000) } })],
      })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_event' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('returns a generic error when Supabase insert fails', async () => {
    fromMock.mockReturnValue({ insert: insertMock });
    insertMock.mockResolvedValue({ error: { message: 'table unavailable' } });

    const res = await POST(analyticsRequest({ events: [validEvent()] }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'analytics_insert_failed' });
  });
});
