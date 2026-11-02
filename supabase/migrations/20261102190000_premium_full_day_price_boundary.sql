-- Keep hourly billing through the exact full-day boundary when that day's
-- fixed rate is higher than the equivalent hourly charge. For Kristina's
-- £110/hour / £650/day after five hours: 5h = £550, 5h05 = £650.
-- Discounted/equal day rates still start at the configured boundary.
-- No privileges, session prices, deposits, or artist ownership are changed.

create or replace function crm_private.session_value_estimate(
  p_hours numeric,
  p_project_hourly_rate numeric,
  p_project_currency text,
  p_artist_hourly_rate numeric,
  p_artist_full_day_rate numeric,
  p_artist_full_day_hours numeric,
  p_artist_currency text
)
returns table (amount numeric, currency text, basis text, source text)
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_full_day boolean := p_artist_full_day_rate is not null and p_artist_full_day_hours is not null;
  v_artist boolean := p_artist_currency is not null;
begin
  if p_hours is null or p_hours <= 0 then
    return;
  end if;

  -- A project's own hourly rate first. When it equals the artist's standard
  -- rate and the artist has an explicit day price, a session at least a day
  -- long is that day price; a different project rate is never capped.
  if p_project_hourly_rate is not null and p_project_hourly_rate > 0 then
    if v_full_day and p_artist_hourly_rate = p_project_hourly_rate
       and (
         p_hours > p_artist_full_day_hours
         or (
           p_hours = p_artist_full_day_hours
           and (
             p_artist_hourly_rate is null
             or p_artist_full_day_rate <= p_artist_hourly_rate * p_hours
           )
         )
       ) then
      return query select round(p_artist_full_day_rate, 2),
        upper(coalesce(p_project_currency, p_artist_currency, 'GBP')), 'full_day'::text, 'project'::text;
    else
      return query select round(p_project_hourly_rate * p_hours, 2),
        upper(coalesce(p_project_currency, p_artist_currency, 'GBP')), 'hourly'::text, 'project'::text;
    end if;
    return;
  end if;

  if not v_artist then
    return;
  end if;
  if v_full_day and (
         p_hours > p_artist_full_day_hours
         or (
           p_hours = p_artist_full_day_hours
           and (
             p_artist_hourly_rate is null
             or p_artist_full_day_rate <= p_artist_hourly_rate * p_hours
           )
         )
       ) then
    return query select round(p_artist_full_day_rate, 2), upper(p_artist_currency), 'full_day'::text, 'artist'::text;
  elsif p_artist_hourly_rate is not null then
    return query select round(p_artist_hourly_rate * p_hours, 2), upper(p_artist_currency), 'hourly'::text, 'artist'::text;
  end if;
end;
$$;
