import { NextResponse } from 'next/server';

import { ANALYTICS_EVENT_TYPES, type AnalyticsDeviceType, type AnalyticsEventType } from '@/types';
import { getSupabaseServerClient } from '@/lib/supabase/server';

const VALID_EVENT_TYPES = new Set<AnalyticsEventType>(ANALYTICS_EVENT_TYPES);
const VALID_DEVICE_TYPES = new Set<AnalyticsDeviceType>(['desktop', 'tablet', 'mobile', 'unknown']);
const MAX_BATCH_SIZE = 20;
const MAX_METADATA_BYTES = 4096;
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;
const REGION_CODE_RE = /^[A-Z0-9]{1,3}$/;

type RequestGeo = {
  geo_country: string | null;
  geo_region: string | null;
};

type AnalyticsInsertRow = {
  event_id: string;
  event_type: AnalyticsEventType;
  event_version: 1;
  visitor_id: string;
  session_id: string;
  content_id: string | null;
  occurred_at: string;
  metadata: Record<string, unknown> | null;
  device_type: AnalyticsDeviceType;
  referrer_host: string | null;
  page_path: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
} & RequestGeo;

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!isPlainObject(body) || !Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_BATCH_SIZE) {
    return NextResponse.json({ ok: false, error: 'invalid_batch' }, { status: 400 });
  }

  const geo = requestGeo(request.headers);
  const rows: AnalyticsInsertRow[] = [];
  for (const event of body.events) {
    const row = toInsertRow(event, geo);
    if (!row) {
      return NextResponse.json({ ok: false, error: 'invalid_event' }, { status: 400 });
    }
    rows.push(row);
  }

  const supabase = getSupabaseServerClient();
  const { error } = await supabase.from('analytics_events').insert(rows);
  if (error) {
    return NextResponse.json({ ok: false, error: 'analytics_insert_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, accepted: rows.length }, { status: 202 });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// Coarse location from Vercel's edge geolocation headers. Absent in local dev.
// Taken from the request, never the payload, and the IP itself is not read.
function requestGeo(headers: Headers): RequestGeo {
  const country = headers.get('x-vercel-ip-country')?.trim() ?? '';
  if (!COUNTRY_CODE_RE.test(country)) return { geo_country: null, geo_region: null };

  const region = headers.get('x-vercel-ip-country-region')?.trim() ?? '';
  return { geo_country: country, geo_region: REGION_CODE_RE.test(region) ? region : null };
}

function toInsertRow(event: unknown, geo: RequestGeo): AnalyticsInsertRow | null {
  if (!isPlainObject(event)) return null;

  const eventId = safeString(event.eventId, 160);
  const eventType = typeof event.eventType === 'string' && VALID_EVENT_TYPES.has(event.eventType as AnalyticsEventType)
    ? (event.eventType as AnalyticsEventType)
    : null;
  const eventVersion = event.eventVersion === 1 ? 1 : null;
  const visitorId = safeString(event.visitorId, 160);
  const sessionId = safeString(event.sessionId, 160);
  const occurredAt = validTimestamp(event.timestamp);
  const contentId = optionalSafeString(event.contentId, 160);
  const metadata = validMetadata(event.metadata);
  const context = isPlainObject(event.context) ? event.context : {};
  const deviceType =
    typeof context.deviceType === 'string' && VALID_DEVICE_TYPES.has(context.deviceType as AnalyticsDeviceType)
      ? (context.deviceType as AnalyticsDeviceType)
      : 'unknown';
  const pagePath = safeText(context.pagePath, 500) ?? '/';

  if (!eventId || !eventType || !eventVersion || !visitorId || !sessionId || !occurredAt || metadata === false) {
    return null;
  }

  return {
    event_id: eventId,
    event_type: eventType,
    event_version: eventVersion,
    visitor_id: visitorId,
    session_id: sessionId,
    content_id: contentId,
    occurred_at: occurredAt,
    metadata,
    device_type: deviceType,
    referrer_host: safeText(context.referrerHost, 255),
    page_path: pagePath,
    utm_source: safeText(context.utmSource, 200),
    utm_medium: safeText(context.utmMedium, 200),
    utm_campaign: safeText(context.utmCampaign, 200),
    utm_content: safeText(context.utmContent, 200),
    utm_term: safeText(context.utmTerm, 200),
    ...geo,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || !SAFE_ID_RE.test(trimmed)) return null;
  return trimmed;
}

function optionalSafeString(value: unknown, maxLength: number): string | null {
  if (typeof value === 'undefined' || value === null || value === '') return null;
  return safeString(value, maxLength);
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function validTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return date.toISOString();
}

function validMetadata(value: unknown): Record<string, unknown> | null | false {
  if (typeof value === 'undefined' || value === null) return null;
  if (!isPlainObject(value)) return false;

  try {
    if (JSON.stringify(value).length > MAX_METADATA_BYTES) return false;
  } catch {
    return false;
  }

  return value;
}
