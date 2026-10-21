-- State: the state or province an event's city is in, kept apart from the
-- city ("Las Vegas" + "NV"). LoggedEvent.region in src/server/events/types.ts.
-- Existing cities written "City, ST" with a US or Canadian postal code are
-- split here, the same way splitCity in src/server/events/regions.ts does it,
-- and get their country when none is stored. Anything else stays as it was;
-- Fill gaps > State & country in the Table can look the rest up.
-- Apply this before deploying the code that writes it.

alter table logged_events add column if not exists region text;

with codes(code, country) as (
  values
    ('AL','United States'),('AK','United States'),('AZ','United States'),('AR','United States'),('CA','United States'),
    ('CO','United States'),('CT','United States'),('DE','United States'),('DC','United States'),('FL','United States'),
    ('GA','United States'),('HI','United States'),('ID','United States'),('IL','United States'),('IN','United States'),
    ('IA','United States'),('KS','United States'),('KY','United States'),('LA','United States'),('ME','United States'),
    ('MD','United States'),('MA','United States'),('MI','United States'),('MN','United States'),('MS','United States'),
    ('MO','United States'),('MT','United States'),('NE','United States'),('NV','United States'),('NH','United States'),
    ('NJ','United States'),('NM','United States'),('NY','United States'),('NC','United States'),('ND','United States'),
    ('OH','United States'),('OK','United States'),('OR','United States'),('PA','United States'),('PR','United States'),
    ('RI','United States'),('SC','United States'),('SD','United States'),('TN','United States'),('TX','United States'),
    ('UT','United States'),('VT','United States'),('VA','United States'),('WA','United States'),('WV','United States'),
    ('WI','United States'),('WY','United States'),
    ('AB','Canada'),('BC','Canada'),('MB','Canada'),('NB','Canada'),('NL','Canada'),('NS','Canada'),('ON','Canada'),
    ('PE','Canada'),('QC','Canada'),('SK','Canada')
),
split as (
  select e.id, trim(m[1]) as city, m[2] as code, c.country as code_country
  from logged_events e
  cross join lateral regexp_match(e.city, '^\s*([^,]*[^,\s])\s*,\s*([A-Z]{2})\s*$') as m
  join codes c on c.code = m[2]
  where e.region is null
    and (e.country is null or lower(e.country) in ('us', 'usa', 'united states', 'united states of america', 'ca', 'can', 'canada'))
)
update logged_events e
set
  city = s.city,
  region = s.code,
  country = coalesce(e.country, s.code_country),
  sources = e.sources
    || case when e.sources ? 'city' then jsonb_build_object('region', e.sources -> 'city') else '{}'::jsonb end
    || case when e.sources ? 'city' and e.country is null then jsonb_build_object('country', e.sources -> 'city') else '{}'::jsonb end
from split s
where e.id = s.id;
