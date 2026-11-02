-- 1847_premium_full_day_boundary.sql
-- Exact threshold must not replace a cheaper hourly price with a premium day.
begin;
select no_plan();

select is(
  (select row(amount,currency,basis,source)::text from crm_private.session_value_estimate(4,null,null,110,650,5,'GBP')),
  '(440.00,GBP,hourly,artist)', 'Kristina four hours at 110 per hour');
select is(
  (select row(amount,currency,basis,source)::text from crm_private.session_value_estimate(5,null,null,110,650,5,'GBP')),
  '(550.00,GBP,hourly,artist)', 'Kristina exactly five hours at 110 per hour');
select is(
  (select row(amount,currency,basis,source)::text from crm_private.session_value_estimate(305.0/60,null,null,110,650,5,'GBP')),
  '(650.00,GBP,full_day,artist)', 'Kristina five hours and five minutes at day rate');
select is(
  (select row(amount,currency,basis,source)::text from crm_private.session_value_estimate(5,110,'GBP',110,650,5,'GBP')),
  '(550.00,GBP,hourly,project)', 'project standard rate keeps five-hour boundary');
select is(
  (select row(amount,currency,basis,source)::text from crm_private.session_value_estimate(5.25,110,'GBP',110,650,5,'GBP')),
  '(650.00,GBP,full_day,project)', 'project standard rate uses day after five hours');
select is(
  (select row(amount,currency,basis,source)::text from crm_private.session_value_estimate(7,null,null,140,980,7,'GBP')),
  '(980.00,GBP,full_day,artist)', 'Vladimir full day unchanged');
select is(
  (select row(amount,currency,basis,source)::text from crm_private.session_value_estimate(6.5,null,null,120,750,6.5,'GBP')),
  '(750.00,GBP,full_day,artist)', 'discounted full-day still starts at boundary');

select * from finish();
rollback;
