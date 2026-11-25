begin;
select plan(5);
select is(crm_private.preserve_enquiry_calculator_metadata('{"areas":[],"styles":[],"calculator_estimate":{"project":{"areas":[]},"result":{"price":"original"}}}'::jsonb,'{"areas":[],"styles":[]}'::jsonb,'{}'::jsonb)->'calculator_estimate'->'result'->>'price','original','timing edit preserves original price');
select is(crm_private.preserve_enquiry_calculator_metadata('{"areas":[],"styles":[],"calculator_estimate":{"project":{"areas":[]}}}'::jsonb,'{"areas":[],"styles":["Colour"]}'::jsonb,'{}'::jsonb)->>'calculator_estimate_superseded','true','style change marks original stale');
select is(crm_private.clean_enquiry_calculator_selection('[{"region":"arm","placements":["half_sleeve"],"half":"outer","price":1}]','[{"region":"arm","placements":["half_sleeve"]}]'),'[{"region":"arm","placements":["half_sleeve"],"half":"outer"}]'::jsonb,'coverage persists without untrusted price');
select throws_ok($$select crm_private.clean_enquiry_calculator_selection('[{"region":"arm","placements":["half_sleeve"],"half":"bad"}]','[{"region":"arm","placements":["half_sleeve"]}]')$$,'22023','invalid calculator coverage','reject invalid enum');
select throws_ok($$select crm_private.clean_enquiry_calculator_selection('[{"region":"arm","placements":["full_sleeve"]}]','[{"region":"arm","placements":["half_sleeve"]}]')$$,'22023','calculator placement does not match project','reject mismatched placement');
select * from finish();
rollback;
