import type { CrmClient } from './api';
import { currentLanguage } from './i18n';
export interface LeadMagnetRow {artist_id:string;artist_name:string;slug:string;version:string;active:boolean;recipients:number;requests:number;opted_in:number;delivered:number;delivery_attention:number;matched_enquiries:number;sources:{source:string;campaign:string;requests:number}[]}
export function createLeadMagnetsApi(client:CrmClient) {
  return {async loadLeadMagnets(artistId:string|null):Promise<LeadMagnetRow[]> {
    const {data,error}=await client.rpc('get_lead_magnet_summary',{p_artist_id:artistId});
    if(error||!Array.isArray(data?.magnets))throw new Error(currentLanguage()==='ru'?'Не удалось загрузить лид-магниты.':'Could not load lead magnets.');
    return data.magnets as LeadMagnetRow[];
  }};
}
export type LeadMagnetsApi=ReturnType<typeof createLeadMagnetsApi>;
