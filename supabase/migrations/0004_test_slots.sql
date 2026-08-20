-- ============================================================
-- 0004_test_slots.sql
-- Generate 30-minute bookable slots for the next 14 days.
-- Each doctor is paired with their primary service specialization.
-- Slot times are in Asia/Manila (UTC+8).
--
-- Run once after 0003. Safe to re-run (ON CONFLICT DO NOTHING).
-- ============================================================
do $$
declare
  r             record;
  v_slot_date   date;
  v_dow         int;
  v_end_time    time;
  v_slot_time   time;
  v_slot_ts     timestamptz;
begin
  for r in (
    select prov.id as provider_id, s.id as service_id
    from public.providers prov
    join public.profiles prof on prof.id = prov.profile_id
    join public.services s on (
         (prof.email = 'doctor@demo.mho'  and s.name = 'General Check-up')
      or (prof.email = 'doctor2@demo.mho' and s.name = 'Immunization')
      or (prof.email = 'doctor3@demo.mho' and s.name = 'Prenatal')
      or (prof.email = 'dentist@demo.mho' and s.name = 'Dental')
    )
  ) loop
    for v_slot_date in
      select gs::date
      from generate_series(current_date + 1, current_date + 14, '1 day'::interval) gs
    loop
      v_dow := extract(dow from v_slot_date);

      -- Skip Sundays (0) for doctors; nurses handle Sunday walk-ins
      continue when v_dow = 0;

      -- Saturday ends at 15:00 (last slot 14:30); weekday ends at 16:00 (last 15:30)
      v_end_time := case when v_dow = 6 then '14:30'::time else '15:30'::time end;

      v_slot_time := '08:00'::time;
      while v_slot_time <= v_end_time loop
        -- Store as UTC; UI displays in Asia/Manila via toLocaleString
        v_slot_ts := (v_slot_date::text || ' ' || v_slot_time::text || '+08')::timestamptz;

        insert into public.time_slots (provider_id, service_id, slot_datetime)
        values (r.provider_id, r.service_id, v_slot_ts)
        on conflict (provider_id, slot_datetime) do nothing;

        v_slot_time := v_slot_time + interval '30 minutes';
      end loop;
    end loop;
  end loop;
end;
$$;
