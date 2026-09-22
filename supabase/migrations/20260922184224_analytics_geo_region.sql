-- Coarse, IP-derived location for Career LaunchPAD analytics.
-- /api/analytics fills these from Vercel's x-vercel-ip-country and
-- x-vercel-ip-country-region request headers. The IP address itself is never
-- read or stored. Events captured before this migration, and any captured
-- outside Vercel (local dev), have null location.
--
-- Apply this BEFORE deploying the route change: the route inserts these
-- columns, and inserts fail until they exist.

alter table public.analytics_events
  add column if not exists geo_country text,
  add column if not exists geo_region text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'analytics_events_geo_country_check'
      and conrelid = 'public.analytics_events'::regclass
  ) then
    alter table public.analytics_events
      add constraint analytics_events_geo_country_check
      check (geo_country ~ '^[A-Z]{2}$');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'analytics_events_geo_region_check'
      and conrelid = 'public.analytics_events'::regclass
  ) then
    alter table public.analytics_events
      add constraint analytics_events_geo_region_check
      check (geo_region is null or (geo_region ~ '^[A-Z0-9]{1,3}$' and geo_country is not null));
  end if;
end $$;

-- analytics_content_engagement, additionally grouped by country and region.
create or replace view public.analytics_content_engagement_by_region
with (security_invoker = true)
as
select
  e.content_id,
  c.slug,
  c.title,
  c.content_type as format,
  e.occurred_at::date as report_date,
  e.geo_country,
  e.geo_region,
  count(distinct e.visitor_id) as visitor_count,
  count(distinct e.session_id) as session_count,
  count(*) filter (where e.event_type = 'feed_impression') as feed_impressions,
  count(*) filter (where e.event_type = 'content_open') as content_opens,
  count(*) filter (where e.event_type = 'learn_more_open') as learn_more_opens,
  count(*) filter (where e.event_type = 'video_play') as video_plays,
  count(*) filter (where e.event_type = 'video_progress' and e.metadata->>'milestone' = '25') as video_progress_25,
  count(*) filter (where e.event_type = 'video_progress' and e.metadata->>'milestone' = '50') as video_progress_50,
  count(*) filter (where e.event_type = 'video_progress' and e.metadata->>'milestone' = '80') as video_progress_80,
  count(*) filter (where e.event_type = 'video_complete') as video_completes,
  count(*) filter (where e.event_type = 'like' and coalesce(e.metadata->>'liked', 'true') = 'true') as likes,
  count(*) filter (where e.event_type = 'share') as shares,
  count(*) filter (where e.event_type = 'outbound_click') as outbound_clicks,
  count(*) filter (where e.event_type = 'related_content_click') as related_content_clicks,
  round(
    count(*) filter (where e.event_type = 'video_complete')::numeric
    / nullif(count(*) filter (where e.event_type = 'video_play'), 0),
    4
  ) as video_completion_rate
from public.analytics_events e
left join public.content c on c.id = e.content_id
where e.content_id is not null
group by e.content_id, c.slug, c.title, c.content_type, e.occurred_at::date, e.geo_country, e.geo_region;

revoke all on public.analytics_content_engagement_by_region from anon, authenticated;
