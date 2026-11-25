import {render,screen,fireEvent} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {BodyZonePicker} from '../components/BodyZonePicker';
import {BODY_ZONE_GROUPS} from '../lib/body-zones';
it('offers every concrete public placement and all eight half sleeve variants',()=>{
 expect(BODY_ZONE_GROUPS.flatMap(g=>g.zones).length).toBe(48);
 const onChange=vi.fn();render(<BodyZonePicker label="Placement" value="Forearm" onChange={onChange} language="en"/>);
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'leg:half_leg_sleeve:inner'}});
 expect(onChange).toHaveBeenCalledWith('Forearm; Leg: Half leg sleeve · Inner side · full length');
});
