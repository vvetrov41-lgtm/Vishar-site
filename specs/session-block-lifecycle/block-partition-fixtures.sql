-- Read-only model of calendar-day partitioning. Not production implementation.
-- NULL project sessions are intentionally isolated until their association is known.
with fixture(case_name,artist,client,project,session_id,day,status) as (
 values
 ('one','a','c','p','s1',date '2026-11-17','confirmed'),
 ('two','a','c','p','s1',date '2026-11-17','confirmed'),('two','a','c','p','s2',date '2026-11-18','confirmed'),
 ('three','a','c','p','s1',date '2026-11-17','completed'),('three','a','c','p','s2',date '2026-11-18','confirmed'),('three','a','c','p','s3',date '2026-11-19','confirmed'),
 ('gap','a','c','p','s1',date '2026-11-14','confirmed'),('gap','a','c','p','s2',date '2026-11-15','confirmed'),('gap','a','c','p','s3',date '2026-11-28','confirmed'),('gap','a','c','p','s4',date '2026-11-29','confirmed'),
 ('move','a','c','p','s1',date '2026-11-17','confirmed'),('move','a','c','p','s2',date '2026-11-20','confirmed'),
 ('cancel','a','c','p','s1',date '2026-11-17','confirmed'),('cancel','a','c','p','s2',date '2026-11-18','cancelled'),('cancel','a','c','p','s3',date '2026-11-19','confirmed'),
 ('isolation','a','c','p','s1',date '2026-11-17','confirmed'),('isolation','b','c','p','s2',date '2026-11-18','confirmed'),
 ('no_project','a','c',null,'s1',date '2026-11-17','confirmed'),('no_project','a','c',null,'s2',date '2026-11-18','confirmed'),
 ('same_day','a','c','p','s1',date '2026-11-17','confirmed'),('same_day','a','c','p','s2',date '2026-11-17','confirmed'),('same_day','a','c','p','s3',date '2026-11-18','confirmed')
), days as (
 select distinct case_name,artist,client,coalesce(project,'session:'||session_id) as group_project,day
 from fixture where status in ('confirmed','completed')
), ranked as (
 select *,day - row_number() over (partition by case_name,artist,client,group_project order by day)::int block_key from days
), blocks as (
 select case_name,artist,client,group_project,block_key,count(*)::int days,min(day) start_day
 from ranked group by case_name,artist,client,group_project,block_key
), observed as (
 select case_name,array_agg(days order by days) lengths from blocks group by case_name
), expected(case_name,lengths) as (
 values ('one',array[1]),('two',array[2]),('three',array[3]),('gap',array[2,2]),('move',array[1,1]),('cancel',array[1,1]),('isolation',array[1,1]),('no_project',array[1,1]),('same_day',array[2])
)
select e.case_name,e.lengths as expected,o.lengths as observed,(e.lengths=o.lengths) as passed
from expected e left join observed o using (case_name) order by case_name;
