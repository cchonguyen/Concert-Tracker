-- Attendance: whether you went to an event you added before it happened
-- (LoggedEvent.attendance in src/server/events/types.ts, rules in
-- src/server/events/attendance.ts). 'planned': added ahead of time, not yet
-- confirmed; 'missed': you said you didn't go; null: you went (every event
-- logged after the fact). Stats, Artists and the Map count only null.
-- Apply this before deploying the code that writes it.

alter table logged_events add column if not exists attendance text check (attendance in ('planned', 'missed'));

-- Events already saved with a date still ahead become planned, so the app
-- asks whether you went once they are over instead of counting them.
update logged_events
set attendance = 'planned'
where attendance is null
  and (
    start_date > current_date
    or (start_date is null and month is not null and year is not null and make_date(year, month, 1) > current_date)
    or (start_date is null and month is null and year > extract(year from current_date))
  );
