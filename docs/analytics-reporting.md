# Career LaunchPAD Analytics Reporting

Career LaunchPAD product analytics are stored in `public.analytics_events`.
Events are anonymous: they use generated visitor/session ids and do not store
student identity, IP address, user agent, school, or board.

Each event does carry a coarse location — `geo_country` (ISO 3166-1, e.g. `CA`)
and `geo_region` (the ISO 3166-2 subdivision, e.g. `ON`) — which
`/api/analytics` reads from Vercel's `x-vercel-ip-country` and
`x-vercel-ip-country-region` request headers. The IP itself is never read or
stored.

## Event Capture

- Visitor/session events: `session_start`, `entry_view`, `feed_impression`.
- Content events: `content_open`, `learn_more_open`, `like`, `share`, `outbound_click`, `related_content_click`.
- Video events: `video_play`, `video_progress`, `video_pause`, `video_complete`, `video_audio_recovery`.
- Search events: `search_open`, `search_query`, `search_zero_results`, `search_result_click`.

Search query text is sanitized before capture: it is trimmed, lowercased,
truncated, and obvious email or phone-like values are redacted.

## Reporting Views

Raw events and reporting views are not public-readable. Use a privileged
Supabase SQL session or export job.

Visitors, sessions, and actions by day:

```sql
select *
from public.analytics_daily_traffic
order by report_date desc;
```

Top watched videos and content engagement:

```sql
select *
from public.analytics_content_engagement
where format = 'video'
order by video_plays desc, video_completes desc
limit 25;
```

Top search terms and zero-result terms:

```sql
select *
from public.analytics_search_terms
order by search_count desc, zero_result_count desc
limit 50;
```

Video views by province, across all dates:

```sql
select
  geo_country,
  geo_region,
  slug,
  title,
  sum(video_plays) as video_plays,
  sum(video_completes) as video_completes,
  round(sum(video_completes)::numeric / nullif(sum(video_plays), 0), 4) as video_completion_rate
from public.analytics_content_engagement_by_region
where format = 'video'
  and geo_country is not null
group by geo_country, geo_region, slug, title
order by geo_region, video_plays desc;
```

Location caveats:

- Location is null for events captured before 2026-09-22, and for any event
  captured outside Vercel (local `next dev` has no geolocation headers).
- It is IP-derived. Country and province are dependable; anything finer is not,
  because school boards often route all traffic through one central network
  exit, so a whole board can appear to be in one place.
- `visitor_count` and `session_count` are distinct counts per row. Summing them
  across dates or regions double-counts; sum the event counts instead.

Anonymous session paths:

```sql
select *
from public.analytics_session_paths
order by started_at desc
limit 100;
```

## Operational Notes

- `NEXT_PUBLIC_ANALYTICS_DISABLED=true` disables client capture.
- The browser keeps a local debug log of the last 200 events in
  `career-launchpad-events`.
- Failed network sends remain queued locally up to 100 events and retry later.
